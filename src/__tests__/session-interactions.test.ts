import './test-setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { encodeSessionAction, selectableSessions, decodeSessionAction } from '../lib/bridge/session-navigation.js';
import { handleSessionAction, routeSessionReply, sessionInteractionLockId } from '../lib/bridge/session-interactions.js';
import { rememberSessionMessage, sessionForMessage, savePendingMessage, getPendingMessage, navigationSecret } from '../lib/bridge/session-interaction-store.js';
import { _testOnly } from '../lib/bridge/bridge-manager.js';
import { FeishuAdapter } from '../lib/bridge/adapters/feishu-adapter.js';
import { deliverTextResponse } from '../lib/bridge/feedback-delivery.js';
import * as router from '../lib/bridge/channel-router.js';

function setup() {
  const store = new JsonFileStore(new Map()); const sent: any[] = [];
  initBridgeContext({ store, llm: { streamChat: () => new ReadableStream({ start(c) { c.close(); } }) }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
  const address = { channelType: 'feishu-test', chatId: crypto.randomUUID(), userId: 'u1' };
  const adapter: any = { provider: 'feishu', channelType: address.channelType, isAuthorized: () => true, send: async (m: any) => { sent.push(m); return { ok: true, messageId: crypto.randomUUID() }; } };
  const msg = (text = '继续修改', replyToMessageId?: string) => ({ address, messageId: crypto.randomUUID(), timestamp: Date.now(), text, replyToMessageId });
  const replays: any[] = [];
  const deps = { busy: () => false, command: async () => {}, replay: async (_a: any, m: any) => { replays.push(m); } };
  return { store, sent, address, adapter, msg, deps, replays };
}
describe('message-driven sessions', () => {
  for (const kind of ['im', 'mirror']) {
    it(`${kind} streaming result persists original session and renders actions even after binding changes`, async () => {
      const f = setup(); const original = f.store.createSession('原会话', '', '', '/tmp'); const later = f.store.createSession('后来切换', '', '', '/tmp');
      const a: any = new FeishuAdapter({ id: f.address.channelType, provider: 'feishu', alias: 'test', enabled: true, config: { appId: 'test', appSecret: 'test' } });
      let updated: any;
      a.restClient = { cardkit: { v1: { card: {
        create: async () => ({ data: { card_id: 'card-id' } }), settings: async () => ({}), update: async (r: any) => { updated = JSON.parse(r.data.card.data); return {}; },
      } } }, im: { message: { create: async () => ({ data: { message_id: `${kind}-result` } }) } } };
      const streamKey = `${kind}:${original.id}:turn`;
      assert.equal(await a.createStreamingCard(f.address.chatId, undefined, streamKey), true);
      router.bindToSession(f.address, later.id);
      assert.equal(await a.finalizeCard(f.address.chatId, 'completed', '完成', streamKey), true);
      assert.equal(sessionForMessage(f.address, `${kind}-result`), original.id);
      assert.match(JSON.stringify(updated), /绑定此会话/); assert.match(JSON.stringify(updated), /取消订阅/); assert.match(JSON.stringify(updated), /原会话/);
      const callback = updated.body.elements.flatMap((e: any) => e.columns || []).flatMap((c: any) => c.elements || []).find((b: any) => b.text?.content === '绑定此会话').value.callback_data;
      assert.equal((decodeSessionAction(callback, f.address) as any).sessionId, original.id);
    });
  }
  it('Feishu receive adapter carries native reply parent and root into routing', async () => {
    const f = setup(); const a: any = new FeishuAdapter({ id: f.address.channelType, provider: 'feishu', alias: 'test', enabled: true, config: { appId: 'test', appSecret: 'test' } });
    const received: any[] = []; a.isAuthorized = () => true; a.enqueueInboundMessage = (m: any) => received.push(m);
    await a.handleIncomingEvent({ sender: { sender_type: 'user', sender_id: { open_id: 'u1' } }, message: { message_id: 'quoted-input', parent_id: 'parent-result', root_id: 'root-result', chat_id: f.address.chatId, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '继续' }), create_time: String(Date.now()) } });
    assert.equal(received[0].replyToMessageId, 'parent-result'); assert.equal(received[0].rootMessageId, 'root-result');
  });
  it('new-session selection uses real command and manager replay to invoke model once', async () => {
    const f = setup(); let calls = 0;
    initBridgeContext({ store: f.store, llm: { streamChat: () => { calls++; return new ReadableStream({ start(c) { c.close(); } }); } }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
    const m = f.msg(); await _testOnly.handleMessage(f.adapter, m);
    const button = f.sent.flatMap(s => s.inlineButtons?.flat() || []).find(b => b.text === '新建会话');
    const click = { ...f.msg(''), callbackData: button.callbackData };
    await _testOnly.handleMessage(f.adapter, click); await _testOnly.handleMessage(f.adapter, click);
    assert.equal(calls, 1); assert.equal(getPendingMessage(f.address, m.messageId)?.status, 'done');
  });

  it('persists message associations and rejects cross-chat and cross-channel references', () => {
    const f = setup(); const s = f.store.createSession('A', '', '', '/tmp');
    f.store.insertOutboundRef({ channelType: f.address.channelType, chatId: f.address.chatId, codepilotSessionId: s.id, platformMessageId: 'card', purpose: 'response' });
    assert.equal(sessionForMessage(f.address, 'card'), s.id);
    assert.equal(sessionForMessage({ ...f.address, chatId: 'another' }, 'card'), null);
    assert.equal(sessionForMessage({ ...f.address, channelType: 'another' }, 'card'), null);
    assert.deepEqual(navigationSecret(), navigationSecret());
  });
  it('replying to A automatically replaces current B and uses A for the processing lock', async () => {
    const f = setup(); const a = f.store.createSession('A', '', '', '/tmp'); const b = f.store.createSession('B', '', '', '/tmp');
    router.bindToSession(f.address, b.id); rememberSessionMessage(f.address, 'result-A', a.id);
    const m = f.msg('再加测试', 'result-A');
    assert.equal(sessionInteractionLockId(m), a.id);
    assert.equal(await routeSessionReply(f.adapter, m, f.deps), true);
    assert.equal(f.store.getChannelBinding(f.address.channelType, f.address.chatId)?.codepilotSessionId, a.id);
  });
  it('explicit same-session selection confirms without binding write or model execution', async () => {
    const f=setup();const a=f.store.createSession('当前会话','','','/tmp');router.bindToSession(f.address,a.id);
    const original=f.store.getChannelBinding(f.address.channelType,f.address.chatId);
    await handleSessionAction(f.adapter,{...f.msg(''),callbackData:encodeSessionAction(f.address,{kind:'resume',sessionId:a.id})},f.deps);
    assert.match(f.sent.at(-1).text,/当前已是「当前会话」/);assert.match(f.sent.at(-1).text,/不会启动任务/);
    assert.deepEqual(f.store.getChannelBinding(f.address.channelType,f.address.chatId),original);assert.equal(f.replays.length,0);
  });
  it('explicit selection confirms changed target; same-session quoted replies remain quiet', async () => {
    const f=setup();const a=f.store.createSession('A','','','/tmp');const b=f.store.createSession('B','','','/tmp');router.bindToSession(f.address,b.id);
    await handleSessionAction(f.adapter,{...f.msg(''),callbackData:encodeSessionAction(f.address,{kind:'resume',sessionId:a.id})},f.deps);
    assert.match(f.sent.at(-1).text,/已切换到「A」/);assert.equal(f.replays.length,0);
    rememberSessionMessage(f.address,'card-A',a.id);const count=f.sent.length;
    assert.equal(await routeSessionReply(f.adapter,f.msg('继续','card-A'),f.deps),true);assert.equal(f.sent.length,count);
  });
  it('Feishu action acknowledgement does not claim selection succeeded', async () => {
    const f=setup();const a:any=new FeishuAdapter({id:f.address.channelType,provider:'feishu',alias:'test',enabled:true,config:{appId:'test',appSecret:'test'}});
    a.isAuthorized=()=>true;const queued:any[]=[];a.enqueueInboundMessage=(m:any)=>queued.push(m);
    const s=f.store.createSession('A','','','/tmp');
    const result=await a.handleCardAction({action:{value:{callback_data:encodeSessionAction(f.address,{kind:'resume',sessionId:s.id})}},context:{open_chat_id:f.address.chatId,open_message_id:'result'},operator:{open_id:'u1'}});
    assert.match(result.toast.content,/请求已收到/);assert.doesNotMatch(result.toast.content,/正在处理|已切换/);assert.equal(queued.length,1);
  });
  it('unknown/deleted replied sessions preserve input instead of executing in current session', async () => {
    const f = setup(); const b = f.store.createSession('B', '', '', '/tmp'); router.bindToSession(f.address, b.id);
    const m = f.msg('不能发错', 'unknown');
    assert.equal(await routeSessionReply(f.adapter, m, f.deps), false);
    assert.equal(f.store.getChannelBinding(f.address.channelType, f.address.chatId)?.codepilotSessionId, b.id);
    assert.equal(getPendingMessage(f.address, m.messageId)?.message.text, m.text);
    assert.equal(f.replays.length, 0);
  });
  it('selecting a session replays preserved text and attachment exactly once even with concurrent clicks', async () => {
    const f = setup(); const s = f.store.createSession('选中的会话', '', '', '/tmp');
    const m = { ...f.msg(), attachments: [{ id: 'a', name: 'a.txt', type: 'text/plain', size: 1, data: 'YQ==' }] };
    const pendingId = savePendingMessage(m);
    const click = { ...f.msg(''), callbackData: encodeSessionAction(f.address, { kind: 'resume', sessionId: s.id, pendingId }) };
    await Promise.all([handleSessionAction(f.adapter, click, f.deps), handleSessionAction(f.adapter, click, f.deps)]);
    assert.equal(f.replays.length, 1); assert.ok(f.sent.some(s=>/之前保留的消息将继续执行/.test(s.text))); assert.equal(f.replays[0].text, m.text); assert.deepEqual(f.replays[0].attachments, m.attachments);
    assert.equal(getPendingMessage(f.address, pendingId)?.status, 'done');
    await handleSessionAction(f.adapter, click, f.deps); assert.equal(f.replays.length, 1);
  });
  it('another user cannot consume the pending message', async () => {
    const f = setup(); const s = f.store.createSession('A', '', '', '/tmp'); const pendingId = savePendingMessage(f.msg());
    const click = { ...f.msg(''), address: { ...f.address, userId: 'u2' }, callbackData: encodeSessionAction(f.address, { kind: 'resume', sessionId: s.id, pendingId }) };
    await handleSessionAction(f.adapter, click, f.deps); assert.equal(f.replays.length, 0);
    assert.equal(f.store.getChannelBinding(f.address.channelType, f.address.chatId), null);
  });
  it('busy current session prevents switching while preserving the pending task', async () => {
    const f = setup(); const a = f.store.createSession('A', '', '', '/tmp'); const b = f.store.createSession('B', '', '', '/tmp'); router.bindToSession(f.address, b.id);
    const pendingId = savePendingMessage(f.msg());
    await handleSessionAction(f.adapter, { ...f.msg(''), callbackData: encodeSessionAction(f.address, { kind: 'resume', sessionId: a.id, pendingId }) }, { ...f.deps, busy: () => true });
    assert.equal(getPendingMessage(f.address, pendingId)?.status, 'waiting'); assert.equal(f.replays.length, 0);
    assert.equal(f.store.getChannelBinding(f.address.channelType, f.address.chatId)?.codepilotSessionId, b.id);
  });
  it('ambiguous execution failure is retained and never auto-replayed', async () => {
    const f = setup(); const s = f.store.createSession('A', '', '', '/tmp'); const pendingId = savePendingMessage(f.msg());
    const click = { ...f.msg(''), callbackData: encodeSessionAction(f.address, { kind: 'resume', sessionId: s.id, pendingId }) };
    await assert.rejects(handleSessionAction(f.adapter, click, { ...f.deps, replay: async () => { throw new Error('lost execution receipt'); } }));
    assert.equal(getPendingMessage(f.address, pendingId)?.status, 'processing');
    await handleSessionAction(f.adapter, click, f.deps); assert.equal(f.replays.length, 0);
  });
  it('unbound real manager path offers a pending task rather than invoking model', async () => {
    const f = setup(); const m = f.msg(); await _testOnly.handleMessage(f.adapter, m);
    const button = f.sent.flatMap(s => s.inlineButtons?.flat() || []).find(b => b.text === '新建会话');
    const action = decodeSessionAction(button.callbackData, f.address);
    assert.equal(action?.pendingId, m.messageId); assert.equal(getPendingMessage(f.address, m.messageId)?.message.text, m.text);
  });
  it('Feishu menu label opens the session picker without starting a model turn', async () => {
    const f = setup(); let calls = 0;
    initBridgeContext({ store: f.store, llm: { streamChat: () => { calls++; return new ReadableStream(); } }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
    await _testOnly.handleMessage(f.adapter, f.msg('绑定其他会话'));
    assert.equal(calls, 0);
    assert.match(f.sent[0].text, /会话中心/);
    assert.equal(f.sent[0].sessionPicker?.recent, true);
  });
  it('normal fallback responses render both actions and persist their session', async () => {
    const f = setup(); const s = f.store.createSession('A', '', '', '/tmp');
    const result = await deliverTextResponse(f.adapter, f.address, '完成', s.id);
    assert.deepEqual(f.sent[0].inlineButtons.flat().map((b: any) => b.text), ['绑定此会话', '取消订阅']);
    assert.equal(sessionForMessage(f.address, result.messageId!), s.id);
  });
  it('includes formal IM sessions in recent activity order and excludes drafts', () => {
    const f = setup(); const old = f.store.createSession('older', '', '', '/tmp'); const recent = f.store.createSession('recent', '', '', '/tmp');
    const draft = f.store.createSession('draft', '', '', '/tmp', 'ask', { sessionType: 'draft', hidden: true });
    f.store.listSessions = () => [{ ...old, updated_at: '2025-01-01T00:00:00Z' }, { ...recent, updated_at: '2099-01-01T00:00:00Z' }, draft];
    const sessions = selectableSessions(); assert.equal(sessions[0].threadId, recent.id);
    assert.ok(sessions.find(s => s.threadId === old.id)); assert.ok(!sessions.find(s => s.threadId === draft.id));
  });
});

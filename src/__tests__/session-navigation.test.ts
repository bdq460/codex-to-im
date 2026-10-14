import './test-setup.js';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSessionPicker, encodeSessionAction, decodeSessionAction } from '../lib/bridge/session-navigation.js';
import { buildActionCard } from '../lib/bridge/markdown/action-card.js';
import { preferredCodexExecutable } from '../codex-executable.js';
import { inheritSystemProxy, parseMacSystemProxy } from '../network-proxy.js';
import { FeishuAdapter } from '../lib/bridge/adapters/feishu-adapter.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { _testOnly } from '../lib/bridge/bridge-manager.js';
import { listDesktopSessions } from '../desktop-sessions.js';

const address = { channelType: 'feishu-test', chatId: 'chat-1', userId: 'user-1' };
const id = '019d08ea-d078-7940-bafa-ae28ae13b3fc';
const proxyOutput = 'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897';
const deps = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };

describe('session navigation', () => {
  beforeEach(()=>initBridgeContext({store:new JsonFileStore(new Map()),llm:deps,permissions:{resolvePendingPermission:()=>false},lifecycle:{}}));
  it('scopes signed buttons to chat and channel, expiry and payload integrity', () => {
    const token = encodeSessionAction(address, { kind: 'enter', threadId: id }, 100);
    assert.deepEqual(decodeSessionAction(token, address, 101), { kind: 'enter', threadId: id });
    assert.equal(decodeSessionAction(token, { ...address, chatId: 'other' }, 101), null);
    assert.equal(decodeSessionAction(token, { ...address, channelType: 'other' }, 101), null);
    assert.equal(decodeSessionAction(token, address, 2_000_000), null);
    assert.equal(decodeSessionAction(token.replace('session:', 'session:x'), address, 101), null);
  });
  it('offers three recent sessions, new and full list without executing the input', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => ({ threadId: id, title: `会话${i}`, cwd: '/projects/app' }));
    const picker = buildSessionPicker(address, sessions, { unbound: true, recent: true, pendingId: 'queued-message' });
    assert.match(picker.text, /当前发送：未选择/);
    assert.match(picker.text, /原消息已保留/);
    assert.equal(picker.inlineButtons.flat().filter(b => b.text === '在此会话继续原消息').length, 3);
    assert.ok(picker.inlineButtons.flat().some(b => b.text === '全部会话'));
    const next = buildSessionPicker(address, sessions, { offset: 6 });
    assert.equal(next.inlineButtons.flat().filter(b => b.text === '设为当前').length, 3);
    assert.ok(next.inlineButtons.flat().some(b => b.text === '上一页'));
    assert.ok(!next.inlineButtons.flat().some(b => b.text === '下一页'));
    const card = JSON.parse(buildActionCard(picker.text, picker.inlineButtons, address.chatId));
    assert.equal(card.schema, '2.0');
    assert.ok(card.body.elements.some((e: any) => e.columns?.[0]?.elements?.[0]?.value?.callback_data.startsWith('session:')));
  });
  it('uses current desktop database even when legacy workspace roots are stale', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-nav-'));
    const old = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      fs.mkdirSync(path.join(home, 'sessions'));
      const rollout = path.join(home, 'sessions', `rollout-${id}.jsonl`);
      fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/projects/current', originator: 'Codex Desktop', source: 'vscode' } }) + '\n');
      fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'electron-saved-workspace-roots': ['/old/project'] }));
      const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
      db.exec('CREATE TABLE threads(id TEXT,updated_at INTEGER,archived INTEGER,source TEXT,rollout_path TEXT,title TEXT,cwd TEXT)');
      db.prepare('INSERT INTO threads VALUES(?, ?, 0, ?, ?, ?, ?)').run(id, Math.floor(Date.now()/1000), 'vscode', rollout, 'current', '/projects/current');
      db.close();
      assert.equal(listDesktopSessions()[0]?.threadId, id);
    } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('rejects unauthorized card actions and deduplicates callback tokens without dropping distinct clicks', async () => {
    const adapter: any = new FeishuAdapter({ id: address.channelType, provider: 'feishu', alias: 'test', enabled: true, config: { appId: 'test', appSecret: 'test' } });
    const received: any[] = [];
    adapter.enqueueInboundMessage = (m: any) => received.push(m);
    const data = { action: { value: { callback_data: encodeSessionAction(address, { kind: 'enter', threadId: id }) } }, context: { open_chat_id: 'chat-1', open_message_id: 'card-1' }, operator: { open_id: 'user-1' }, token: 'event-1' };
    adapter.isAuthorized = () => false;
    assert.equal((await adapter.handleCardAction(data)).toast.type, 'error');
    assert.equal(received.length, 0);
    adapter.isAuthorized = () => true;
    await adapter.handleCardAction(data); await adapter.handleCardAction(data);
    await adapter.handleCardAction({ ...data, token: 'event-2' });
    assert.equal(received.length, 2);
    assert.notEqual(received[0].messageId, received[1].messageId);
  });
  it('sends real navigation buttons through the adapter rather than permission fallback', async () => {
    const adapter: any = new FeishuAdapter({ id: address.channelType, provider: 'feishu', alias: 'test', enabled: true, config: { appId: 'test', appSecret: 'test' } });
    const calls: any[] = [];
    adapter.restClient = { im: { message: { create: async (r: any) => { calls.push(r); return { data: { message_id: 'card-1' } }; } } } };
    const result = await adapter.send({ address, ...buildSessionPicker(address, [], { unbound: true }), parseMode: 'Markdown' });
    assert.equal(result.ok, true);
    const card = JSON.parse(calls[0].data.content);
    assert.ok(!JSON.stringify(card).includes('Allow'));
    assert.ok(JSON.stringify(card).includes('新建会话'));
  });
  it('button creates an explicit formal session and subsequent list/expired clicks leave it intact', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-nav-actions-'));
    const old = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
    try {
      const store = new JsonFileStore(new Map([['bridge_default_workspace_root', home]]));
      const sent: any[] = [];
      initBridgeContext({ store, llm: deps, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
      const a = { ...address, chatId: 'new-session-test' };
      const adapter: any = { channelType: address.channelType, provider: 'feishu', isAuthorized: () => true, send: async (m: any) => { sent.push(m); return { ok: true, messageId: 'notice-1' }; } };
      const click = (data: string) => _testOnly.handleMessage(adapter, { address: a, messageId: 'click-1', callbackMessageId: 'card-1', text: '', timestamp: Date.now(), callbackData: data });
      await click(encodeSessionAction(a, { kind: 'new' }));
      const binding = store.getChannelBinding(a.channelType, a.chatId)!;
      assert.ok(binding);
      assert.ok(binding.workingDirectory.startsWith(home));
      assert.notEqual(store.getSession(binding.codepilotSessionId)?.session_type, 'draft');
      assert.match(sent[0].text, /已新建会话/);
      await click(encodeSessionAction(a, { kind: 'list', offset: 0 }));
      assert.equal(store.getChannelBinding(a.channelType, a.chatId)?.codepilotSessionId, binding.codepilotSessionId);
      await click(encodeSessionAction(a, { kind: 'new' }, 1));
      assert.equal(store.getChannelBinding(a.channelType, a.chatId)?.codepilotSessionId, binding.codepilotSessionId);
      assert.ok(sent.some(m => m.text.includes('入口已失效')));
    } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; fs.rmSync(home, {recursive:true,force:true}); }
  });
  it('unbound inbound message replies immediately without model invocation or draft creation', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-nav-empty-'));
    const old = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
    try {
      const store = new JsonFileStore(new Map());
      let calls = 0; const sent: any[] = [];
      initBridgeContext({ store, llm: { streamChat() { calls++; return deps.streamChat(); } }, permissions: { resolvePendingPermission: () => false }, lifecycle: {} });
      const adapter: any = { channelType: address.channelType, provider: 'feishu', send: async (m: any) => { sent.push(m); return { ok: true, messageId: 'notice-1' }; } };
      await _testOnly.handleMessage(adapter, { address: { ...address, chatId: 'unbound-test' }, messageId: 'incoming-1', text: '帮我检查', timestamp: Date.now() });
      assert.equal(calls, 0); assert.equal(store.getChannelBinding(address.channelType, 'unbound-test'), null);
      assert.match(sent[0].text, /当前发送：未选择/);
      assert.ok(sent[0].inlineButtons.length);
    } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('macOS system proxy inheritance', () => {
  it('uses enabled system proxy, preserves explicit environment and bypasses local services', () => {
    assert.equal(parseMacSystemProxy(proxyOutput), 'http://127.0.0.1:7897');
    const env: NodeJS.ProcessEnv = {};
    assert.equal(inheritSystemProxy(env, 'darwin', () => proxyOutput), true);
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(inheritSystemProxy(env, 'darwin', () => { throw Error('must not read'); }), false);
    assert.equal(inheritSystemProxy({}, 'linux', () => proxyOutput), false);
    assert.equal(parseMacSystemProxy(proxyOutput.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), null);
  });
});

describe('Codex executable selection', () => {
  it('uses a matching Desktop CLI on macOS, explicit override first and SDK fallback elsewhere', () => {
    assert.equal(preferredCodexExecutable({}, 'darwin', p => p.includes('ChatGPT.app')), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
    assert.equal(preferredCodexExecutable({CTI_CODEX_EXECUTABLE:'/custom/codex'}, 'darwin', () => true), '/custom/codex');
    assert.throws(() => preferredCodexExecutable({CTI_CODEX_EXECUTABLE:'/missing'}, 'darwin', () => false), /existing executable/);
    assert.equal(preferredCodexExecutable({}, 'linux', () => true), undefined);
    assert.equal(preferredCodexExecutable({}, 'darwin', () => false), undefined);
  });
});

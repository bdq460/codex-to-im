import './test-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { initializeChatSubscriptions, listChatSubscriptions, notificationBindings, setNotificationSubscription, checkpointNotification } from '../lib/bridge/notification-subscriptions.js';
import { bindStoreToSession, removeBinding } from '../session-bindings.js';
import { buildSessionPicker, sessionResultButtons } from '../lib/bridge/session-navigation.js';
import { buildActionCard } from '../lib/bridge/markdown/action-card.js';
import { notificationStreamKey } from '../lib/bridge/mirror-feedback-controller.js';
import { deliverSubscribedResponse } from '../lib/bridge/subscribed-response-delivery.js';
import { FeishuAdapter } from '../lib/bridge/adapters/feishu-adapter.js';
function fixture() {
  const store=new JsonFileStore(new Map());
  const address={channelType:'feishu-test',chatId:crypto.randomUUID(),userId:'u'};
  initBridgeContext({store,llm:{streamChat:()=>new ReadableStream()},permissions:{resolvePendingPermission:()=>false},lifecycle:{}});
  const a=store.createSession('A','','','/tmp/a'),b=store.createSession('B','','','/tmp/b');
  store.upsertChannelBinding({channelType:address.channelType,chatId:address.chatId,chatUserId:'u',codepilotSessionId:a.id,workingDirectory:'/tmp/a',model:'',sdkSessionId:''});
  return {store,address,a,b};
}
test('read-only legacy fallback; changing send binding keeps the previous receive subscription',()=>{
  const f=fixture();const file=path.join(CTI_HOME,'data','notification-subscriptions.json');const before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  assert.equal(listChatSubscriptions(f.store,f.address)[0].sessionId,f.a.id);
  assert.equal(fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,before);
  bindStoreToSession(f.store,f.address.channelType,f.address.chatId,f.b.id);
  assert.deepEqual(listChatSubscriptions(f.store,f.address).map(s=>s.sessionId),[f.a.id]);
  assert.equal(f.store.getChannelBinding(f.address.channelType,f.address.chatId)?.codepilotSessionId,f.b.id);
});
test('explicit subscription is idempotent, scoped, survives unbinding and has independent cursors',()=>{
  const f=fixture();initializeChatSubscriptions(f.store,f.address);
  const other={...f.address,chatId:crypto.randomUUID()};
  setNotificationSubscription(f.store,f.address,f.b.id,true);setNotificationSubscription(f.store,f.address,f.b.id,true);
  setNotificationSubscription(f.store,other,f.b.id,true);
  const one=listChatSubscriptions(f.store,f.address).find(s=>s.sessionId===f.b.id)!;
  const two=listChatSubscriptions(f.store,other)[0];assert.notEqual(one.id,two.id);
  checkpointNotification(one.id,'2099-01-01T00:00:00Z');assert.equal(listChatSubscriptions(f.store,other)[0].lastDeliveredAt,undefined);
  f.store.deleteChannelBinding(f.store.getChannelBinding(f.address.channelType,f.address.chatId)!.id);
  assert.equal(notificationBindings(f.store).filter(b=>b.chatId===f.address.chatId).length,2);
  setNotificationSubscription(f.store,f.address,f.b.id,false);
  assert.equal(listChatSubscriptions(f.store,other).length,1);
});
test('current button is hidden; picker groups context with independent selection and subscription buttons',()=>{
  const f=fixture();assert.deepEqual(sessionResultButtons(f.address,f.a.id).flat().map(b=>b.text),['取消订阅','选择其它会话']);
  assert.ok(sessionResultButtons(f.address,f.b.id).flat().some(b=>b.text==='绑定此会话'));
  const picker=buildSessionPicker(f.address,[{threadId:f.a.id,sessionId:f.a.id,title:'A',cwd:'/tmp/a'},{threadId:f.b.id,sessionId:f.b.id,title:'B',cwd:'/tmp/b'}],{view:'all'});
  assert.match(picker.sections[0].text,/当前绑定会话/);assert.deepEqual(picker.sections[0].buttons.map(b=>b.text),['取消订阅']);
  assert.deepEqual(picker.sections[1].buttons.map(b=>b.text),['绑定此会话','取消订阅']);
  const card=JSON.parse(buildActionCard(picker.text,picker.navigationButtons,f.address.chatId,picker.sections));
  const elements=card.body.elements;assert.match(elements[1].content,/A/);assert.equal(elements[2].columns[0].elements[0].text.content,'取消订阅');
});
test('same-session notifications use separate card keys for each receiving chat',()=>{
  assert.notEqual(notificationStreamKey({chatId:'one'},'mirror:session:turn'),notificationStreamKey({chatId:'two'},'mirror:session:turn'));
});
test('IM final results fan out once per destination with artifacts; source and revoked recipients are excluded',async()=>{
  const f=fixture();initializeChatSubscriptions(f.store,f.address);
  const other={...f.address,chatId:crypto.randomUUID()},revoked={...f.address,chatId:crypto.randomUUID()};
  setNotificationSubscription(f.store,other,f.a.id,true);setNotificationSubscription(f.store,revoked,f.a.id,true);
  const calls:any[]=[];const attachments=[{kind:'file' as const,path:'/tmp/result.txt'}];
  await deliverSubscribedResponse(f.store,f.address,f.a.id,{text:'final',attachments,source:'sdk_result'},()=>({isAuthorized:(_u:string,chat:string)=>chat!==revoked.chatId}) as any,async(...args)=>{calls.push(args);return {ok:true};});
  assert.equal(calls.length,1);assert.equal(calls[0][1].chatId,other.chatId);assert.deepEqual(calls[0][5],attachments);assert.match(calls[0][2],/会话「A」/);
  assert.equal(f.store.getChannelBinding(f.address.channelType,f.address.chatId)?.codepilotSessionId,f.a.id);
});
test('final result buttons update after switching, including a recreated adapter after restart',async()=>{
  const f=fixture();const instance={id:f.address.channelType,provider:'feishu',alias:'test',enabled:true,config:{appId:'test',appSecret:'test'}};
  const first:any=new FeishuAdapter(instance);let sent:any;
  first.restClient={im:{message:{create:async(r:any)=>{sent=JSON.parse(r.data.content);return {data:{message_id:'cached-'+f.address.chatId}};}}}};
  await first.send({address:f.address,text:'result-A',parseMode:'Markdown',resultSessionId:f.a.id,inlineButtons:sessionResultButtons(f.address,f.a.id)});
  assert.doesNotMatch(JSON.stringify(sent),/绑定此会话/);
  bindStoreToSession(f.store,f.address.channelType,f.address.chatId,f.b.id);
  const restored:any=new FeishuAdapter(instance);const patches:any[]=[];
  restored.restClient={im:{message:{patch:async(r:any)=>{patches.push(JSON.parse(r.data.content));return {};}}}};
  await restored.refreshSessionCards(f.address);assert.match(JSON.stringify(patches),/绑定此会话/);
  bindStoreToSession(f.store,f.address.channelType,f.address.chatId,f.a.id);patches.length=0;
  await restored.refreshSessionCards(f.address);assert.doesNotMatch(JSON.stringify(patches),/绑定此会话/);
});
test('workbench reads without changing subscription state and edits receive settings without changing send target',async()=>{
  const {notificationPanelPayload,updateNotificationPanel}=await import('../ui-notification-subscriptions.js');
  const f=fixture();initializeChatSubscriptions(f.store,f.address);
  const file=path.join(CTI_HOME,'data','notification-subscriptions.json');const before=fs.readFileSync(file,'utf8');
  const payload=notificationPanelPayload(f.store,f.address.channelType);assert.ok(payload.chats.some(c=>c.chatId===f.address.chatId));assert.equal(fs.readFileSync(file,'utf8'),before);
  updateNotificationPanel(f.store,f.address.channelType,f.address.chatId,f.b.id,true);
  assert.equal(f.store.getChannelBinding(f.address.channelType,f.address.chatId)?.codepilotSessionId,f.a.id);
  assert.ok(listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===f.b.id));
  assert.throws(()=>updateNotificationPanel(f.store,f.address.channelType,'unknown-chat',f.b.id,true),/尚未建立/);
  updateNotificationPanel(f.store,f.address.channelType,f.address.chatId,f.b.id,false);assert.ok(!listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===f.b.id));
});

test('unbinding the initial legacy sending session freezes receive settings instead of removing notifications',()=>{
  const f=fixture();const binding=f.store.getChannelBinding(f.address.channelType,f.address.chatId)!;
  removeBinding(f.store,binding.id);
  assert.equal(f.store.getChannelBinding(f.address.channelType,f.address.chatId),null);
  assert.deepEqual(listChatSubscriptions(f.store,f.address).map(s=>s.sessionId),[f.a.id]);
});

test('picker views update the existing card instead of sending a new message; result cards open a separate picker',async()=>{
  const f=fixture();const adapter:any=new FeishuAdapter({id:f.address.channelType,provider:'feishu',alias:'test',enabled:true,config:{appId:'test',appSecret:'test'}});
  let creates=0,patches=0;
  adapter.restClient={im:{message:{create:async()=>{creates++;return {data:{message_id:'picker-'+f.address.chatId}};},patch:async()=>{patches++;return {code:0};}}}};
  const picker=buildSessionPicker(f.address,[],{view:'recent'});
  await adapter.send({address:f.address,text:picker.text,inlineButtons:picker.navigationButtons,sections:picker.sections,sessionPicker:{view:'recent'}});
  assert.equal(await adapter.updateSessionPicker(f.address,{view:'all'},'picker-'+f.address.chatId),true);
  assert.equal(creates,1);assert.equal(patches,1);
  assert.equal(await adapter.updateSessionPicker({...f.address,chatId:'other'},{view:'all'},'picker-'+f.address.chatId),false);
  assert.equal(await adapter.updateSessionPicker(f.address,{view:'all'},'unknown-result'),false);
});

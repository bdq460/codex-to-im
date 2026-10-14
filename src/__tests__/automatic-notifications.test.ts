import './test-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { syncAutomaticNotifications } from '../lib/bridge/automatic-notification-runtime.js';
import { listChatSubscriptions, notificationPolicy, setNotificationSubscription } from '../lib/bridge/notification-subscriptions.js';
function fixture(){
 const store=new JsonFileStore(new Map());const address={channelType:'feishu-auto',chatId:crypto.randomUUID(),userId:'user'};
 const current=store.createSession('current','','','/tmp');store.upsertChannelBinding({channelType:address.channelType,chatId:address.chatId,chatUserId:'user',codepilotSessionId:current.id,workingDirectory:'/tmp',model:''});
 return {store,address,current};
}
function desktop(threadId=crypto.randomUUID()){return {threadId,title:'desktop',cwd:'/tmp/desktop',lastEventAt:new Date().toISOString()} as any;}
test('existing and new desktop/IM sessions automatically join; unchanged reconciliation never writes or changes sending binding',()=>{
 const f=fixture(),first=desktop();syncAutomaticNotifications(f.store,[f.address],()=>[first]);
 const imported=f.store.findSessionBySdkSessionId(first.threadId)!;assert.ok(listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===imported.id));
 const next=desktop(),im=f.store.createSession('new IM','','','/tmp');syncAutomaticNotifications(f.store,[f.address],()=>[first,next]);
 const subscriptions=listChatSubscriptions(f.store,f.address);assert.ok(subscriptions.some(s=>s.sessionId===im.id));assert.ok(subscriptions.some(s=>s.sessionId===f.store.findSessionBySdkSessionId(next.threadId)!.id));
 const file=path.join(CTI_HOME,'data','notification-subscriptions.json');const before=fs.statSync(file).mtimeMs;
 syncAutomaticNotifications(f.store,[f.address],()=>[first,next]);assert.equal(fs.statSync(file).mtimeMs,before);
 assert.equal(f.store.getChannelBinding(f.address.channelType,f.address.chatId)?.codepilotSessionId,f.current.id);
});
test('cancelled subscription remains excluded across reconciliation; reopening starts from new time',()=>{
 const f=fixture(),d=desktop();syncAutomaticNotifications(f.store,[f.address],()=>[d]);const id=f.store.findSessionBySdkSessionId(d.threadId)!.id;
 setNotificationSubscription(f.store,f.address,id,false);syncAutomaticNotifications(f.store,[f.address],()=>[d]);assert.ok(!listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===id));assert.ok(notificationPolicy(f.address).excluded.includes(d.threadId));
 setNotificationSubscription(f.store,f.address,id,true);syncAutomaticNotifications(f.store,[f.address],()=>[d]);assert.ok(listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===id));assert.ok(!notificationPolicy(f.address).excluded.includes(d.threadId));
});
test('archived desktop targets leave notification set, restoration starts without historical replay',()=>{
 const f=fixture(),d=desktop();syncAutomaticNotifications(f.store,[f.address],()=>[d]);const id=f.store.findSessionBySdkSessionId(d.threadId)!.id;
 syncAutomaticNotifications(f.store,[f.address],()=>[],threadId=>threadId===d.threadId);assert.ok(!listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===id));
 syncAutomaticNotifications(f.store,[f.address],()=>[d]);const restored=listChatSubscriptions(f.store,f.address).find(s=>s.sessionId===id)!;assert.ok(restored.since);assert.equal(restored.lastDeliveredAt,undefined);
});
test('hidden drafts and children never become subscriptions, exclusions stay scoped to receiving conversation',()=>{
 const f=fixture();const draft=f.store.createSession('draft','','','/tmp','ask',{sessionType:'draft',hidden:true});const child=f.store.createSession('child','','','/tmp','code',{parentSessionId:f.current.id});
 const other={...f.address,chatId:crypto.randomUUID()};setNotificationSubscription(f.store,f.address,f.current.id,false);
 syncAutomaticNotifications(f.store,[f.address,other],()=>[]);
 assert.ok(!listChatSubscriptions(f.store,f.address).some(s=>[draft.id,child.id,f.current.id].includes(s.sessionId)));
 assert.ok(listChatSubscriptions(f.store,other).some(s=>s.sessionId===f.current.id));
});
test('exclusion survives deleting and reimporting the desktop session record',()=>{
 const f=fixture(),d=desktop();syncAutomaticNotifications(f.store,[f.address],()=>[d]);const id=f.store.findSessionBySdkSessionId(d.threadId)!.id;
 setNotificationSubscription(f.store,f.address,id,false);f.store.deleteSession(id);syncAutomaticNotifications(f.store,[f.address],()=>[d]);
 const recreated=f.store.findSessionBySdkSessionId(d.threadId)!;assert.notEqual(recreated.id,id);assert.ok(!listChatSubscriptions(f.store,f.address).some(s=>s.sessionId===recreated.id));
});

test('an existing SDK session discovered in Desktop becomes mirror-backed without duplicate session or binding changes',()=>{
 const f=fixture(),d=desktop();const existing=f.store.createSession('existing SDK','','','/tmp');f.store.updateSdkSessionId(existing.id,d.threadId);
 syncAutomaticNotifications(f.store,[f.address],()=>[d]);
 assert.equal(f.store.findSessionBySdkSessionId(d.threadId)?.id,existing.id);assert.equal(f.store.getSession(existing.id)?.desktop_thread_id,d.threadId);
 assert.equal(f.store.getChannelBinding(f.address.channelType,f.address.chatId)?.codepilotSessionId,f.current.id);
});

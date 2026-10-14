import './test-setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { registrationPresetUrl, compareFeishuConfiguration, inspectFeishuConfiguration, type FeishuAppProfile } from '../feishu-app-profile.js';
import { FEISHU_REFERENCE_PROFILE } from '../feishu-reference-profile.js';
const profile: FeishuAppProfile = { referenceVersion:'test',capturedAt:'today',scopes:{tenant:['im:message:send_as_bot','cardkit:card:write'],user:['docx:document:readonly']},events:['im.message.receive_v1'],callbacks:['card.action.trigger'],eventTransport:'websocket',callbackTransport:'websocket' };
const app = { online_version_id:'v1',event:{subscription_type:'websocket'},callback_info:{callback_type:'websocket',subscribed_callbacks:['card.action.trigger']} };
const version = {version:'1.0',ability:{bot:{}},scopes:[{scope:'im:message:send_as_bot',token_types:['tenant']},{scope:'cardkit:card:write',token_types:['tenant']},{scope:'docx:document:readonly',token_types:['user']}],event_infos:[{event_type:'im.message.receive_v1'}]};
const grants = version.scopes.map(s=>({scope_name:s.scope,scope_type:s.token_types[0],grant_status:1}));
describe('Feishu reference configuration',()=>{
 it('encodes exact identity scopes, events and callbacks with the official addon codec and create-only mode',()=>{
  const url=registrationPresetUrl(new URL('https://open.feishu.cn/page/launcher?user_code=x&clientID=old'), '我的机器人',profile);
  const decoded=JSON.parse(gunzipSync(Buffer.from(url.searchParams.get('addons')!,'base64url')).toString());
  assert.deepEqual(decoded,{preset:false,scopes:profile.scopes,events:{items:{tenant:profile.events}},callbacks:{items:profile.callbacks}});
  assert.equal(url.searchParams.get('createOnly'),'true');assert.equal(url.searchParams.has('clientID'),false);assert.equal(url.searchParams.get('name'),'我的机器人');
 });
 it('reference manifest preserves all 105 permissions and 12 events from the published reference',()=>{
  assert.equal(new Set([...FEISHU_REFERENCE_PROFILE.scopes.tenant,...FEISHU_REFERENCE_PROFILE.scopes.user]).size,105);
  assert.equal(FEISHU_REFERENCE_PROFILE.scopes.tenant.length+FEISHU_REFERENCE_PROFILE.scopes.user.length,115);
  assert.equal(FEISHU_REFERENCE_PROFILE.events.length,12);assert.deepEqual(FEISHU_REFERENCE_PROFILE.callbacks,['card.action.trigger']);
  assert.ok(FEISHU_REFERENCE_PROFILE.scopes.tenant.includes('cardkit:card:write'));assert.ok(FEISHU_REFERENCE_PROFILE.scopes.tenant.includes('im:message.reactions:write_only'));
 });
 it('declares readiness only with all published, authorized and transport checks confirmed',()=>{
  assert.equal(compareFeishuConfiguration(app,version,profile,grants).status,'ready');
  assert.equal(compareFeishuConfiguration({...app,event:undefined},version,profile,grants).status,'needs_confirmation');
  assert.equal(compareFeishuConfiguration(app,version,profile).status,'needs_confirmation');
 });
 it('does not confuse tenant permissions with user permissions or declaration with tenant grant',()=>{
  const changed={...version,scopes:version.scopes.map(s=>s.scope==='docx:document:readonly'?{...s,token_types:['tenant']}:s)};
  assert.deepEqual(compareFeishuConfiguration(app,changed,profile,grants).missingScopes,['user:docx:document:readonly']);
  const report=compareFeishuConfiguration(app,version,profile,grants.map(g=>({...g,grant_status:2})));
  assert.equal(report.status,'needs_configuration');assert.equal(report.ungrantedScopes?.length,3);
 });
 it('reports missing events/callbacks and wrong long-connection mode',()=>{
  const report=compareFeishuConfiguration({...app,callback_info:{callback_type:'webhook',subscribed_callbacks:[]}}, {...version,event_infos:[]},profile,grants);
  assert.equal(report.status,'needs_configuration');assert.deepEqual(report.missingCallbacks,['card.action.trigger']);assert.deepEqual(report.missingEvents,['im.message.receive_v1']);
 });
 it('does not call unpublished applications usable',()=>{const report=compareFeishuConfiguration({},null,profile);assert.equal(report.status,'needs_configuration');assert.ok(report.checks.some(c=>c.label==='已发布版本'&&c.status==='missing'));});
 it('read errors stay unverified and never reveal credentials',async()=>{
  const report=await inspectFeishuConfiguration({appId:'id',appSecret:'never-reveal'},async()=>{throw new Error('private provider payload');});
  assert.equal(report.status,'unverified');assert.ok(!JSON.stringify(report).includes('never-reveal'));assert.ok(!JSON.stringify(report).includes('private provider payload'));
 });
});

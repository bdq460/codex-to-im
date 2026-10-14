import './test-setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from '../config.js';
import { readFeishuTemplate, saveFeishuTemplate, normalizeFeishuTemplate } from '../feishu-template-store.js';
import { FeishuRegistration } from '../feishu-registration.js';
import { gunzipSync } from 'node:zlib';

test('default read is side effect free; saves reload and reject stale revisions', () => {
  const file=path.join(CTI_HOME,'template-test.json');
  const initial=readFeishuTemplate(file);assert.equal(fs.existsSync(file),false);
  const profile=structuredClone(initial.profile);profile.events.push('test.event_v1');profile.events.push('test.event_v1');
  const saved=saveFeishuTemplate(profile,initial.revision,file);
  assert.deepEqual(readFeishuTemplate(file),saved);assert.equal(saved.profile.events.filter(e=>e==='test.event_v1').length,1);
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  assert.throws(()=>saveFeishuTemplate(profile,initial.revision,file),/其他窗口/);
  assert.deepEqual(readFeishuTemplate(file),saved);
});
test('invalid template and deletion of core interactions cannot be persisted',()=>{
  const profile=readFeishuTemplate().profile;
  assert.throws(()=>normalizeFeishuTemplate({...profile,events:['<script>']}),/格式/);
  assert.throws(()=>normalizeFeishuTemplate({...profile,callbacks:[]}),/保留/);
  assert.throws(()=>normalizeFeishuTemplate({...profile,eventTransport:'webhook'}),/长连接/);
});
test('QR and verification use frozen template even if caller edits during creation',async()=>{
  const profile=readFeishuTemplate().profile;profile.events.push('custom.event_v1');
  let inspected:unknown;let saved=0;
  const registration=new FeishuRegistration(async(_site,action)=>{
    if(action==='begin')return {device_code:'device',verification_uri_complete:'https://accounts.feishu.cn/test'};
    if(action==='poll')return {client_id:'app',client_secret:'secret'};
    return {};
  },Date.now,async(_config,_fetch,snapshot)=>{inspected=snapshot;return {status:'unverified',message:'test',referenceVersion:'test',checks:[],missingScopes:[],missingEvents:[],missingCallbacks:[]};});
  const beginning=registration.begin({alias:'test',site:'feishu',profile,save:async()=>{saved++;}});
  profile.events.push('later.event_v1');
  const session=await beginning;
  const addon=JSON.parse(gunzipSync(Buffer.from(new URL(session.verificationUrl).searchParams.get('addons')!,'base64url')).toString());
  assert.ok(addon.events.items.tenant.includes('custom.event_v1'));assert.ok(!addon.events.items.tenant.includes('later.event_v1'));
  await registration.poll(session.id);assert.equal(saved,1);
  assert.deepEqual((inspected as typeof profile).events,addon.events.items.tenant);
});

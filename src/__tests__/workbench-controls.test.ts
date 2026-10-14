import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RUNTIME_CONTROL_SCRIPT } from '../ui-runtime-controls.js';
import { BridgeOperationController } from '../ui-operation.js';
import { isWeixinLoginCliEntrypoint } from '../weixin-login.js';
function browser(running: boolean) {
  const buttons: Record<string, any> = {};
  for (const id of ['startBridgeBtn','stopBridgeBtn','restartBridgeBtn','bridgeStatus','bridgeStatusMeta']) buttons[id] = { hidden: false, disabled: false, textContent: '' };
  const context: any = { state: { bridgeStatus: { running } }, document: { getElementById: (id: string) => buttons[id] } };
  vm.createContext(context); vm.runInContext(RUNTIME_CONTROL_SCRIPT, context);
  return { buttons, context };
}
describe('runtime controls and side-effect isolation', () => {
  it('shows start only when stopped and stop/restart only when running', () => {
    const f = browser(false); f.context.renderRuntimeControls();
    assert.equal(f.buttons.startBridgeBtn.hidden,false); assert.equal(f.buttons.stopBridgeBtn.hidden,true);
    f.context.state.bridgeStatus.running = true; f.context.renderRuntimeControls();
    assert.equal(f.buttons.startBridgeBtn.hidden,true); assert.equal(f.buttons.stopBridgeBtn.hidden,false); assert.equal(f.buttons.restartBridgeBtn.hidden,false);
  });
  it('disables every operation while busy or while runtime state is unknown', () => {
    const f = browser(false); f.context.state.localBridgeOperation='start'; f.context.renderRuntimeControls();
    assert.equal(f.buttons.startBridgeBtn.textContent,'启动中…');
    for (const id of ['startBridgeBtn','stopBridgeBtn','restartBridgeBtn']) assert.equal(f.buttons[id].disabled,true);
    f.context.state.localBridgeOperation=null; f.context.state.bridgeStatus=null; f.context.renderRuntimeControls();
    assert.equal(f.buttons.startBridgeBtn.disabled,true);
  });
  it('does not save configuration and rejects false-success receipts', async () => {
    const f = browser(false); const calls:string[]=[];const notices:any[]=[];
    f.context.showMessage=(...args:any[])=>notices.push(args);
    f.context.loadBindings=f.context.loadLogs=async()=>{};
    f.context.api=async(p:string)=>{calls.push(p);return p==='/api/status'?{bridge:{running:false}}:{status:{running:false,error:'无法连接'}};};
    await f.context.performBridgeOperation('start');
    assert.ok(!calls.includes('/api/config')); assert.ok(notices.some(n=>n[1]==='error'&&n[2]==='无法连接'));assert.ok(!notices.some(n=>n[1]==='success'));
    assert.equal(f.context.state.localBridgeOperation,null);
  });
  it('serializes operations across clients and releases state after failure', async () => {
    const c=new BridgeOperationController();let release!:()=>void;
    const p=c.run('start',()=>new Promise<void>(r=>{release=r;}));assert.equal(c.current,'start');
    await assert.rejects(c.run('stop',async()=>{}),/正在进行/);release();await p;assert.equal(c.current,null);
    await assert.rejects(c.run('restart',async()=>{throw new Error('boom');}));assert.equal(c.current,null);
  });
  it('never invokes Weixin CLI merely because it is included in the workbench or bridge bundle', () => {
    for (const name of ['ui-server.mjs','daemon.mjs','cli.mjs']) assert.equal(isWeixinLoginCliEntrypoint('/app/'+name,'file:///app/'+name),false);
    assert.equal(isWeixinLoginCliEntrypoint('/app/weixin-login.ts','file:///app/weixin-login.ts'),true);
    assert.equal(isWeixinLoginCliEntrypoint('/space dir/weixin-login.ts','file:///space%20dir/weixin-login.ts'),true);
  });
});

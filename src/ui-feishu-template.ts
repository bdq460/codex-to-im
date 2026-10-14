export const FEISHU_TEMPLATE_HTML = `
<section class="panel" id="feishuTemplatePanel">
  <div class="panel-header"><div><h2>飞书机器人配置模板</h2>
  <p>新建机器人扫码时使用已保存模板。保存不会修改已有机器人；已有通道的配置检查按当前模板核对。</p></div></div>
  <p id="feishuTemplateMeta">正在读取模板…</p>
  <p>事件与回调接收方式：长连接。扫码入口可提交权限、事件与回调清单；接收方式、审批和发布仍需根据创建后的检查完成。用户身份权限还需要用户授权。</p>
  ${[['Tenant','应用身份权限'],['User','用户身份权限'],['Events','事件订阅'],['Callbacks','卡片回调']].map(([id,label]) => `<details ${id === 'Callbacks' ? 'open' : ''}><summary id="feishuTemplate${id}Label">${label}</summary><label for="feishuTemplate${id}">每行一个配置标识</label><textarea id="feishuTemplate${id}" rows="${id === 'Callbacks' ? 3 : 8}" style="width:100%;font-family:monospace;resize:vertical" spellcheck="false" disabled></textarea></details>`).join('')}
  <p id="feishuTemplateStatus" role="status"></p>
  <div class="toolbar"><button type="button" class="button primary" id="feishuTemplateSave" disabled>保存模板</button><button type="button" class="button" id="feishuTemplateReset" disabled>恢复参考配置到编辑器</button><button type="button" class="button" id="feishuTemplateReload">重新加载已保存模板</button></div>
</section>`;
export const FEISHU_TEMPLATE_SCRIPT = String.raw`
let feishuTemplateDocument = null, feishuTemplateDefaults = null, feishuTemplateBusy = false;
const feishuTemplateFields = ['Tenant','User','Events','Callbacks'];
function readFeishuTemplateEditor() {
  const lists = feishuTemplateFields.map(id => document.getElementById('feishuTemplate'+id).value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
  return {...feishuTemplateDocument.profile,scopes:{tenant:lists[0],user:lists[1]},events:lists[2],callbacks:lists[3]};
}
function updateFeishuTemplateEditorState() {
  const dirty = feishuTemplateDocument && JSON.stringify(readFeishuTemplateEditor()) !== JSON.stringify(feishuTemplateDocument.profile);
  document.getElementById('feishuTemplateSave').disabled = !dirty || feishuTemplateBusy;
  document.getElementById('feishuTemplateReset').disabled = !feishuTemplateDocument || feishuTemplateBusy;
  document.getElementById('feishuTemplateReload').disabled = feishuTemplateBusy;
  document.getElementById('feishuTemplateStatus').textContent = dirty ? '有未保存修改：扫码仍使用已保存模板。' : '';
  const labels = ['应用身份权限','用户身份权限','事件订阅','卡片回调'];
  feishuTemplateFields.forEach((id,i)=> {const count=document.getElementById('feishuTemplate'+id).value.split(/\r?\n/).filter(s=>s.trim()).length;document.getElementById('feishuTemplate'+id+'Label').textContent=labels[i]+'（'+count+'）';});
}
function fillFeishuTemplateEditor(profile) {
  const lists=[profile.scopes.tenant,profile.scopes.user,profile.events,profile.callbacks];
  feishuTemplateFields.forEach((id,i)=>document.getElementById('feishuTemplate'+id).value=lists[i].join('\n'));
  updateFeishuTemplateEditorState();
}
async function loadFeishuTemplateEditor() {
  if (feishuTemplateBusy) return;
  feishuTemplateBusy=true;updateFeishuTemplateEditorState();
  feishuTemplateFields.forEach(id=>document.getElementById('feishuTemplate'+id).disabled=true);
  try {const result=await api('/api/feishu-template');feishuTemplateDocument=result.template;feishuTemplateDefaults=result.defaults;
    fillFeishuTemplateEditor(result.template.profile);
    document.getElementById('feishuTemplateMeta').textContent='参考机器人版本 '+result.template.profile.referenceVersion+' · '+(result.template.savedAt?'保存于 '+new Date(result.template.savedAt).toLocaleString():'当前使用参考配置，尚未自定义');
  } catch(error){document.getElementById('feishuTemplateMeta').textContent=error.message;}
  finally {feishuTemplateBusy=false;feishuTemplateFields.forEach(id=>document.getElementById('feishuTemplate'+id).disabled=!feishuTemplateDocument);updateFeishuTemplateEditorState();}
}
feishuTemplateFields.forEach(id=>document.getElementById('feishuTemplate'+id).addEventListener('input',updateFeishuTemplateEditorState));
document.getElementById('feishuTemplateReset').addEventListener('click',()=>fillFeishuTemplateEditor(feishuTemplateDefaults));
document.getElementById('feishuTemplateReload').addEventListener('click',()=>{if(feishuTemplateDocument && JSON.stringify(readFeishuTemplateEditor())!==JSON.stringify(feishuTemplateDocument.profile) && !window.confirm('放弃未保存修改并重新加载？'))return;void loadFeishuTemplateEditor();});
document.getElementById('feishuTemplateSave').addEventListener('click',async()=>{
  if(feishuTemplateBusy || !feishuTemplateDocument)return;
  const profile=readFeishuTemplateEditor();feishuTemplateBusy=true;updateFeishuTemplateEditorState();
  feishuTemplateFields.forEach(id=>document.getElementById('feishuTemplate'+id).disabled=true);
  try {const result=await api('/api/feishu-template',{method:'POST',body:JSON.stringify({profile,revision:feishuTemplateDocument.revision})});feishuTemplateDocument=result.template;fillFeishuTemplateEditor(result.template.profile);document.getElementById('feishuTemplateMeta').textContent='已保存 · '+new Date(result.template.savedAt).toLocaleString();showMessage('configMessage','success','飞书模板已保存，下次扫码创建时生效。');}
  catch(error){showMessage('configMessage','error',error.message);}
  finally {feishuTemplateBusy=false;feishuTemplateFields.forEach(id=>document.getElementById('feishuTemplate'+id).disabled=false);updateFeishuTemplateEditorState();}
});
void loadFeishuTemplateEditor();
`;

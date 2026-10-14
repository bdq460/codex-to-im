import { listDesktopSessions, getDesktopSessionByThreadId } from './desktop-sessions.js';
import { ensureDesktopBridgeSession } from './session-bindings.js';
import { listChatSubscriptions, notificationChatAddresses, setNotificationSubscription, notificationPolicy } from './lib/bridge/notification-subscriptions.js';
import type { BridgeStore } from './lib/bridge/host.js';
export function notificationPanelPayload(store: BridgeStore, channelId: string) {
  const sessions = store.listSessions().filter(s=>!s.hidden && !s.parent_session_id && s.session_type !== 'draft' && (!s.expires_at || Date.parse(s.expires_at)>Date.now()));
  const desktop = listDesktopSessions(200);
  const options: Array<{id:string;title:string;cwd:string;sessionId?:string;lastEventAt?:string}> = desktop.map(d=>({id:d.threadId,title:d.title,cwd:d.cwd,sessionId:store.findSessionBySdkSessionId(d.threadId)?.id,lastEventAt:d.lastEventAt}));
  const desktopIds = new Set(options.map(o=>o.sessionId));
  for (const s of sessions) if (!desktopIds.has(s.id) && s.thread_origin !== 'desktop') options.push({id:s.id,title:s.name || '未命名会话',cwd:s.working_directory || '',sessionId:s.id,lastEventAt:s.updated_at});
  options.sort((a,b)=>(Date.parse(b.lastEventAt || '') || 0)-(Date.parse(a.lastEventAt || '') || 0));
  const chats = notificationChatAddresses(store).filter(a=>a.channelType===channelId).map(a=>{
    const b=store.getChannelBinding(a.channelType,a.chatId);
    return {...notificationPolicy(a),chatId:a.chatId,title:b?.chatDisplayName || a.chatId,currentSessionId:b?.codepilotSessionId,subscriptions:listChatSubscriptions(store,a).map(r=>({sessionId:r.sessionId,title:store.getSession(r.sessionId)?.name || '已删除的会话'}))};
  });
  return {chats,options};
}
export function updateNotificationPanel(store: BridgeStore, channelId: string, chatId: string, target: string, enabled: boolean): void {
  const address=notificationChatAddresses(store).find(a=>a.channelType===channelId && a.chatId===chatId);
  if (!address) throw new Error('此聊天尚未建立连接，请先在 IM 中发送 /t。');
  let session=store.getSession(target) || store.findSessionBySdkSessionId(target);
  if (!session && enabled) {
    const d=getDesktopSessionByThreadId(target);
    if (!d) throw new Error('桌面会话不存在或已归档。');
    session=ensureDesktopBridgeSession(store,target,{workingDirectory:d.cwd,displayName:d.title});
  }
  if (!session && enabled) throw new Error('会话不可用。');
  setNotificationSubscription(store,address,session?.id || target,enabled);
}
export const NOTIFICATION_PANEL_SCRIPT = String.raw`
const notificationPanelChat = new Map();
const notificationPanelSearch = new Map();
let notificationPanelGeneration = 0;
async function renderNotificationPanel(channelId) {
  const host=document.getElementById('notificationSubscriptionPanel');if(!host)return;
  const generation=++notificationPanelGeneration;
  host.textContent='正在读取通知订阅…';
  try {
    const result=await api('/api/notification-subscriptions?channelId='+encodeURIComponent(channelId));
    if(generation!==notificationPanelGeneration || !host.isConnected)return;
    let searchQuery = notificationPanelSearch.get(channelId) || '';
    const render = () => {
      host.replaceChildren();
      const title=document.createElement('h3');title.textContent='接收通知的订阅会话';host.append(title);
      const explanation=document.createElement('p');explanation.textContent='独立于上方的当前发送会话。勾选会话后接收之后的新结果；取消勾选停止通知。IM 主动发起的任务仍会回复原聊天。';host.append(explanation);
      if(!result.chats.length){const empty=document.createElement('p');empty.textContent='先在此机器人的聊天中发送 /t，之后即可管理该聊天的通知。';host.append(empty);return;}
      const select=document.createElement('select');select.setAttribute('aria-label','通知接收聊天');
      for(const chat of result.chats){const option=document.createElement('option');option.value=chat.chatId;option.textContent=chat.title;select.append(option);}
      select.value=notificationPanelChat.get(channelId) || result.chats[0].chatId;if(!select.value)select.value=result.chats[0].chatId;
      host.append(select);notificationPanelChat.set(channelId,select.value);
      select.addEventListener('change',()=>{notificationPanelChat.set(channelId,select.value);render();});
      const chat=result.chats.find(c=>c.chatId===select.value);
      const summary=document.createElement('p');summary.textContent='当前发送：'+(result.options.find(o=>o.sessionId===chat.currentSessionId)?.title || '未选择')+' · 已订阅 '+chat.subscriptions.length+' 个会话';host.append(summary);
      const search=document.createElement('input');search.type='search';search.value=searchQuery;search.placeholder='搜索会话名称或项目';search.setAttribute('aria-label','搜索可订阅会话');host.append(search);
      const list=document.createElement('div');list.style.cssText='max-height:320px;overflow:auto;display:grid;gap:10px;margin-top:12px';host.append(list);
      const draw = () => {
        list.replaceChildren();const subscribed=new Set(chat.subscriptions.map(s=>s.sessionId));
        const rows=[...result.options];for(const s of chat.subscriptions)if(!rows.some(o=>o.sessionId===s.sessionId))rows.push({id:s.sessionId,sessionId:s.sessionId,title:s.title,cwd:''});
        for(const row of rows.filter(r=>(r.title+' '+r.cwd).toLowerCase().includes(search.value.toLowerCase()))){
          const label=document.createElement('label');label.style.cssText='display:flex;gap:10px;align-items:center;padding:12px;border:1px solid #e3e7ed;border-radius:8px';
          const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.style.cssText='width:16px;min-width:16px;height:16px;flex:0 0 16px;margin:0';checkbox.checked=subscribed.has(row.sessionId);checkbox.setAttribute('aria-label','订阅 '+row.title);
          const text=document.createElement('span');text.textContent=row.title+(row.sessionId===chat.currentSessionId?' · 当前发送':'')+' · '+(row.cwd || '未指定项目');label.append(checkbox,text);list.append(label);
          checkbox.addEventListener('change',async()=>{
            const enabled=checkbox.checked;host.querySelectorAll('input,select').forEach(el=>el.disabled=true);
            try {const next=await api('/api/notification-subscriptions',{method:'POST',body:JSON.stringify({channelId,chatId:chat.chatId,target:row.id,enabled})});if(generation!==notificationPanelGeneration || !host.isConnected)return;result.chats=next.chats;result.options=next.options;render();showMessage('channelMessage','success',enabled?'已订阅通知，发送会话未改变。':'已取消通知订阅，发送会话未改变。');}
            catch(error){checkbox.checked=!enabled;showMessage('channelMessage','error',error.message);host.querySelectorAll('input,select').forEach(el=>el.disabled=false);}
          });
        }
        if(!list.childNodes.length)list.textContent='没有匹配的会话。';
      };
      search.addEventListener('input',()=>{searchQuery=search.value;notificationPanelSearch.set(channelId,searchQuery);draw();});draw();
    };render();
  }catch(error){if(generation===notificationPanelGeneration && host.isConnected)host.textContent=error.message;}
}
`;

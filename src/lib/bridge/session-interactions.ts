import type { InboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { getBridgeContext } from './context.js';
import * as router from './channel-router.js';
import { decodeSessionAction, newSessionCommand, sendSessionPicker } from './session-navigation.js';
import { getDesktopSessionByThreadIdSafe } from './bridge-session-support.js';
import { deliverBridgeNotice } from './feedback-delivery.js';
import { getPendingMessage, claimPendingMessage, finishPendingMessage, releasePendingMessage, sessionForMessage, savePendingMessage } from './session-interaction-store.js';

type Dependencies = {
  busy: (id: string) => boolean;
  command: (adapter: BaseChannelAdapter, msg: InboundMessage, text: string) => Promise<void>;
  replay: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<void>;
};
function usableSession(id: string) {
  const session = getBridgeContext().store.getSession(id);
  if (!session || session.hidden || session.parent_session_id || session.session_type === 'draft' || (session.expires_at && Date.parse(session.expires_at) <= Date.now())) return null;
  if (session.thread_origin === 'desktop' && !getDesktopSessionByThreadIdSafe(session.desktop_thread_id || session.sdk_session_id || '', 'message reply')) return null;
  return session;
}
async function selectSession(adapter: BaseChannelAdapter, msg: InboundMessage, id: string, deps: Dependencies, confirmSelection = false, hasPendingMessage = false): Promise<boolean> {
  const { store } = getBridgeContext();
  const session = usableSession(id);
  if (!session) return false;
  const current = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
  if (current?.codepilotSessionId !== id && current && deps.busy(current.codepilotSessionId)) {
    await deliverBridgeNotice(adapter, msg.address, '当前会话正在执行任务，暂时不能切换。完成后再回复这条消息，或发送 /stop。');
    return false;
  }
  const changed = current?.codepilotSessionId !== id;
  if (changed && !router.bindToSession(msg.address, id)) {
    await deliverBridgeNotice(adapter, msg.address, '未能切换会话，请发送 /t 重新选择。');
    return false;
  }
  if (changed || confirmSelection) {
    const title = (session.name || '未命名会话').replace(/[\r\n]/g, ' ');
    const notice = await deliverBridgeNotice(adapter, msg.address,
      `${changed ? '已切换到' : '当前已是'}「${title}」。\n${hasPendingMessage ? '之前保留的消息将继续执行。' : '下一条普通消息将发送到此会话；选择本身不会启动任务。'}引用其它结果回复会切换到其所属会话。`);
    if (!notice.ok) throw new Error(notice.error || '会话选择结果发送失败');
  }
  return true;
}
export async function handleSessionAction(adapter: BaseChannelAdapter, msg: InboundMessage, deps: Dependencies): Promise<void> {
  if (!adapter.isAuthorized(msg.address.userId || '', msg.address.chatId)) return;
  const action = decodeSessionAction(msg.callbackData || '', msg.address);
  if (!action) {
    await deliverBridgeNotice(adapter, msg.address, '入口已失效，请发送 /t 重新选择。原消息不会自动执行。');
    return;
  }
  if (action.kind === 'list') { await sendSessionPicker(adapter, msg.address, { offset: action.offset, pendingId: action.pendingId }); return; }
  if (action.pendingId && getPendingMessage(msg.address, action.pendingId)?.status !== 'waiting') {
    await deliverBridgeNotice(adapter, msg.address, '这条消息已处理、正在执行或已过期，请勿重复点击。'); return;
  }
  const { store } = getBridgeContext();
  const current = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
  if (current && deps.busy(current.codepilotSessionId) && (action.kind !== 'resume' || action.sessionId !== current.codepilotSessionId)) {
    await deliverBridgeNotice(adapter, msg.address, '当前会话正在执行任务。完成后再次选择即可继续，原消息已保留。'); return;
  }
  if (action.kind === 'enter' && !getDesktopSessionByThreadIdSafe(action.threadId, 'session selection')) {
    await deliverBridgeNotice(adapter, msg.address, '这条会话已归档或不可用，请重新选择。');
    await sendSessionPicker(adapter, msg.address, { recent: true, pendingId: action.pendingId }); return;
  }
  if (action.kind === 'resume' && !usableSession(action.sessionId)) {
    await deliverBridgeNotice(adapter, msg.address, '这条会话已删除或不可用，请重新选择。');
    await sendSessionPicker(adapter, msg.address, { recent: true, pendingId: action.pendingId }); return;
  }
  const pending = action.pendingId ? claimPendingMessage(msg.address, action.pendingId) : null;
  if (action.pendingId && !pending) return;
  let selected = false;
  try {
    if (action.kind === 'resume') selected = await selectSession(adapter, msg, action.sessionId, deps, true, !!pending);
    else {
      await deps.command(adapter, { ...msg, messageId: msg.callbackMessageId || msg.messageId }, action.kind === 'new' ? newSessionCommand() : `/thread ${action.threadId}`);
      const after = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      selected = !!after && (action.kind === 'new' ? after.codepilotSessionId !== current?.codepilotSessionId : (store.getSession(after.codepilotSessionId)?.desktop_thread_id || after.sdkSessionId) === action.threadId);
    }
    if (!selected) { if (action.pendingId) releasePendingMessage(msg.address, action.pendingId); return; }
  } catch (error) { if (action.pendingId) releasePendingMessage(msg.address, action.pendingId); throw error; }
  if (pending && action.pendingId) {
    if (action.kind === 'new') {
      const binding = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      if (binding) store.updateSession(binding.codepilotSessionId, { name: pending.text.trim().split(/\r?\n/)[0].slice(0, 48) || '附件会话' });
    }
    // Once execution starts, never automatically replay after a crash or error.
    await deps.replay(adapter, pending);
    finishPendingMessage(msg.address, action.pendingId);
  }
}
/** Returns false when a reply cannot be safely routed; never falls back to an unrelated current session. */
export async function routeSessionReply(adapter: BaseChannelAdapter, msg: InboundMessage, deps: Dependencies): Promise<boolean> {
  if (!msg.replyToMessageId && !msg.rootMessageId) return true;
  const id = (msg.replyToMessageId && sessionForMessage(msg.address, msg.replyToMessageId))
    || (msg.rootMessageId && sessionForMessage(msg.address, msg.rootMessageId));
  if (id && await selectSession(adapter, msg, id, deps)) return true;
  const pendingId = savePendingMessage(msg);
  await deliverBridgeNotice(adapter, msg.address, '无法继续所回复的会话，或当前任务尚未结束。请选择会话，原消息已保留。');
  await sendSessionPicker(adapter, msg.address, { recent: true, unbound: true, pendingId });
  return false;
}

export function sessionInteractionLockId(msg: InboundMessage): string | null {
  if (msg.callbackData?.startsWith('session:')) {
    const action = decodeSessionAction(msg.callbackData, msg.address);
    if (action?.kind === 'resume') return action.sessionId;
    if (action?.kind === 'enter') return getBridgeContext().store.findSessionBySdkSessionId(action.threadId)?.id || null;
  }
  return (msg.replyToMessageId && sessionForMessage(msg.address, msg.replyToMessageId))
    || (msg.rootMessageId && sessionForMessage(msg.address, msg.rootMessageId)) || null;
}

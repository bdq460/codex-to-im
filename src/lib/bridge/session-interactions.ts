import { setNotificationSubscription } from './notification-subscriptions.js';
import { ensureDesktopBridgeSession } from '../../session-bindings.js';
import type { InboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { getBridgeContext } from './context.js';
import * as router from './channel-router.js';
import { decodeSessionAction, newSessionCommand, sendDirectoryPicker, sendSessionPicker } from './session-navigation.js';
import { getDesktopSessionByThreadIdSafe, getDesktopThreadTitle, resolveNewWorkingDirectory, resolveSessionDisplayName } from './bridge-session-support.js';
import { getExplicitDesktopThreadId } from './turns/turn-classifier.js';
import type { BridgeSession } from './host.js';
import { readDesktopSessionMessages } from '../../desktop-sessions.js';
import { formatCommandPath, summarizeLastExchange, summarizeRecentExchanges } from './command-formatters.js';
import { deliverBridgeNotice } from './feedback-delivery.js';
import { getPendingMessage, claimPendingMessage, finishPendingMessage, releasePendingMessage, sessionForMessage, savePendingMessage } from './session-interaction-store.js';

type Dependencies = {
  busy: (id: string) => boolean;
  command: (adapter: BaseChannelAdapter, msg: InboundMessage, text: string) => Promise<void>;
  replay: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<void>;
  /** Terminates the Codex desktop process group; injectable for tests. */
  quitDesktop: () => Promise<{ ok: boolean; alreadyClosed?: boolean; detail: string }>;
};
function usableSession(id: string) {
  const session = getBridgeContext().store.getSession(id);
  if (!session || session.hidden || session.parent_session_id || session.session_type === 'draft' || (session.expires_at && Date.parse(session.expires_at) <= Date.now())) return null;
  if (session.thread_origin === 'desktop' && !getDesktopSessionByThreadIdSafe(session.desktop_thread_id || session.sdk_session_id || '', 'message reply')) return null;
  return session;
}
/** Latest-turn summary from the desktop thread (preferred) or the bridge cache. */
function describeLastInteraction(session: BridgeSession): string {
  const desktopThreadId = getExplicitDesktopThreadId(session);
  if (desktopThreadId) {
    try {
      return summarizeLastExchange(readDesktopSessionMessages(desktopThreadId, 6));
    } catch { /* fall back to the bridge cache below */ }
  }
  const { messages } = getBridgeContext().store.getMessages(session.id, { limit: 6 });
  return summarizeLastExchange(messages);
}

/** Compact session detail: what the Codex chat window shows for the most recent exchanges. */
async function sendSessionDetail(adapter: BaseChannelAdapter, address: import('./types.js').ChannelAddress, threadId: string): Promise<void> {
  const { store } = getBridgeContext();
  const desktop = getDesktopSessionByThreadIdSafe(threadId, 'session detail');
  if (desktop) {
    let recent = '暂无记录';
    try { recent = summarizeRecentExchanges(readDesktopSessionMessages(threadId, 24), 3); } catch { /* keep placeholder */ }
    const activity = Number.isFinite(Date.parse(desktop.lastEventAt)) ? new Date(desktop.lastEventAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无记录';
    await deliverBridgeNotice(adapter, address, [
      `**📋 会话详情：「${desktop.title.replace(/[\r\n]/g, ' ').slice(0, 100) || '未命名会话'}」**`,
      '',
      `- **目录**：${formatCommandPath(desktop.cwd)}`,
      `- **最近活动**：${activity}`,
      '',
      '**🗂 最近交互**（与 Codex 聊天框一致）',
      '',
      recent,
      '',
      '_仅摘要展示；完整内容请到 Codex 中查看。_',
    ].join('\n'));
    return;
  }
  const session = usableSession(threadId) || store.getSession(threadId);
  if (!session) {
    await deliverBridgeNotice(adapter, address, '这条会话已归档或不可用，请刷新列表后重试。');
    return;
  }
  const { messages } = store.getMessages(session.id, { limit: 24 });
  await deliverBridgeNotice(adapter, address, [
    `**📋 会话详情：「${resolveSessionDisplayName(session).replace(/[\r\n]/g, ' ')}」**`,
    '',
    `- **目录**：${formatCommandPath(session.working_directory)}`,
    '',
    '**🗂 最近交互**（与 Codex 聊天框一致）',
    '',
    summarizeRecentExchanges(messages, 3),
    '',
    '_仅摘要展示；完整内容请到 Codex 中查看。_',
  ].join('\n'));
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
    const title = resolveSessionDisplayName(session).replace(/[\r\n]/g, ' ');
    const lastInteraction = describeLastInteraction(session);
    const notice = await deliverBridgeNotice(adapter, msg.address, [
      `**${changed ? '🔄 已切换到' : '📍 当前已是'}「${title}」**`,
      '',
      `- **目录**：${formatCommandPath(session.working_directory)}`,
      '',
      '**🗂 最近交互**',
      '',
      lastInteraction,
      '',
      hasPendingMessage
        ? '▶️ 之前保留的消息将继续执行。'
        : '💬 下一条普通消息将发送到此会话；选择本身不会启动任务。引用其它结果回复会切换到其所属会话。',
    ].join('\n'));
    if (!notice.ok) throw new Error(notice.error || '会话选择结果发送失败');
  }
  if (changed || confirmSelection) await adapter.refreshSessionCards?.(msg.address);
  return true;
}
export async function handleSessionAction(adapter: BaseChannelAdapter, msg: InboundMessage, deps: Dependencies): Promise<void> {
  if (!adapter.isAuthorized(msg.address.userId || '', msg.address.chatId)) return;
  const action = decodeSessionAction(msg.callbackData || '', msg.address);
  if (!action) {
    await deliverBridgeNotice(adapter, msg.address, '入口已失效，请发送 /t 重新选择。原消息不会自动执行。');
    return;
  }
  if (action.kind === 'list') {
    const options = { offset: action.offset, view: action.view || 'recent' as const, pendingId: action.pendingId };
    if (!await adapter.updateSessionPicker?.(msg.address, options, msg.callbackMessageId)) await sendSessionPicker(adapter, msg.address, options);
    return;
  }
  if (action.kind === 'newpick') {
    const options = { offset: action.offset || 0, pendingId: action.pendingId };
    if (!await adapter.updateDirPicker?.(msg.address, options, msg.callbackMessageId)) await sendDirectoryPicker(adapter, msg.address, options);
    return;
  }
  if (action.kind === 'detail') {
    await sendSessionDetail(adapter, msg.address, action.threadId);
    return;
  }
  if (action.kind === 'subscribe') {
    const { store } = getBridgeContext();
    let session = store.getSession(action.threadId) || store.findSessionBySdkSessionId(action.threadId);
    if (!session && action.enabled) {
      const desktop = getDesktopSessionByThreadIdSafe(action.threadId, 'notification subscription');
      if (desktop) session = ensureDesktopBridgeSession(store, action.threadId, { workingDirectory: desktop.cwd, displayName: desktop.title });
    }
    if (!session || (action.enabled && !usableSession(session.id))) { await deliverBridgeNotice(adapter, msg.address, '会话不可用，请刷新列表。'); return; }
    setNotificationSubscription(store, msg.address, session.id, action.enabled);
    await deliverBridgeNotice(adapter, msg.address, [
      `**${action.enabled ? '🔔 已订阅' : '🔕 已取消订阅'}「${resolveSessionDisplayName(session)}」的通知**`,
      '',
      '- 当前绑定会话保持不变',
      '- 你主动发起的任务仍会回复',
    ].join('\n'));
    await adapter.refreshSessionCards?.(msg.address);
    if (!adapter.refreshSessionCards) await sendSessionPicker(adapter, msg.address, { offset: action.offset, view: action.view, pendingId: action.pendingId });
    return;
  }
  if (action.pendingId && getPendingMessage(msg.address, action.pendingId)?.status !== 'waiting') {
    await deliverBridgeNotice(adapter, msg.address, '这条消息已处理、正在执行或已过期，请勿重复点击。'); return;
  }
  const { store } = getBridgeContext();
  const current = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
  if (current && deps.busy(current.codepilotSessionId) && (action.kind !== 'resume' || action.sessionId !== current.codepilotSessionId)) {
    await deliverBridgeNotice(adapter, msg.address, '当前会话正在执行任务。完成后再次选择即可继续，原消息已保留。'); return;
  }
  if (action.kind === 'quitdesktop') {
    const pending = action.pendingId ? claimPendingMessage(msg.address, action.pendingId) : null;
    if (!pending || !action.pendingId) {
      await deliverBridgeNotice(adapter, msg.address, '这条消息已处理、正在执行或已过期，请勿重复点击。'); return;
    }
    if (!action.proceed) {
      finishPendingMessage(msg.address, action.pendingId);
      await deliverBridgeNotice(adapter, msg.address, '已取消：原消息不再执行，需要时请重新发送。');
      return;
    }
    await deliverBridgeNotice(adapter, msg.address, '正在退出 ChatGPT（含 Codex 桌面版），完成后自动执行原消息…');
    const quit = await deps.quitDesktop();
    if (!quit.ok) {
      releasePendingMessage(msg.address, action.pendingId);
      await deliverBridgeNotice(adapter, msg.address, `未能自动关闭 Codex 桌面版：${quit.detail}\n请手动关闭后重新发送原消息。`);
      return;
    }
    // Safe to replay blindly: deps.replay re-enters handleMessage, and the desktop
    // processes are gone by now so the conflict guard will not intercept again.
    await deps.replay(adapter, pending);
    finishPendingMessage(msg.address, action.pendingId);
    return;
  }
  if (action.kind === 'enter' && !getDesktopSessionByThreadIdSafe(action.threadId, 'session selection')) {
    await deliverBridgeNotice(adapter, msg.address, '这条会话已归档或不可用，请重新选择。');
    await sendSessionPicker(adapter, msg.address, { recent: true, pendingId: action.pendingId }); return;
  }
  if (action.kind === 'resume' && !usableSession(action.sessionId)) {
    await deliverBridgeNotice(adapter, msg.address, '这条会话已删除或不可用，请重新选择。');
    await sendSessionPicker(adapter, msg.address, { recent: true, pendingId: action.pendingId }); return;
  }
  if (action.kind === 'new' && adapter.provider === 'feishu') {
    // Feishu asks for the target directory first; other channels keep the implicit workspace default.
    await sendDirectoryPicker(adapter, msg.address, { pendingId: action.pendingId });
    return;
  }
  if (action.kind === 'newdir' && !resolveNewWorkingDirectory(action.dir).ok) {
    await deliverBridgeNotice(adapter, msg.address, '目录无效，请重新选择或直接发送 `/new 绝对路径`。');
    await sendDirectoryPicker(adapter, msg.address, { pendingId: action.pendingId });
    return;
  }
  const pending = action.pendingId ? claimPendingMessage(msg.address, action.pendingId) : null;
  if (action.pendingId && !pending) return;
  const createsNewSession = action.kind === 'new' || action.kind === 'newdir';
  let selected = false;
  try {
    if (action.kind === 'resume') selected = await selectSession(adapter, msg, action.sessionId, deps, true, !!pending);
    else {
      const commandText = action.kind === 'newdir' ? `/new ${action.dir}` : action.kind === 'new' ? newSessionCommand() : `/thread ${action.threadId}`;
      await deps.command(adapter, { ...msg, messageId: msg.callbackMessageId || msg.messageId }, commandText);
      const after = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      selected = !!after && (createsNewSession ? after.codepilotSessionId !== current?.codepilotSessionId : (store.getSession(after.codepilotSessionId)?.desktop_thread_id || after.sdkSessionId) === action.threadId);
    }
    if (selected && action.kind !== 'resume') await adapter.refreshSessionCards?.(msg.address);
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

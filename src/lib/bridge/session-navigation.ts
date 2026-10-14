import crypto from 'node:crypto';
import path from 'node:path';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { ChannelAddress, InlineButton } from './types.js';
import { deliver } from './delivery-layer.js';
import { getDisplayedDesktopThreads, getWorkspaceRoot } from './bridge-session-support.js';

import { navigationSecret } from './session-interaction-store.js';
import { listChatSubscriptions, isNotificationSubscribed } from './notification-subscriptions.js';
import { getBridgeContext } from './context.js';
const key = navigationSecret();
const TTL = 30 * 60_000;
const PAGE_SIZE = 6;
export type PickerView = 'recent' | 'all' | 'subscribed';
export type PickerOptions = { unbound?: boolean; offset?: number; recent?: boolean; pendingId?: string; view?: PickerView };
export type SessionAction = ({ kind: 'enter'; threadId: string } | { kind: 'resume'; sessionId: string } | { kind: 'list'; offset: number; view?: PickerView } | { kind: 'subscribe'; threadId: string; enabled: boolean; offset?: number; view?: PickerView } | { kind: 'new' }) & { pendingId?: string };

export function encodeSessionAction(address: ChannelAddress, action: SessionAction, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ channel: address.channelType, chat: address.chatId, action, expires: now + (action.pendingId ? 24 * 60 * 60_000 : (action.kind === 'resume' || action.kind === 'subscribe') ? 90 * 24 * 60 * 60_000 : TTL) })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `session:${payload}.${sig}`;
}

export function decodeSessionAction(data: string, address: ChannelAddress, now = Date.now()): SessionAction | null {
  try {
    if (!data.startsWith('session:') || data.length > 2048) return null;
    const [payload, sig, extra] = data.slice(8).split('.');
    if (!payload || !sig || extra) return null;
    const expected = crypto.createHmac('sha256', key).update(payload).digest();
    const actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (parsed.channel !== address.channelType || parsed.chat !== address.chatId || !Number.isFinite(parsed.expires) || parsed.expires <= now) return null;
    const a = parsed.action;
    if (a?.view !== undefined && !['recent','all','subscribed'].includes(a.view)) return null;
    if (a?.offset !== undefined && (!Number.isInteger(a.offset) || a.offset < 0 || a.offset >= 200)) return null;
    if (a?.kind === 'subscribe' && typeof a.enabled === 'boolean' && typeof a.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.threadId)) return a;
    if (a?.pendingId !== undefined && (typeof a.pendingId !== 'string' || a.pendingId.length > 256)) return null;
    if (a?.kind === 'resume' && typeof a.sessionId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.sessionId)) return a;
    if (a?.kind === 'enter' && typeof a.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.threadId)) return a;
    if (a?.kind === 'list' && Number.isInteger(a.offset) && a.offset >= 0 && a.offset < 200) return a;
    return a?.kind === 'new' ? a : null;
  } catch { return null; }
}

export function buildSessionPicker(address: ChannelAddress, sessions: Array<{ threadId: string; title: string; cwd: string; sessionId?: string; lastEventAt?: string }>, options: PickerOptions = {}) {
  const { store } = getBridgeContext();
  const binding = store.getChannelBinding(address.channelType, address.chatId);
  const current = binding && store.getSession(binding.codepilotSessionId);
  const subscriptions = listChatSubscriptions(store, address);
  const subscribedIds = new Set(subscriptions.map(r => r.sessionId));
  const view = options.view || (options.recent ? 'recent' : 'all');
  const filtered = view === 'subscribed' ? sessions.filter(s => isNotificationSubscribed(store,address,s.threadId)) : sessions;
  const size = view === 'recent' ? 3 : PAGE_SIZE;
  const offset = Math.min(options.offset || 0, Math.max(0, Math.floor((filtered.length - 1) / size) * size));
  const rows = filtered.slice(offset, offset + size);
  const text = `**会话中心**\n当前绑定会话：${current?.name || '未选择'}\n通知：默认接收全部未归档会话，可逐条取消 · 切换绑定不会改变订阅\n` + (options.pendingId ? '原消息已保留：选择发送会话后自动继续。' : '设为当前仅决定下一条普通消息发给谁；订阅通知仅决定接收谁的结果。');
  const sections = rows.map(s => {
    const id = s.sessionId || store.findSessionBySdkSessionId(s.threadId)?.id || s.threadId;
    const isCurrent = binding?.codepilotSessionId === id || (!!current?.desktop_thread_id && current.desktop_thread_id === s.threadId);
    const subscribed = isNotificationSubscribed(store,address,s.threadId);
    const buttons: InlineButton[] = [];
    if (!isCurrent || options.pendingId) buttons.push({ text: options.pendingId ? '在此会话继续原消息' : '绑定此会话', callbackData: encodeSessionAction(address, s.sessionId ? { kind: 'resume', sessionId: s.sessionId, pendingId: options.pendingId } : { kind: 'enter', threadId: s.threadId, pendingId: options.pendingId }) });
    buttons.push({ text: subscribed ? '取消订阅' : '开启订阅', callbackData: encodeSessionAction(address, { kind: 'subscribe', threadId: s.threadId, enabled: !subscribed, offset, view, pendingId: options.pendingId }) });
    const activity = s.lastEventAt && Number.isFinite(Date.parse(s.lastEventAt)) ? new Date(s.lastEventAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无记录';
    return { text: `**${s.title.replace(/[\r\n]/g, ' ').slice(0, 100)}**${isCurrent ? ' · 当前绑定会话' : ''}\n${subscribed ? '已订阅通知' : '未订阅通知'} · 项目 ${path.basename(s.cwd) || '未指定'}\n最近活动：${activity}`, buttons };
  });
  sections.push({ text: rows.length ? `按最近活动倒序 · ${offset + 1}–${offset + rows.length} / ${filtered.length}` : view === 'subscribed' ? '尚无可用订阅。到最近或全部会话中添加。' : '暂时没有可选会话。', buttons: [] });
  const buttons: InlineButton[][] = [[...(['recent','all','subscribed'] as PickerView[]).filter(v => v !== view).map(v => ({ text: v === 'recent' ? '最近活跃' : v === 'all' ? '全部会话' : '我的订阅', callbackData: encodeSessionAction(address, { kind: 'list', offset: 0, view: v, pendingId: options.pendingId }) }))]];
  const pagination: InlineButton[] = [];
  if (offset > 0) pagination.push({ text: '上一页', callbackData: encodeSessionAction(address, { kind: 'list', offset: Math.max(0, offset-size), view, pendingId: options.pendingId }) });
  if (view !== 'recent' && offset + rows.length < filtered.length) pagination.push({ text: '下一页', callbackData: encodeSessionAction(address, { kind: 'list', offset: offset+size, view, pendingId: options.pendingId }) });
  if (pagination.length) buttons.push(pagination);
  buttons.push([{ text: '新建会话', callbackData: encodeSessionAction(address, { kind: 'new', pendingId: options.pendingId }) }]);
  return { text, sections, inlineButtons: [...sections.filter(s=>s.buttons.length).map(s=>s.buttons), ...buttons], navigationButtons: buttons };
}

export async function sendSessionPicker(adapter: BaseChannelAdapter, address: ChannelAddress, options: PickerOptions = {}): Promise<void> {
  const picker = buildSessionPicker(address, selectableSessions(), options);
  const result = await deliver(adapter, { address, text: picker.text, inlineButtons: picker.navigationButtons, sections: picker.sections, sessionPicker: options, parseMode: 'Markdown' });
  if (!result.ok) throw new Error(result.error || '会话选择卡片发送失败');
}

export function newSessionCommand(): string {
  return `/new ${path.join(getWorkspaceRoot(), `im-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`)}`;
}

export function selectableSessions() {
  const { store } = getBridgeContext();
  const desktop = getDisplayedDesktopThreads(200) || [];
  const desktopIds = new Set(desktop.map(s => s.threadId));
  const local = store.listSessions().filter(s => !s.hidden && !s.parent_session_id && s.session_type !== 'draft' && s.thread_origin !== 'desktop' && !desktopIds.has(s.sdk_session_id || '') && (!s.expires_at || Date.parse(s.expires_at) > Date.now()));
  return [...desktop.map(s => ({ ...s, sessionId: store.findSessionBySdkSessionId(s.threadId)?.id })), ...local.map(s => ({ threadId: s.id, sessionId: s.id, title: s.name || '未命名会话', cwd: s.working_directory, lastEventAt: s.updated_at || s.created_at || '' }))]
    .sort((a, b) => (Date.parse(b.lastEventAt) || 0) - (Date.parse(a.lastEventAt) || 0)).slice(0, 200);
}
export function sessionResultButtons(address: ChannelAddress, sessionId: string): InlineButton[][] {
  const current = getBridgeContext().store.getChannelBinding(address.channelType, address.chatId)?.codepilotSessionId;
  return [[
    ...(current === sessionId ? [] : [{ text: '绑定此会话', callbackData: encodeSessionAction(address, { kind: 'resume', sessionId }) }]),
    { text: isNotificationSubscribed(getBridgeContext().store,address,sessionId) ? '取消订阅' : '开启订阅', callbackData: encodeSessionAction(address, {kind:'subscribe',threadId:sessionId,enabled:!isNotificationSubscribed(getBridgeContext().store,address,sessionId)}) },
    { text: '选择其它会话', callbackData: encodeSessionAction(address, { kind: 'list', offset: 0, view: 'recent' }) },
  ]];
}

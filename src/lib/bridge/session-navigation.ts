import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { ChannelAddress, InlineButton } from './types.js';
import type { CardChrome } from './markdown/action-card.js';
import { deliver } from './delivery-layer.js';
import { getDisplayedDesktopThreads, getWorkspaceRoot, resolveSessionDisplayName } from './bridge-session-support.js';
import { validateWorkingDirectory } from './security/validators.js';

import { navigationSecret } from './session-interaction-store.js';
import { listChatSubscriptions, isNotificationSubscribed } from './notification-subscriptions.js';
import { getBridgeContext } from './context.js';
const key = navigationSecret();
const TTL = 30 * 60_000;
const PAGE_SIZE = 10;
const DIR_PAGE_SIZE = 6;
const DIR_SCAN_LIMIT = 30;
const DIR_LIST_LIMIT = 60;
/** Directories that are never offered as new-session targets. */
const DIR_SCAN_EXCLUDES = new Set(['node_modules', '__pycache__', '.git', 'dist', 'build', 'venv', '.venv', 'target']);
export type PickerView = 'recent' | 'all' | 'subscribed';
export type PickerOptions = { unbound?: boolean; offset?: number; recent?: boolean; pendingId?: string; view?: PickerView };
export type DirPickerOptions = { offset?: number; pendingId?: string };
export type SessionAction = ({ kind: 'enter'; threadId: string } | { kind: 'resume'; sessionId: string } | { kind: 'quitdesktop'; proceed: boolean } | { kind: 'list'; offset: number; view?: PickerView } | { kind: 'subscribe'; threadId: string; enabled: boolean; offset?: number; view?: PickerView } | { kind: 'detail'; threadId: string } | { kind: 'new' } | { kind: 'newpick'; offset?: number } | { kind: 'newdir'; dir: string }) & { pendingId?: string };

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
    if (a?.kind === 'quitdesktop' && typeof a.proceed === 'boolean') return a;
    if (a?.kind === 'resume' && typeof a.sessionId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.sessionId)) return a;
    if (a?.kind === 'enter' && typeof a.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.threadId)) return a;
    if (a?.kind === 'detail' && typeof a.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.threadId)) return a;
    if (a?.kind === 'list' && Number.isInteger(a.offset) && a.offset >= 0 && a.offset < 200) return a;
    if (a?.kind === 'newpick' && (a.offset === undefined || (Number.isInteger(a.offset) && a.offset >= 0 && a.offset < 200))) return a;
    if (a?.kind === 'newdir' && typeof a.dir === 'string' && a.dir.length > 0 && a.dir.length <= 512 && path.isAbsolute(a.dir) && !!validateWorkingDirectory(a.dir)) return a;
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
  const size = PAGE_SIZE;
  const offset = Math.min(options.offset || 0, Math.max(0, Math.floor((filtered.length - 1) / size) * size));
  const rows = filtered.slice(offset, offset + size);
  const text = `当前绑定会话：${current ? resolveSessionDisplayName(current) : '未选择'}\n通知：默认接收全部未归档会话，可逐条取消 · 切换绑定不会改变订阅\n` + (options.pendingId ? '原消息已保留：选择发送会话后自动继续。' : '设为当前仅决定下一条普通消息发给谁；订阅通知仅决定接收谁的结果。');
  const sections = rows.map(s => {
    const id = s.sessionId || store.findSessionBySdkSessionId(s.threadId)?.id || s.threadId;
    const isCurrent = binding?.codepilotSessionId === id || (!!current?.desktop_thread_id && current.desktop_thread_id === s.threadId);
    const subscribed = isNotificationSubscribed(store,address,s.threadId);
    const buttons: InlineButton[] = [];
    if (!isCurrent || options.pendingId) buttons.push({ text: options.pendingId ? '在此会话继续原消息' : '绑定此会话', callbackData: encodeSessionAction(address, s.sessionId ? { kind: 'resume', sessionId: s.sessionId, pendingId: options.pendingId } : { kind: 'enter', threadId: s.threadId, pendingId: options.pendingId }) });
    buttons.push({ text: subscribed ? '取消订阅' : '开启订阅', callbackData: encodeSessionAction(address, { kind: 'subscribe', threadId: s.threadId, enabled: !subscribed, offset, view, pendingId: options.pendingId }) });
    buttons.push({ text: '会话详情', callbackData: encodeSessionAction(address, { kind: 'detail', threadId: s.threadId }) });
    const activity = s.lastEventAt && Number.isFinite(Date.parse(s.lastEventAt)) ? new Date(s.lastEventAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无记录';
    const project = path.basename(s.cwd || '') || '未指定目录';
    const title = s.title.replace(/[\r\n]/g, ' ').slice(0, 100) || '未命名会话';
    const origin = s.sessionId && s.sessionId === s.threadId ? 'IM 会话' : '桌面会话';
    return { text: `**📁 项目：${project}**${isCurrent ? ' ✅ 当前绑定' : ''}\n名称：${title}\n路径：\`${s.cwd || '未指定'}\`\n来源：${origin}\n订阅：${subscribed ? '🔔 已订阅' : '未订阅'}\n最近活动：${activity}`, buttons };
  });
  sections.push({ text: rows.length ? `分页：第 ${offset + 1}–${offset + rows.length} / ${filtered.length} 条 · 按最近活动倒序` : view === 'subscribed' ? '尚无可用订阅。到最近或全部会话中添加。' : '暂时没有可选会话。', buttons: [] });
  const buttons: InlineButton[][] = [[...(['recent','all','subscribed'] as PickerView[]).filter(v => v !== view).map(v => ({ text: v === 'recent' ? '最近活跃' : v === 'all' ? '全部会话' : '我的订阅', callbackData: encodeSessionAction(address, { kind: 'list', offset: 0, view: v, pendingId: options.pendingId }) }))]];
  const pagination: InlineButton[] = [];
  if (offset > 0) pagination.push({ text: '上一页', callbackData: encodeSessionAction(address, { kind: 'list', offset: Math.max(0, offset-size), view, pendingId: options.pendingId }) });
  if (view !== 'recent' && offset + rows.length < filtered.length) pagination.push({ text: '下一页', callbackData: encodeSessionAction(address, { kind: 'list', offset: offset+size, view, pendingId: options.pendingId }) });
  if (pagination.length) buttons.push(pagination);
  buttons.push([{ text: '新建会话', callbackData: encodeSessionAction(address, { kind: 'new', pendingId: options.pendingId }) }]);
  return { text, sections, inlineButtons: [...sections.filter(s=>s.buttons.length).map(s=>s.buttons), ...buttons], navigationButtons: buttons, card: { title: '会话中心', template: 'turquoise', note: '每条依次为 项目 / 名称 / 路径 / 来源 / 订阅 / 最近活动。' } satisfies CardChrome };
}

export async function sendSessionPicker(adapter: BaseChannelAdapter, address: ChannelAddress, options: PickerOptions = {}): Promise<void> {
  const picker = buildSessionPicker(address, selectableSessions(), options);
  const result = await deliver(adapter, { address, text: picker.text, inlineButtons: picker.navigationButtons, sections: picker.sections, sessionPicker: options, cardChrome: picker.card, parseMode: 'Markdown' });
  if (!result.ok) throw new Error(result.error || '会话选择卡片发送失败');
}

// ── New session: directory picker ─────────────────────────────

function isExistingDirectory(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function listChildDirectories(root: string, limit: number): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && !DIR_SCAN_EXCLUDES.has(entry.name))
    .map(entry => {
      const full = path.join(root, entry.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* unreadable entry keeps mtime 0 */ }
      return { full, mtime, name: entry.name };
    })
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(entry => entry.full);
}

/** Candidate working directories for a new session: current, recent session dirs, workspace root children, root. */
export function selectableDirectories(address: ChannelAddress, limit = DIR_LIST_LIMIT): string[] {
  const { store } = getBridgeContext();
  const seen = new Set<string>();
  const dirs: string[] = [];
  const add = (raw: string | null | undefined, requireExisting: boolean): void => {
    if (!raw) return;
    let resolved: string;
    try { resolved = path.resolve(raw); } catch { return; }
    const validated = validateWorkingDirectory(resolved);
    if (!validated || seen.has(validated)) return;
    if (requireExisting && !isExistingDirectory(validated)) return;
    seen.add(validated);
    dirs.push(validated);
  };
  const binding = store.getChannelBinding(address.channelType, address.chatId);
  const currentSession = binding ? store.getSession(binding.codepilotSessionId) : null;
  add(currentSession?.working_directory || binding?.workingDirectory, false);
  for (const session of selectableSessions()) add(session.cwd, true);
  const root = getWorkspaceRoot();
  add(root, false);
  for (const child of listChildDirectories(path.resolve(root), DIR_SCAN_LIMIT)) add(child, true);
  return dirs.slice(0, limit);
}

/** Directory picker shown before `/new` creates a session. */
export function buildDirectoryPicker(address: ChannelAddress, dirs: string[], options: DirPickerOptions = {}) {
  const { store } = getBridgeContext();
  const pendingId = options.pendingId;
  const offset = Math.min(options.offset || 0, Math.max(0, Math.floor((dirs.length - 1) / DIR_PAGE_SIZE) * DIR_PAGE_SIZE));
  const rows = dirs.slice(offset, offset + DIR_PAGE_SIZE);
  const binding = store.getChannelBinding(address.channelType, address.chatId);
  const currentDir = binding ? (store.getSession(binding.codepilotSessionId)?.working_directory || binding.workingDirectory) : '';
  let resolvedCurrent = '';
  try { resolvedCurrent = currentDir ? path.resolve(currentDir) : ''; } catch { resolvedCurrent = ''; }
  const text = `选择要在哪个目录下新建会话。\n默认工作空间：\`${getWorkspaceRoot()}\`` + (options.pendingId ? '\n选定目录后，之前保留的消息会自动继续。' : '');
  const sections = rows.map(dir => ({
    text: `**📁 目录：${path.basename(dir) || dir}**${resolvedCurrent && resolvedCurrent === dir ? ' ✅ 当前会话目录' : ''}\n路径：\`${dir}\``,
    buttons: [{ text: '在此目录新建', callbackData: encodeSessionAction(address, { kind: 'newdir', dir, pendingId }) }] as InlineButton[],
  }));
  sections.push({ text: rows.length ? `分页：第 ${offset + 1}–${offset + rows.length} / ${dirs.length} 个目录` : '没有可选目录，可直接发送 `/new 项目名`。', buttons: [] as InlineButton[] });
  const buttons: InlineButton[][] = [];
  const pagination: InlineButton[] = [];
  if (offset > 0) pagination.push({ text: '上一页', callbackData: encodeSessionAction(address, { kind: 'newpick', offset: Math.max(0, offset - DIR_PAGE_SIZE), pendingId }) });
  if (offset + rows.length < dirs.length) pagination.push({ text: '下一页', callbackData: encodeSessionAction(address, { kind: 'newpick', offset: offset + DIR_PAGE_SIZE, pendingId }) });
  if (pagination.length) buttons.push(pagination);
  buttons.push([{ text: '返回会话列表', callbackData: encodeSessionAction(address, { kind: 'list', offset: 0, view: 'recent', pendingId }) }]);
  return { text, sections, navigationButtons: buttons, card: { title: '新建会话 · 选择目录', template: 'green', note: '没有想要的目录？发送 `/new 项目名`（在默认工作空间内创建）或 `/new 绝对路径`。' } satisfies CardChrome };
}

export async function sendDirectoryPicker(adapter: BaseChannelAdapter, address: ChannelAddress, options: DirPickerOptions = {}): Promise<void> {
  const picker = buildDirectoryPicker(address, selectableDirectories(address), options);
  const result = await deliver(adapter, { address, text: picker.text, inlineButtons: picker.navigationButtons, sections: picker.sections, dirPicker: options, cardChrome: picker.card, parseMode: 'Markdown' });
  if (!result.ok) throw new Error(result.error || '目录选择卡片发送失败');
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
  ]];
}

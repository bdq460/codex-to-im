import crypto from 'node:crypto';
import path from 'node:path';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { ChannelAddress, InlineButton } from './types.js';
import { deliver } from './delivery-layer.js';
import { getDisplayedDesktopThreads, getWorkspaceRoot } from './bridge-session-support.js';

const key = crypto.randomBytes(32);
const TTL = 30 * 60_000;
const PAGE_SIZE = 6;
export type SessionAction = { kind: 'enter'; threadId: string } | { kind: 'list'; offset: number } | { kind: 'new' };

export function encodeSessionAction(address: ChannelAddress, action: SessionAction, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ channel: address.channelType, chat: address.chatId, action, expires: now + TTL })).toString('base64url');
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
    if (a?.kind === 'enter' && typeof a.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.threadId)) return a;
    if (a?.kind === 'list' && Number.isInteger(a.offset) && a.offset >= 0 && a.offset < 200) return a;
    return a?.kind === 'new' ? { kind: 'new' } : null;
  } catch { return null; }
}

export function buildSessionPicker(address: ChannelAddress, sessions: Array<{ threadId: string; title: string; cwd: string }>, options: { unbound?: boolean; offset?: number; recent?: boolean } = {}) {
  const offset = options.offset || 0;
  const rows = sessions.slice(offset, offset + (options.recent ? 3 : PAGE_SIZE));
  const text = [
    options.unbound ? '**当前未进入会话**' : '**选择会话**',
    options.unbound ? '这条消息尚未执行。请新建会话或选择已有会话，进入后再发送任务。' : '点击会话按钮即可在本聊天继续。',
    ...rows.map((s, i) => `${offset + i + 1}. ${s.title.replace(/[\r\n]/g, ' ').slice(0, 100)}\n   项目：${path.basename(s.cwd)}`),
    rows.length ? `显示 ${offset + 1}–${offset + rows.length}，共 ${sessions.length} 条。` : '暂时没有可选的桌面会话。',
    '按钮失效时发送 `/t` 刷新；也可用 `/thread <完整线程 ID>` 选择。',
  ].join('\n\n');
  const buttons: InlineButton[][] = rows.map(s => [{ text: `进入 ${s.title.replace(/[\r\n]/g, ' ').slice(0, 36)}`, callbackData: encodeSessionAction(address, { kind: 'enter', threadId: s.threadId }) }]);
  const navigation: InlineButton[] = [];
  if (offset > 0) navigation.push({ text: '上一页', callbackData: encodeSessionAction(address, { kind: 'list', offset: Math.max(0, offset - PAGE_SIZE) }) });
  if (!options.recent && offset + rows.length < sessions.length) navigation.push({ text: '下一页', callbackData: encodeSessionAction(address, { kind: 'list', offset: offset + PAGE_SIZE }) });
  if (options.recent) navigation.push({ text: '展开全部会话', callbackData: encodeSessionAction(address, { kind: 'list', offset: 0 }) });
  if (navigation.length) buttons.push(navigation);
  buttons.push([{ text: '新建会话', callbackData: encodeSessionAction(address, { kind: 'new' }) }]);
  return { text, inlineButtons: buttons };
}

export async function sendSessionPicker(adapter: BaseChannelAdapter, address: ChannelAddress, options: { unbound?: boolean; offset?: number; recent?: boolean } = {}): Promise<void> {
  const sessions = getDisplayedDesktopThreads(200);
  if (!sessions) throw new Error('读取会话列表失败，请发送 /t 重试。');
  const offset = Math.min(options.offset || 0, Math.max(0, Math.floor((sessions.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const picker = buildSessionPicker(address, sessions, { ...options, offset });
  const result = await deliver(adapter, { address, ...picker, parseMode: 'Markdown' });
  if (!result.ok) throw new Error(result.error || '会话选择卡片发送失败');
}

export function newSessionCommand(): string {
  return `/new ${path.join(getWorkspaceRoot(), `im-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`)}`;
}

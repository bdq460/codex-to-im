import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from '../../config.js';
import { withFileLock } from '../../file-lock.js';
import { atomicWriteFileSync } from '../../atomic-file.js';
import type { BridgeStore } from './host.js';
import type { ChannelAddress } from './types.js';

export type NotificationSubscription = { id: string; channelType: string; chatId: string; userId?: string; sessionId: string; since: string; lastDeliveredAt?: string };
type Rule = { excluded: string[]; userId?: string };
type Data = { chats: Record<string, NotificationSubscription[]>; rules?: Record<string, Rule> };
const file = path.join(CTI_HOME, 'data', 'notification-subscriptions.json');
const key = (a: Pick<ChannelAddress, 'channelType' | 'chatId'>) => JSON.stringify([a.channelType, a.chatId]);
function read(): Data {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { chats: {} }; throw error; }
}
function mutate<T>(fn: (data: Data) => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => { const data = read(); const before = JSON.stringify(data); const result = fn(data); if (JSON.stringify(data) !== before) { atomicWriteFileSync(file, JSON.stringify(data)); fs.chmodSync(file, 0o600); } return result; });
}
function legacy(store: BridgeStore, address: ChannelAddress): NotificationSubscription[] {
  const b = store.getChannelBinding(address.channelType, address.chatId);
  const s = b && store.getSession(b.codepilotSessionId);
  return b && b.active !== false && s && s.session_type !== 'draft' ? [{ id: b.id, channelType: b.channelType, chatId: b.chatId, userId: b.chatUserId, sessionId: s.id, since: s.mirror_last_event_at || '' }] : [];
}
/** Read-only fallback preserves existing behavior until the first explicit change. */
export function listChatSubscriptions(store: BridgeStore, address: ChannelAddress): NotificationSubscription[] {
  return read().chats[key(address)] ?? legacy(store, address);
}
/** Freeze the previous subscription set before changing the sending binding. */
export function initializeChatSubscriptions(store: BridgeStore, address: ChannelAddress): void {
  const defaults = legacy(store,address);
  if (!defaults.length) return;
  mutate(data => { data.chats[key(address)] ??= defaults.map(r => ({...r, since:r.since || new Date().toISOString()})); });
}
export function setNotificationSubscription(store: BridgeStore, address: ChannelAddress, sessionId: string, enabled: boolean): void {
  const session = store.getSession(sessionId);
  if (enabled && (!session || session.hidden || session.parent_session_id || session.session_type === 'draft' || (session.expires_at && Date.parse(session.expires_at) <= Date.now()))) throw new Error('会话不可用，请刷新会话列表。');
  mutate(data => {
    const rules = data.rules ??= {};
    const rule = rules[key(address)] ??= {excluded:[],userId:address.userId};
    if (address.userId) rule.userId = address.userId;
    const target = session?.desktop_thread_id || sessionId;
    rule.excluded = enabled ? rule.excluded.filter(id=>id !== target) : [...new Set([...rule.excluded,target])];
    const rows = data.chats[key(address)] ??= legacy(store, address);
    const existing = rows.find(r => r.sessionId === sessionId);
    if (enabled && !existing) {
      rows.push({ id: `notify:${crypto.randomUUID()}`, channelType: address.channelType, chatId: address.chatId, userId: address.userId, sessionId, since: new Date().toISOString() });
    } else if (!enabled) data.chats[key(address)] = rows.filter(r => r.sessionId !== sessionId);
  });
}
export function notificationBindings(store: BridgeStore) {
  const data = read();
  const rows = Object.values(data.chats).flat();
  for (const b of store.listChannelBindings()) if (b.active !== false && !(key(b) in data.chats)) rows.push(...legacy(store, b));
  return rows.flatMap(r => {
    const s = store.getSession(r.sessionId);
    if (!s || s.hidden || s.parent_session_id || s.session_type === 'draft' || (s.expires_at && Date.parse(s.expires_at) <= Date.now())) return [];
    return [{ id: r.id, channelType: r.channelType, chatId: r.chatId, chatUserId: r.userId, codepilotSessionId: r.sessionId, sdkSessionId: s.desktop_thread_id || s.sdk_session_id || '', lastDeliveredAt: r.lastDeliveredAt || r.since, active: true }];
  });
}
export function checkpointNotification(id: string, timestamp: string): void {
  mutate(data => { const row = Object.values(data.chats).flat().find(r => r.id === id); if (row && (!row.lastDeliveredAt || timestamp > row.lastDeliveredAt)) row.lastDeliveredAt = timestamp; });
}
export function notificationChatAddresses(store: BridgeStore): ChannelAddress[] {
  const addresses = new Map<string, ChannelAddress>();
  for (const b of store.listChannelBindings()) addresses.set(key(b), { channelType:b.channelType, chatId:b.chatId, userId:b.chatUserId });
  for (const [k, rows] of Object.entries(read().chats)) {
    if (addresses.has(k)) continue;
    const [channelType, chatId] = JSON.parse(k) as [string,string];
    addresses.set(k, {channelType,chatId,userId:rows[0]?.userId || read().rules?.[k]?.userId});
  }
  return [...addresses.values()];
}

export function notificationPolicy(address: ChannelAddress) {
  return { automatic: true as const, excluded: read().rules?.[key(address)]?.excluded || [] };
}
export function isNotificationSubscribed(store: BridgeStore, address: ChannelAddress, targetId: string): boolean {
  const session = store.getSession(targetId) || store.findSessionBySdkSessionId(targetId);
  return !notificationPolicy(address).excluded.includes(session?.desktop_thread_id || targetId);
}
/** Runtime reconciliation only: reads and health endpoints never discover or write targets. */
export function reconcileNotificationTargets(store: BridgeStore, addresses: ChannelAddress[], sessionIds: string[]): void {
  mutate(data => {
    const rules = data.rules ??= {};
    for (const address of addresses) {
      const scope = key(address);
      const rule = rules[scope] ??= {excluded:[],userId:address.userId};
      if (address.userId) rule.userId = address.userId;
      const eligible = sessionIds.filter(id => { const session=store.getSession(id);return session && !rule.excluded.includes(session.desktop_thread_id || id); });
      const ids = new Set(eligible);
      const rows = (data.chats[scope] ?? legacy(store,address)).filter(r=>ids.has(r.sessionId));
      const existing = new Set(rows.map(r=>r.sessionId));
      for (const sessionId of eligible) if (!existing.has(sessionId)) rows.push({id:`notify:${crypto.randomUUID()}`,channelType:address.channelType,chatId:address.chatId,userId:rule.userId,sessionId,since:new Date().toISOString()});
      data.chats[scope] = rows;
    }
  });
}

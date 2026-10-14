import { listDesktopSessions, isArchivedDesktopThread, type DesktopSessionSummary } from '../../desktop-sessions.js';
import { ensureDesktopBridgeSession } from '../../session-bindings.js';
import { reconcileNotificationTargets } from './notification-subscriptions.js';
import type { BridgeStore } from './host.js';
import type { ChannelAddress } from './types.js';

export function syncAutomaticNotifications(store: BridgeStore, addresses: ChannelAddress[], discover: () => DesktopSessionSummary[] = listDesktopSessions, archived: (id:string)=>boolean = isArchivedDesktopThread): void {
  if (!addresses.length) return;
  const desktop = discover();
  for (const d of desktop) {
    const existing = store.findSessionBySdkSessionId(d.threadId);
    if (!existing || (existing.desktop_thread_id !== d.threadId || existing.thread_origin !== 'desktop')) ensureDesktopBridgeSession(store,d.threadId,{workingDirectory:d.cwd,displayName:d.title});
  }
  const sessions = store.listSessions().filter(s => !s.hidden && !s.parent_session_id && s.session_type !== 'draft'
    && (!s.expires_at || Date.parse(s.expires_at)>Date.now())
    && (s.thread_origin !== 'desktop' || !archived(s.desktop_thread_id || s.sdk_session_id || '')));
  reconcileNotificationTargets(store,addresses,sessions.map(s=>s.id));
}

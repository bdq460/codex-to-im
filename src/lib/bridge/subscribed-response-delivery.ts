import type { BaseChannelAdapter } from './channel-adapter.js';
import type { BridgeStore } from './host.js';
import type { ChannelAddress } from './types.js';
import type { FinalizedBridgeResponse } from './turns/turn-types.js';
import { notificationBindings } from './notification-subscriptions.js';
import { deliverResponse } from './feedback-delivery.js';

/** The requester always receives its answer; subscriptions only add other destinations. */
export async function deliverSubscribedResponse(store: BridgeStore, origin: ChannelAddress, sessionId: string, response: FinalizedBridgeResponse, getAdapter: (channel: string) => BaseChannelAdapter | null, send = deliverResponse): Promise<void> {
  const targets = notificationBindings(store).filter(b => b.codepilotSessionId === sessionId && !(b.channelType === origin.channelType && b.chatId === origin.chatId));
  const title = (store.getSession(sessionId)?.name || '未命名会话').replace(/[\r\n]/g, ' ');
  for (let offset = 0; offset < targets.length; offset += 4) {
    await Promise.all(targets.slice(offset, offset + 4).map(async b => {
      const adapter = getAdapter(b.channelType);
      if (!adapter || !adapter.isAuthorized(b.chatUserId || '', b.chatId)) return;
      try {
        const result = await send(adapter, { channelType: b.channelType, chatId: b.chatId }, `会话「${title}」的新结果\n\n${response.text}`, sessionId, undefined, response.attachments);
        if (!result.ok) console.warn('[bridge-manager] Subscribed result delivery failed:', result.error || 'no receipt');
      } catch(error) { console.warn('[bridge-manager] Subscribed result delivery failed:', error instanceof Error ? error.message : String(error)); }
    }));
  }
}

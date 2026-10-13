import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from '../../config.js';
import { withFileLock } from '../../file-lock.js';
import { atomicWriteFileSync } from '../../atomic-file.js';
import type { InboundMessage, ChannelAddress } from './types.js';

const file = path.join(CTI_HOME, 'data', 'session-interactions.json');
const secretFile = path.join(CTI_HOME, 'data', 'session-navigation.key');
const scope = (a: Pick<ChannelAddress, 'channelType' | 'chatId'>, id: string) => JSON.stringify([a.channelType, a.chatId, id]);
type Pending = { message: InboundMessage; status: 'waiting' | 'processing' | 'done'; createdAt: number };
type Data = { refs: Record<string, string>; pending: Record<string, Pending> };
function read(): Data {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { refs: {}, pending: {} }; throw error; }
}
function mutate<T>(fn: (data: Data) => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => {
    const data = read();
    for (const [k, p] of Object.entries(data.pending)) {
      if (Date.now() - p.createdAt > 24 * 60 * 60_000) delete data.pending[k];
    }
    const result = fn(data);
    atomicWriteFileSync(file, JSON.stringify(data)); fs.chmodSync(file, 0o600);
    return result;
  });
}
export function navigationSecret(): Buffer {
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  return withFileLock(secretFile, () => {
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 });
    return fs.readFileSync(secretFile);
  });
}
export function rememberSessionMessage(address: Pick<ChannelAddress, 'channelType' | 'chatId'>, messageId: string, sessionId: string): void {
  mutate(data => { data.refs[scope(address, messageId)] = sessionId; });
}
export function sessionForMessage(address: ChannelAddress, messageId: string): string | null {
  return read().refs[scope(address, messageId)] || null;
}
export function savePendingMessage(message: InboundMessage): string {
  const id = message.messageId;
  mutate(data => {
    const k = scope(message.address, id);
    if (!data.pending[k]) data.pending[k] = {
      message: { messageId: id, address: message.address, text: message.text, timestamp: message.timestamp, attachments: message.attachments },
      status: 'waiting', createdAt: Date.now(),
    };
  });
  return id;
}
export function getPendingMessage(address: ChannelAddress, id: string): Pending | null {
  const p = read().pending[scope(address, id)];
  if (!p || p.message.address.userId !== address.userId || Date.now() - p.createdAt > 24 * 60 * 60_000) return null;
  return p;
}
export function claimPendingMessage(address: ChannelAddress, id: string): InboundMessage | null {
  return mutate(data => {
    const p = data.pending[scope(address, id)];
    if (!p || p.status !== 'waiting' || p.message.address.userId !== address.userId || Date.now() - p.createdAt > 24 * 60 * 60_000) return null;
    p.status = 'processing'; return p.message;
  });
}
export function finishPendingMessage(address: ChannelAddress, id: string): void {
  mutate(data => { const p = data.pending[scope(address, id)]; if (p) { p.status = 'done'; p.message.text = ''; delete p.message.attachments; } });
}

export function releasePendingMessage(address: ChannelAddress, id: string): void {
  mutate(data => { const p = data.pending[scope(address, id)]; if (p?.status === 'processing') p.status = 'waiting'; });
}

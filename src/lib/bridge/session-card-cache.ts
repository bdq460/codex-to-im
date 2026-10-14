import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from '../../config.js';
import { atomicWriteFileSync } from '../../atomic-file.js';
import type { OutboundMessage } from './types.js';
export type SessionCardReference = { chatId: string; message?: OutboundMessage; sessionId?: string; baseJson?: string; cardId?: string; sequence?: number };
const file = (channel: string) => path.join(CTI_HOME, 'data', 'session-cards', crypto.createHash('sha256').update(channel).digest('hex') + '.json');
export function loadSessionCards(channel: string): Map<string, SessionCardReference> {
  try { return new Map(JSON.parse(fs.readFileSync(file(channel),'utf8'))); }
  catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[feishu-adapter] Session card cache unreadable; fresh cards will rebuild it.'); return new Map(); }
}
export function saveSessionCards(channel: string, cards: Map<string, SessionCardReference>): void {
  try { const target=file(channel);fs.mkdirSync(path.dirname(target),{recursive:true});atomicWriteFileSync(target,JSON.stringify([...cards]));fs.chmodSync(target,0o600); }
  catch { console.warn('[feishu-adapter] Session card cache could not be saved.'); }
}

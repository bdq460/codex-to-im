import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CTI_HOME } from './config.js';
import { withFileLock } from './file-lock.js';
import { FEISHU_REFERENCE_PROFILE } from './feishu-reference-profile.js';
import type { FeishuAppProfile } from './feishu-app-profile.js';

export const FEISHU_TEMPLATE_PATH = path.join(CTI_HOME, 'feishu-bot-template.json');
export type FeishuTemplate = { revision: string; savedAt: string | null; profile: FeishuAppProfile };
export class FeishuTemplateError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export function normalizeFeishuTemplate(value: unknown): FeishuAppProfile {
  const p = value as Partial<FeishuAppProfile> | null;
  if (!p || typeof p !== 'object' || p.eventTransport !== 'websocket' || p.callbackTransport !== 'websocket') throw new FeishuTemplateError('事件与回调接收方式必须为长连接。');
  const names = (input: unknown, limit: number): string[] => {
    if (!Array.isArray(input) || input.length > limit || input.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(n))) throw new FeishuTemplateError('配置名称格式无效，须逐行填写权限或事件标识。');
    return [...new Set(input as string[])];
  };
  const scopes = { tenant: names(p.scopes?.tenant, 2000), user: names(p.scopes?.user, 2000) };
  const events = names(p.events, 200), callbacks = names(p.callbacks, 200);
  if (!scopes.tenant.includes('im:message:readonly') || !scopes.tenant.includes('im:message:send_as_bot') || !events.includes('im.message.receive_v1') || !callbacks.includes('card.action.trigger')) throw new FeishuTemplateError('请保留消息接收、机器人发送权限、消息事件与卡片回调，确保会话交互可用。');
  return { referenceVersion: FEISHU_REFERENCE_PROFILE.referenceVersion, capturedAt: FEISHU_REFERENCE_PROFILE.capturedAt, scopes, events, callbacks, eventTransport: 'websocket', callbackTransport: 'websocket' };
}
export function readFeishuTemplate(file = FEISHU_TEMPLATE_PATH): FeishuTemplate {
  if (!fs.existsSync(file)) return { revision: 'reference', savedAt: null, profile: structuredClone(FEISHU_REFERENCE_PROFILE) };
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as FeishuTemplate;
  if (typeof data.revision !== 'string' || typeof data.savedAt !== 'string') throw new FeishuTemplateError('模板文件损坏，请检查本地配置文件。', 500);
  return { revision: data.revision, savedAt: data.savedAt, profile: normalizeFeishuTemplate(data.profile) };
}
export function saveFeishuTemplate(profile: unknown, revision: unknown, file = FEISHU_TEMPLATE_PATH): FeishuTemplate {
  const normalized = normalizeFeishuTemplate(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => {
    if (revision !== readFeishuTemplate(file).revision) throw new FeishuTemplateError('模板已在其他窗口更新，请重新加载后再保存。', 409);
    const result = { revision: crypto.randomUUID(), savedAt: new Date().toISOString(), profile: normalized };
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return result;
  });
}

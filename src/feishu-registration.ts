import { registrationPresetUrl, inspectFeishuConfiguration, type FeishuConfigurationReport } from './feishu-app-profile.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { FeishuSite } from './config.js';

type RegistrationResponse = {
  error?: string; device_code?: string; verification_uri_complete?: string;
  interval?: number; expire_in?: number; expires_in?: number;
  client_id?: string; client_secret?: string; user_info?: { open_id?: string; tenant_brand?: string };
};
type Credentials = { appId: string; appSecret: string; site: FeishuSite; ownerId?: string };
type Options = { alias: string; site: FeishuSite; save: (credentials: Credentials) => Promise<void> };
type Session = Options & { id: string; deviceCode: string; qrSvg: string; verificationUrl: string; expiresAt: number; interval: number; nextPollAt: number; status: 'waiting' | 'confirmed' | 'expired' | 'denied' | 'failed'; message: string; configuration?: FeishuConfigurationReport; inFlight?: Promise<void> };
const bases = { feishu: 'https://accounts.feishu.cn', lark: 'https://accounts.larksuite.com' };
export async function registrationCall(site: FeishuSite, action: string, params: Record<string, string> = {}): Promise<RegistrationResponse> {
  const response = await fetch(`${bases[site]}/oauth/v1/app/registration`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action, ...params }), signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as RegistrationResponse;
  if (!response.ok && !data.error) throw new Error('飞书授权服务暂不可用，请重试或使用手动配置。');
  return data;
}
export class FeishuRegistration {
  private sessions = new Map<string, Session>();
  constructor(private call = registrationCall, private now = Date.now, private inspect = inspectFeishuConfiguration) {}
  private view(s: Session) {
    return { id: s.id, qrSvg: s.qrSvg, verificationUrl: s.verificationUrl, expiresAt: s.expiresAt, interval: s.interval, status: s.status, message: s.message, configuration: s.configuration };
  }
  async begin(options: Options) {
    for (const [id, s] of this.sessions) if (s.expiresAt < this.now()) this.sessions.delete(id);
    if (this.sessions.size >= 20) throw new Error('扫码会话过多，请关闭不用的扫码窗口后重试。');
    const init = await this.call(options.site, 'init');
    if (init.error) throw new Error('飞书扫码初始化失败，请重试或使用手动配置。');
    const data = await this.call(options.site, 'begin', { archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' });
    if (data.error || !data.device_code || !data.verification_uri_complete) throw new Error('飞书扫码入口暂不可用，请重试或使用手动配置。');
    const url = new URL(data.verification_uri_complete);
    if (url.protocol !== 'https:' || !['feishu.cn', 'larksuite.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('飞书返回了无效授权地址。');
    const configuredUrl = registrationPresetUrl(url, options.alias);
    const session: Session = { ...options, id: crypto.randomUUID(), deviceCode: data.device_code,
      qrSvg: await QRCode.toString(configuredUrl.href, { type: 'svg', width: 256 }), verificationUrl: configuredUrl.href,
      expiresAt: this.now() + Math.min(1800, Math.max(60, data.expire_in || data.expires_in || 600)) * 1000,
      interval: Math.min(30, Math.max(2, data.interval || 5)), nextPollAt: 0, status: 'waiting', message: '请用飞书扫码，在手机上确认创建与授权。' };
    this.sessions.set(session.id, session); return this.view(session);
  }
  cancel(id: string) { this.sessions.delete(id); }
  async poll(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('扫码会话不存在或已关闭，请重新生成二维码。');
    if (s.expiresAt <= this.now() && s.status === 'waiting') { s.status = 'expired'; s.message = '二维码已过期，请重新生成。'; }
    if (s.status !== 'waiting' || s.nextPollAt > this.now()) return this.view(s);
    if (s.inFlight) { await s.inFlight; return this.view(s); }
    s.inFlight = this.advance(s);
    try { await s.inFlight; } finally { s.inFlight = undefined; }
    return this.view(s);
  }
  private async advance(s: Session) {
    s.nextPollAt = this.now() + s.interval * 1000;
    const data = await this.call(s.site, 'poll', { device_code: s.deviceCode });
    if (!this.sessions.has(s.id)) return;
    if (data.user_info?.tenant_brand === 'lark' && s.site !== 'lark') { s.site = 'lark'; s.nextPollAt = 0; return; }
    if (typeof data.client_id === 'string' && data.client_id && typeof data.client_secret === 'string' && data.client_secret) {
      try {
        await s.save({ appId: data.client_id, appSecret: data.client_secret, site: s.site, ownerId: data.user_info?.open_id });
        s.status = 'confirmed'; s.deviceCode = ''; s.configuration = await this.inspect({ appId: data.client_id, appSecret: data.client_secret, site: s.site });
        s.message = '飞书通道已保存。' + s.configuration.message;
      } catch { s.status = 'failed'; s.message = '授权已完成，但本地保存失败。请重新扫码或手动配置，避免重复创建机器人。'; }
      return;
    }
    switch (data.error) {
      case 'authorization_pending': case undefined: return;
      case 'slow_down': s.interval = Math.min(30, s.interval + 5); s.nextPollAt = this.now() + s.interval * 1000; return;
      case 'access_denied': s.status = 'denied'; s.message = '已取消授权，可以重新扫码或手动配置。'; return;
      case 'expired_token': s.status = 'expired'; s.message = '二维码已过期，请重新生成。'; return;
      default: s.status = 'failed'; s.message = '飞书授权未完成，请重新扫码或使用手动配置。';
    }
  }
}

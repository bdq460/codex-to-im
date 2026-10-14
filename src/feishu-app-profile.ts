import { gzipSync } from 'node:zlib';
import { feishuSiteToApiBaseUrl, type FeishuChannelConfig } from './config.js';
import { FEISHU_REFERENCE_PROFILE } from './feishu-reference-profile.js';
export type FeishuAppProfile = {
  referenceVersion: string; capturedAt: string;
  scopes: { tenant: string[]; user: string[] };
  events: string[]; callbacks: string[];
  eventTransport: 'websocket'; callbackTransport: 'websocket';
};
export type FeishuConfigurationReport = {
  status: 'ready' | 'needs_configuration' | 'needs_confirmation' | 'unverified';
  message: string; referenceVersion: string; version?: string; managementUrl?: string;
  checks: Array<{ label: string; status: 'pass' | 'missing' | 'unknown'; detail: string }>;
  missingScopes: string[]; ungrantedScopes?: string[]; missingEvents: string[]; missingCallbacks: string[];
};
/** Matches the official registration SDK's gzip + base64url addons encoding. */
export function registrationPresetUrl(input: URL, alias: string, profile = FEISHU_REFERENCE_PROFILE): URL {
  const url = new URL(input);
  const addons = { preset: false, scopes: profile.scopes, events: { items: { tenant: profile.events } }, callbacks: { items: profile.callbacks } };
  url.searchParams.set('addons', gzipSync(Buffer.from(JSON.stringify(addons))).toString('base64url'));
  url.searchParams.set('createOnly', 'true');
  url.searchParams.delete('clientID');
  url.searchParams.set('name', alias);
  url.searchParams.set('desc', '通过 Codex to IM 继续会话、接收结果及处理交互卡片');
  url.searchParams.set('from', 'sdk'); url.searchParams.set('tp', 'sdk'); url.searchParams.set('source', 'codex-to-im');
  return url;
}
export type AppMetadata = { online_version_id?: string; event?: { subscription_type?: string; subscribed_events?: string[] }; callback?: { callback_type?: string; subscribed_callbacks?: string[] }; callback_info?: { callback_type?: string; subscribed_callbacks?: string[] } };
export type PublishedVersion = { version?: string; scopes?: Array<{ scope: string; token_types?: string[] }>; event_infos?: Array<{ event_type?: string }>; ability?: { bot?: unknown } };
export type ScopeGrant = { scope_name: string; scope_type?: string; grant_status: number };
export function compareFeishuConfiguration(app: AppMetadata, version: PublishedVersion | null, profile = FEISHU_REFERENCE_PROFILE, grants?: ScopeGrant[] | null): FeishuConfigurationReport {
  const scopeSet = new Set((version?.scopes || []).flatMap(s => (s.token_types || []).map(t => `${t}:${s.scope}`)));
  const eventSet = new Set((version?.event_infos || []).map(e => e.event_type));
  const callback = app.callback_info || app.callback;
  const callbackSet = new Set(callback?.subscribed_callbacks || []);
  const missingScopes = version?.scopes ? Object.entries(profile.scopes).flatMap(([identity, scopes]) => scopes.filter(s => !scopeSet.has(`${identity}:${s}`)).map(s => `${identity}:${s}`)) : [];
  const missingEvents = version?.event_infos ? profile.events.filter(e => !eventSet.has(e)) : [];
  const missingCallbacks = callback?.subscribed_callbacks ? profile.callbacks.filter(e => !callbackSet.has(e)) : [];
  const granted = new Set((grants || []).filter(s => s.grant_status === 1).map(s => `${s.scope_type}:${s.scope_name}`));
  const ungrantedScopes = grants ? Object.entries(profile.scopes).flatMap(([type, names]) => names.filter(name => !granted.has(`${type}:${name}`)).map(name => `${type}:${name}`)) : [];
  const checks: FeishuConfigurationReport['checks'] = [
    { label: '已发布版本', status: version ? 'pass' : 'missing', detail: version ? `版本 ${version.version || app.online_version_id}` : '尚无已发布版本，请到飞书后台发布。' },
    { label: '机器人能力', status: !version ? 'unknown' : version.ability?.bot ? 'pass' : 'missing', detail: !version ? '等待发布后回读' : version.ability?.bot ? '已开启' : '未开启机器人能力' },
    { label: '权限（按应用/用户身份）', status: !version?.scopes ? 'unknown' : missingScopes.length ? 'missing' : 'pass', detail: !version?.scopes ? '未能读取权限清单' : missingScopes.length ? `缺少 ${missingScopes.length} 项权限身份组合` : '参照权限均已包含' },
    { label: '租户授权', status: !grants ? 'unknown' : ungrantedScopes.length ? 'missing' : 'pass', detail: !grants ? '未能查询租户授权状态' : ungrantedScopes.length ? `有 ${ungrantedScopes.length} 项身份权限尚未授权` : '租户许可已授予；用户身份能力仍需各用户授权' },
    { label: '事件订阅', status: !version?.event_infos ? 'unknown' : missingEvents.length ? 'missing' : 'pass', detail: !version?.event_infos ? '未能读取已发布事件清单' : missingEvents.length ? `缺少 ${missingEvents.length} 个事件` : '参照事件均已包含' },
    { label: '卡片回调', status: !callback?.subscribed_callbacks ? 'unknown' : missingCallbacks.length ? 'missing' : 'pass', detail: !callback?.subscribed_callbacks ? '未能读取回调清单' : missingCallbacks.length ? `缺少 ${missingCallbacks.join('、')}` : '参照回调均已包含' },
    { label: '事件接收方式', status: !app.event?.subscription_type ? 'unknown' : app.event.subscription_type === profile.eventTransport ? 'pass' : 'missing', detail: !app.event?.subscription_type ? '平台未返回此字段，请确认使用长连接' : app.event.subscription_type === profile.eventTransport ? '长连接' : '请改为长连接' },
    { label: '回调接收方式', status: !callback?.callback_type ? 'unknown' : callback.callback_type === profile.callbackTransport ? 'pass' : 'missing', detail: !callback?.callback_type ? '平台未返回此字段，请确认使用长连接' : callback.callback_type === profile.callbackTransport ? '长连接' : '请改为长连接' },
  ];
  const status = checks.some(c => c.status === 'missing') ? 'needs_configuration' : checks.some(c => c.status === 'unknown') ? 'needs_confirmation' : 'ready';
  return { status, message: status === 'ready' ? '权限、事件及回调配置检查通过。' : status === 'needs_configuration' ? '通道已保存，但飞书配置尚未齐全。' : '可读取配置与参照相符，部分字段仍需到飞书确认。', referenceVersion: profile.referenceVersion, version: version?.version, checks, missingScopes, ungrantedScopes, missingEvents, missingCallbacks };
}
export async function inspectFeishuConfiguration(config: FeishuChannelConfig, request: typeof fetch = fetch, profile = FEISHU_REFERENCE_PROFILE): Promise<FeishuConfigurationReport> {
  const unknown = (message: string): FeishuConfigurationReport => ({ status: 'unverified', message, referenceVersion: profile.referenceVersion, checks: [], missingScopes: [], missingEvents: [], missingCallbacks: [], managementUrl: config.appId ? `https://${config.site === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'}/app/${encodeURIComponent(config.appId)}` : undefined });
  if (!config.appId || !config.appSecret) return unknown('请先保存有效的机器人凭据。');
  const base = feishuSiteToApiBaseUrl(config.site);
  try {
    const response = await request(`${base}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }), signal: AbortSignal.timeout(15_000) });
    const auth = await response.json() as { code?: number; tenant_access_token?: string };
    if (!response.ok || auth.code !== 0 || !auth.tenant_access_token) return unknown('凭据验证失败，未能检查飞书配置。');
    const get = async (path: string) => {
      const r = await request(`${base}${path}`, { headers: { Authorization: `Bearer ${auth.tenant_access_token}` }, signal: AbortSignal.timeout(15_000) });
      const data = await r.json() as { code?: number; data?: { app?: AppMetadata; app_version?: PublishedVersion; scopes?: ScopeGrant[] } };
      if (!r.ok || data.code !== 0) throw new Error('read unavailable'); return data.data;
    };
    const app = (await get(`/open-apis/application/v6/applications/${encodeURIComponent(config.appId)}?lang=zh_cn`))?.app;
    if (!app) return unknown('未能读取应用配置，请在飞书后台确认。');
    const version = app.online_version_id ? (await get(`/open-apis/application/v6/applications/${encodeURIComponent(config.appId)}/app_versions/${encodeURIComponent(app.online_version_id)}?lang=zh_cn`))?.app_version || null : null;
    let grants: ScopeGrant[] | null = null;
    try { grants = (await get('/open-apis/application/v6/scopes'))?.scopes || null; } catch { /* Unknown is shown, never treated as authorized. */ }
    return { ...compareFeishuConfiguration(app, version, profile, grants), managementUrl: `https://${config.site === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'}/app/${encodeURIComponent(config.appId)}` };
  } catch { return unknown('配置检查暂不可用，可能是网络或查询权限不足。请重试或打开飞书后台核对。'); }
}

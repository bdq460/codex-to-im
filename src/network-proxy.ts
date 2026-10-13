import { execFileSync } from 'node:child_process';

export function parseMacSystemProxy(output: string): string | null {
  const value = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm'))?.[1];
  const scheme = value('HTTPSEnable') === '1' ? 'HTTPS' : value('HTTPEnable') === '1' ? 'HTTP' : null;
  if (!scheme) return null;
  const host = value(`${scheme}Proxy`), port = value(`${scheme}Port`);
  if (!host || !port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  try { return new URL(`http://${host}:${port}`).origin; } catch { return null; }
}

/** Rust Codex children do not inherit macOS system proxy settings automatically. */
export function inheritSystemProxy(env: NodeJS.ProcessEnv = process.env, platform = process.platform, read = () => execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 })): boolean {
  if (platform !== 'darwin' || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy) return false;
  try {
    const proxy = parseMacSystemProxy(read());
    if (!proxy) return false;
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    if (!env.NO_PROXY && !env.no_proxy) env.NO_PROXY = 'localhost,127.0.0.1,::1';
    return true;
  } catch { return false; }
}

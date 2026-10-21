import { execFile } from 'node:child_process';
import process from 'node:process';

export type CmdResult = { code: number; stdout: string; stderr: string };
export type CmdRunner = (cmd: string, args: string[]) => Promise<CmdResult>;
export type QuitDesktopResult = { ok: boolean; alreadyClosed?: boolean; resurrected?: boolean; detail: string };

// The Codex desktop app ships inside ChatGPT.app (there is no standalone Codex.app):
// 1) host: /Applications/ChatGPT.app/Contents/Resources/codex-cli/... codex app-server
//    — the thread-writer holder. While it runs, IM-side thread/resume fails with
//    "thread-store conflict: ... already has an active writer" (code -32600) and every
//    bridged message dies with "Codex Exec exited with code 1" (observed in bridge.log).
// 2) UI helpers: /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/...
// Neither path matches the globally installed codex CLI this bridge spawns, so the
// patterns cannot misidentify (or kill) the bridge's own processes.
const DESKTOP_HOST_PATTERN = 'ChatGPT.app/Contents/Resources/codex-cli';
const DESKTOP_UI_PATTERN = 'Codex Framework.framework';
const PATTERNS = [DESKTOP_HOST_PATTERN, DESKTOP_UI_PATTERN] as const;

// Field-proven 2026-10-21: killing only the Codex process group is NOT enough — the
// ChatGPT main process relaunches the Codex desktop processes within seconds (new
// PIDs observed right after a "successful" group kill). Quitting the whole ChatGPT
// app is the only reliable path (same playbook Hermes validated in the field):
// graceful AppleScript quit → TERM → KILL, all scoped to ChatGPT.app. The bridge's
// own command lines never contain "ChatGPT.app", so the fallbacks stay safe.
const CHATGPT_APP_PATTERN = 'ChatGPT\\.app';

// Crash-pad handlers live under "Codex Framework.framework/.../Helpers/" and regularly
// outlive everything else. They hold no writer lock and self-resurrect via
// --monitor-self, so they never count as "the desktop is running" (probe results are
// filtered line-by-line); after a full quit we still sweep them once, best effort.
const CRASHPAD_MARKER = 'browser_crashpad_handler';
const CRASHPAD_SWEEP_PATTERN = 'browser_crashpad_handler.*ChatGPT\\.app|ChatGPT\\.app.*browser_crashpad_handler';

const defaultRunner: CmdRunner = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
    const err = error as (NodeJS.ErrnoException & { code?: number | string }) | undefined;
    const code = typeof err?.code === 'number' ? err.code : err ? 1 : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** pgrep -fl probe that ignores leftover crashpad handlers (unkillable, never lock-holding). */
async function probeAlive(runner: CmdRunner, pattern: string): Promise<boolean> {
  // pgrep excludes itself and execFile bypasses the shell, so the pattern cannot
  // match this daemon's own command line.
  const r = await runner('pgrep', ['-fl', pattern]);
  if (r.code !== 0) return false;
  const live = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.includes(CRASHPAD_MARKER));
  return live.length > 0;
}

/** Whether the ChatGPT main app process is alive (the desktop host that relaunches Codex). */
async function isChatGptAppRunning(runner: CmdRunner): Promise<boolean> {
  const r = await runner('pgrep', ['-x', 'ChatGPT']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export async function isCodexDesktopRunning(
  options: { platform?: NodeJS.Platform; runner?: CmdRunner } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  // Detection is macOS-only for now; other platforms report "not running" so the
  // guard never blocks messages there (existing behaviour is preserved).
  if (platform !== 'darwin') return false;
  const runner = options.runner ?? defaultRunner;
  // Interception stays narrow on purpose: only the lock-holding Codex processes count.
  // A background ChatGPT without Codex open holds no writer lock, so messages flow.
  for (const pattern of PATTERNS) {
    if (await probeAlive(runner, pattern)) return true;
  }
  return false;
}

export async function quitCodexDesktop(
  options: {
    platform?: NodeJS.Platform;
    runner?: CmdRunner;
    pollIntervalMs?: number;
    timeoutMs?: number;
    termTimeoutMs?: number;
    killTimeoutMs?: number;
    recheckDelayMs?: number;
  } = {},
): Promise<QuitDesktopResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: false, detail: '当前平台不支持自动关闭 Codex 桌面版，请手动关闭后重试' };
  }
  if (!(await isCodexDesktopRunning(options))) {
    return { ok: true, alreadyClosed: true, detail: 'Codex 桌面版未在运行' };
  }
  const runner = options.runner ?? defaultRunner;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const pollInterval = Math.max(pollIntervalMs, 1);

  // "Gone" means the whole host app exited — the Codex group AND the ChatGPT main
  // process. Anything less and ChatGPT relaunches Codex right back (field-proven).
  const allGone = async () =>
    !(await isCodexDesktopRunning(options)) && !(await isChatGptAppRunning(runner));

  const gone = async (budgetMs: number) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await sleep(pollInterval);
      if (await allGone()) return true;
    }
    return false;
  };

  // Step 1: graceful quit through the normal App exit path (saves state, no data
  // loss). -128 "user canceled" (system dialog steals focus) and other AppleScript
  // failures are tolerated: the poll below decides what really happened.
  await runner('osascript', ['-e', 'quit app "ChatGPT"']);
  if (await gone(options.timeoutMs ?? 15_000)) return sweepAndVerify();

  // Step 2: app ignored/hung after the graceful attempt → terminate the whole app.
  await runner('pkill', ['-TERM', '-f', CHATGPT_APP_PATTERN]);
  if (await gone(options.termTimeoutMs ?? 8_000)) return sweepAndVerify();

  // Step 3: last resort — force kill (may lose unsaved state).
  await runner('pkill', ['-KILL', '-f', CHATGPT_APP_PATTERN]);
  if (await gone(options.killTimeoutMs ?? 5_000)) return sweepAndVerify();
  return { ok: false, detail: 'ChatGPT/Codex 桌面进程无响应（已尝试强制结束），请手动关闭后重试' };

  async function sweepAndVerify(): Promise<QuitDesktopResult> {
    // Best-effort crashpad sweep (they self-resurrect; the probes ignore them anyway).
    await runner('pkill', ['-TERM', '-f', CRASHPAD_SWEEP_PATTERN]);
    // Final re-verify: Sparkle updaters / login items have been observed to relaunch
    // ChatGPT right after it dies. Detect that instead of replaying the message
    // into a still-locked thread.
    await sleep(options.recheckDelayMs ?? 1_500);
    if (await allGone()) {
      return { ok: true, detail: '已退出 ChatGPT 并关闭 Codex 桌面版' };
    }
    return {
      ok: false,
      resurrected: true,
      detail: 'ChatGPT 关闭后又被自动拉起（常见原因：更新器或登录项）。建议在 系统设置 → 登录项 中移除 ChatGPT 后重试',
    };
  }
}

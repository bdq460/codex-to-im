import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexDesktopRunning, quitCodexDesktop, type CmdRunner } from '../lib/bridge/desktop-app-control.js';

type ScriptedRunner = CmdRunner & { calls: string[] };
type PgResult = { code: number; stdout: string };

/**
 * Runner with separate answer queues:
 * - fl: results for `pgrep -fl <pattern>` probes (host / Codex UI), consumed in order
 * - x:  results for `pgrep -x ChatGPT` (main-app probes), consumed in order
 * Everything else (osascript / pkill) succeeds. Every call is recorded.
 */
function scriptedRunner(fl: PgResult[], x: PgResult[] = []): ScriptedRunner {
  const calls: string[] = [];
  let flIndex = 0;
  let xIndex = 0;
  const runner: CmdRunner = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'pgrep' && args[0] === '-fl') {
      const r = fl[Math.min(flIndex++, fl.length - 1)];
      return { ...r, stderr: '' };
    }
    if (cmd === 'pgrep' && args[0] === '-x') {
      const r = x[Math.min(xIndex++, x.length - 1)];
      return { ...r, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return Object.assign(runner, { calls });
}

const HOST_PROBE = 'pgrep -fl ChatGPT.app/Contents/Resources/codex-cli';
const UI_PROBE = 'pgrep -fl Codex Framework.framework';
const MAIN_PROBE = 'pgrep -x ChatGPT';
const QUIT_CALL = 'osascript -e quit app "ChatGPT"';
const TERM_APP = 'pkill -TERM -f ChatGPT\\.app';
const KILL_APP = 'pkill -KILL -f ChatGPT\\.app';
const SWEEP = 'pkill -TERM -f browser_crashpad_handler.*ChatGPT\\.app|ChatGPT\\.app.*browser_crashpad_handler';

const HOST_LINE = '100 /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server --mode code_mode_host\n';
const MAIN_HIT: PgResult = { code: 0, stdout: '89323\n' };
const MISS: PgResult = { code: 1, stdout: '' };
const HIT: PgResult = { code: 0, stdout: HOST_LINE };
const CRASHPAD_ONLY: PgResult = {
  code: 0,
  stdout: '71540 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.80/Helpers/browser_crashpad_handler --monitor-self --database=/Users/klein/Library/Application Support/Codex/Crashpad\n',
};

const FAST = { pollIntervalMs: 1, recheckDelayMs: 0 };

test('non-darwin platforms never detect the desktop app and never run commands', async () => {
  const runner = scriptedRunner([HIT]);
  assert.equal(await isCodexDesktopRunning({ platform: 'linux', runner }), false);
  const quit = await quitCodexDesktop({ platform: 'win32', runner });
  assert.equal(quit.ok, false);
  assert.deepEqual(runner.calls, []);
});

test('detects running desktop via host pattern first', async () => {
  const runner = scriptedRunner([MISS, HIT]);
  assert.equal(await isCodexDesktopRunning({ platform: 'darwin', runner }), true);
  assert.deepEqual(runner.calls, [HOST_PROBE, UI_PROBE]);
});

test('reports not running when no pattern matches', async () => {
  const runner = scriptedRunner([MISS, MISS]);
  assert.equal(await isCodexDesktopRunning({ platform: 'darwin', runner }), false);
});

test('leftover crashpad handlers alone do not count as the desktop running', async () => {
  const runner = scriptedRunner([MISS, CRASHPAD_ONLY]);
  assert.equal(await isCodexDesktopRunning({ platform: 'darwin', runner }), false);
  const quit = await quitCodexDesktop({ platform: 'darwin', runner, ...FAST, timeoutMs: 10 });
  assert.equal(quit.ok, true);
  assert.equal(quit.alreadyClosed, true);
  assert.equal(runner.calls.some((c) => c.startsWith('pkill')), false);
});

test('quit is a no-op when the desktop app is already closed', async () => {
  const runner = scriptedRunner([MISS, MISS]);
  const result = await quitCodexDesktop({ platform: 'darwin', runner, ...FAST, timeoutMs: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyClosed, true);
  assert.equal(runner.calls.some((c) => c.startsWith('pkill')), false);
});

test('graceful quit: osascript exits the whole app, sweep and re-verify follow', async () => {
  // detection hit → osascript → poll: host/UI/main all gone → sweep → recheck gone.
  const runner = scriptedRunner(
    [HIT, MISS, MISS, MISS, MISS, MISS], // fl: detection, poll(host,UI), recheck(host,UI)
    [MISS, MISS], // x: poll main, recheck main
  );
  const result = await quitCodexDesktop({ platform: 'darwin', runner, ...FAST, timeoutMs: 1_000 });
  assert.equal(result.ok, true);
  assert.match(result.detail, /已退出 ChatGPT/);
  assert.deepEqual(runner.calls, [
    HOST_PROBE, // detection → running
    QUIT_CALL,
    HOST_PROBE, UI_PROBE, MAIN_PROBE, // poll → all gone
    SWEEP,
    HOST_PROBE, UI_PROBE, MAIN_PROBE, // recheck → still gone
  ]);
  assert.equal(runner.calls.some((c) => c.startsWith('pkill -TERM -f ChatGPT')), false);
});

test('escalates to TERM when the app ignores the graceful quit', async () => {
  const calls: string[] = [];
  let termed = false;
  const runner: CmdRunner = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'pkill' && args[0] === '-TERM' && args[2] === 'ChatGPT\\.app') termed = true;
    if (cmd === 'pgrep') {
      return termed ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '100\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await quitCodexDesktop({
    platform: 'darwin', runner: Object.assign(runner, { calls }), ...FAST,
    timeoutMs: 3, termTimeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.ok(calls.includes(TERM_APP));
  assert.equal(calls.includes(KILL_APP), false);
});

test('escalates to KILL when the app hangs after TERM', async () => {
  const calls: string[] = [];
  let phase = 0; // 0: graceful, 1: after TERM, 2: after KILL
  const runner: CmdRunner = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'pkill' && args[0] === '-TERM' && args[2] === 'ChatGPT\\.app') phase = 1;
    if (cmd === 'pkill' && args[0] === '-KILL') phase = 2;
    if (cmd === 'pgrep') {
      const alive = phase === 0 || phase === 1;
      return alive ? { code: 0, stdout: '100\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await quitCodexDesktop({
    platform: 'darwin', runner: Object.assign(runner, { calls }), ...FAST,
    timeoutMs: 3, termTimeoutMs: 3, killTimeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.ok(calls.includes(KILL_APP));
});

test('fails with a readable reason when processes survive even KILL', async () => {
  const runner = scriptedRunner([HIT], [MAIN_HIT]); // everything keeps matching
  const result = await quitCodexDesktop({
    platform: 'darwin', runner, ...FAST, timeoutMs: 3, termTimeoutMs: 3, killTimeoutMs: 3,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /手动关闭/);
  assert.ok(runner.calls.includes(KILL_APP));
});

test('reports resurrection when an updater relaunches the app after a clean quit', async () => {
  // Everything exits after the graceful quit, but the recheck finds the main app back.
  const runner = scriptedRunner(
    [HIT, MISS, MISS, MISS, MISS], // detection hit; poll gone; recheck host miss, UI miss
    [MISS, MAIN_HIT], // poll main gone; recheck main back
  );
  const result = await quitCodexDesktop({ platform: 'darwin', runner, ...FAST, timeoutMs: 1_000 });
  assert.equal(result.ok, false);
  assert.equal(result.resurrected, true);
  assert.match(result.detail, /登录项/);
});

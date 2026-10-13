import fs from 'node:fs';

const MAC_DESKTOP_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];

/** Match the Desktop account/model protocol instead of an older SDK-bundled CLI. */
export function preferredCodexExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform, executable = (p: string) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
}): string | undefined {
  if (env.CTI_CODEX_EXECUTABLE) {
    if (!executable(env.CTI_CODEX_EXECUTABLE)) throw new Error('CTI_CODEX_EXECUTABLE must name an existing executable file.');
    return env.CTI_CODEX_EXECUTABLE;
  }
  return platform === 'darwin' ? MAC_DESKTOP_CANDIDATES.find(executable) : undefined;
}

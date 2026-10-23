// Derived from openai/codex-plugin-cc (Apache-2.0). See NOTICE.
import { runCommand } from "./process.mjs";

export function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.status === 0 && !result.error ? result.stdout.trim() : cwd;
}

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/usage/scripts/ai_usage.py");

// The script exits 2 when no provider has windows but may still print JSON; trust the JSON, not the code.
export function readUsage({ python = "python3", env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(python, [SCRIPT, "--json"], { env, timeout: 120_000 }, (_error, stdout) => {
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

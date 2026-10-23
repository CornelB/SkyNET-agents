import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process.mjs";

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "skynet", "config.json");
}

export function loadConfig(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(env), "utf8"));
    return { backends: parsed.backends ?? {} };
  } catch {
    return { backends: {} };
  }
}

export function saveConfig(cfg, env = process.env) {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function probe(run, cmd, args) {
  const result = run(cmd, args);
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function detectBackends({ run = runCommand } = {}) {
  const codexVersion = probe(run, "codex", ["--version"]);
  const codexLogin = codexVersion.ok ? probe(run, "codex", ["login", "status"]) : { ok: false, output: "" };
  const ollama = probe(run, "ollama", ["list"]);
  return {
    codex: { installed: codexVersion.ok, loggedIn: codexLogin.ok && /Logged in/.test(codexLogin.output) },
    agy: { installed: probe(run, "agy", ["--version"]).ok },
    ollama: {
      installed: ollama.ok,
      models: ollama.ok ? ollama.stdout.split("\n").slice(1).map((line) => line.split(/\s+/)[0]).filter(Boolean) : []
    },
    codexbar: { installed: probe(run, "codexbar", ["--version"]).ok }
  };
}

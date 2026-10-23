import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configPath, detectBackends, loadConfig, saveConfig } from "../scripts/lib/config.mjs";

test("config round trip with mode 0600", () => {
  const env = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "skynet-xdg-")) };
  assert.deepEqual(loadConfig(env), { backends: {} });
  const cfg = { backends: { codex: { enabled: true, billing: "subscription" } } };
  saveConfig(cfg, env);
  assert.equal(configPath(env), path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"));
  assert.deepEqual(loadConfig(env), cfg);
  assert.equal(fs.statSync(configPath(env)).mode & 0o777, 0o600);
});

test("configPath defaults to ~/.config", () => {
  assert.equal(configPath({ HOME: "/home/x" }), "/home/x/.config/skynet/config.json");
});

test("detectBackends reads login and ollama models", () => {
  const outputs = {
    "codex login status": { status: 0, stdout: "", stderr: "Logged in using ChatGPT\n" },
    "agy --version": { status: 0, stdout: "1.4.6\n" },
    "ollama list": { status: 0, stdout: "NAME   ID   SIZE   MODIFIED\nqwen3.6:35b-a3b   1fac   22 GB   1 h ago\ngemma4:26b   2dd7   15 GB   10 d ago\n" },
    "codexbar --version": { status: 0, stdout: "1.0\n" }
  };
  const run = (cmd, args) => outputs[`${cmd} ${args.join(" ")}`] ?? { status: 0, stdout: "", stderr: "", error: null };
  const found = detectBackends({ run });
  assert.equal(found.codex.loggedIn, true);
  assert.equal(found.agy.installed, true);
  assert.deepEqual(found.ollama.models, ["qwen3.6:35b-a3b", "gemma4:26b"]);
  assert.equal(found.codexbar.installed, true);
});

test("detectBackends marks missing CLIs", () => {
  const run = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("x"), { code: "ENOENT" }) });
  const found = detectBackends({ run });
  assert.equal(found.codex.installed, false);
  assert.equal(found.codex.loggedIn, false);
  assert.deepEqual(found.ollama.models, []);
});

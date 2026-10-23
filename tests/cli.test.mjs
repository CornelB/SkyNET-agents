import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "scripts", "skynet.mjs");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup(extraEnv = {}) {
  const repo = tmp("skynet-cli-");
  const git = (...a) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "feat/x");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const env = {
    ...process.env,
    PATH: `${path.join(here, "fixtures", "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CLAUDE_PLUGIN_DATA: tmp("skynet-data-"),
    XDG_CONFIG_HOME: tmp("skynet-xdg-"),
    CLAUDE_SCRATCHPAD: tmp("skynet-scratch-"),
    ...extraEnv
  };
  delete env.SKYNET_SESSION_ID;
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  return { repo, env, run };
}

async function waitFor(run, id, statuses) {
  for (let i = 0; i < 100; i += 1) {
    const line = run("status", id).out;
    if (statuses.some((s) => line.includes(` ${s}`))) {
      return line;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} never reached ${statuses}`);
}

test("delegate runs a job to completion", async () => {
  const { run } = setup();
  const started = run("delegate", "--backend", "codex", "--mode", "read", "--", "hi there");
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /^dlg-\S+ → codex/);
  const id = started.out.split(" ")[0];
  assert.match(await waitFor(run, id, ["completed", "failed"]), / completed/);
  assert.match(run("result", id).out, /fake codex: hi there/);
});

test("agy output is captured from stdout", async () => {
  const { run } = setup();
  const id = run("delegate", "--backend", "agy", "--mode", "read", "--", "yo").out.split(" ")[0];
  await waitFor(run, id, ["completed", "failed"]);
  assert.match(run("result", id).out, /fake agy: yo/);
});

test("failing backend ends failed with its last stderr line", async () => {
  const { run } = setup({ FAKE_MODE: "fail" });
  const id = run("delegate", "--backend", "codex", "--mode", "read", "--", "x").out.split(" ")[0];
  const line = await waitFor(run, id, ["completed", "failed"]);
  assert.match(line, / failed .*boom/);
});

test("cancel kills a running job", async () => {
  const { run } = setup({ FAKE_MODE: "sleep" });
  const id = run("delegate", "--backend", "codex", "--mode", "read", "--", "x").out.split(" ")[0];
  await waitFor(run, id, ["running"]);
  await new Promise((r) => setTimeout(r, 300));
  const pid = Number(JSON.parse(run("status", id, "--json").out).pid);
  assert.match(run("cancel", id).out, /cancelled/);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0));
  assert.match(run("status", id).out, / cancelled/);
});

test("parallel write merges the worker branch", async () => {
  const { repo, run } = setup({ FAKE_EDIT: "1" });
  const started = run("delegate", "--backend", "codex", "--mode", "write", "--parallel", "--", "edit");
  const id = started.out.split(" ")[0];
  const job = JSON.parse(run("status", id, "--json").out);
  assert.match(job.tree.path, /skynet-scratch-.*\/skynet-codex-dlg-/);
  await waitFor(run, id, ["completed", "failed"]);
  assert.match(run("result", id).out, /feat\/x--codex: merged into feat\/x/);
  assert.equal(fs.readFileSync(path.join(repo, "edited.txt"), "utf8"), "worker\n");
  assert.equal(execFileSync("git", ["branch", "--list", "feat/x--codex"], { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("all backends full starts no job", () => {
  const full = JSON.stringify([{ provider: "codex", source: "oauth", usage: { primary: { usedPercent: 95, windowMinutes: 300, resetsAt: "2026-10-23T11:41:00Z" } } }]);
  const { env, run } = setup({ FAKE_CODEXBAR_JSON: full });
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "skynet"));
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), JSON.stringify({ backends: { codex: { enabled: true, billing: "subscription" } } }));
  const r = run("delegate", "--mode", "read", "--", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, /^no backend: codex 5h 95% full/);
  assert.equal(run("status").out, "no jobs");
});

test("delegate without --mode is rejected", () => {
  const { run } = setup();
  const r = run("delegate", "--backend", "codex", "--", "x");
  assert.equal(r.code, 2);
  assert.match(r.err, /--mode write\|read/);
});

test("setup saves the config from flags", () => {
  const { env, run } = setup();
  const r = run("setup", "--enable", "codex,ollama", "--billing", "codex=per-token", "--ollama-model", "m1");
  assert.equal(r.code, 0, r.err);
  const saved = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), "utf8"));
  assert.deepEqual(saved.backends.codex, { enabled: true, billing: "per-token" });
  assert.deepEqual(saved.backends.agy, { enabled: false, billing: "subscription" });
  assert.deepEqual(saved.backends.ollama, { enabled: true, billing: "local", model: "m1" });
  assert.equal(run("setup", "--enable", "grok").code, 2);
});

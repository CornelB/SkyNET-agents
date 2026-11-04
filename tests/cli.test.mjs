import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  // Only named variables reach the CLI: host settings (OLLAMA_CODING_MODEL, SKYNET_SESSION_ID, ...) must not change results.
  const keep = ["HOME", "TMPDIR", "LANG"].filter((name) => process.env[name] !== undefined);
  const env = {
    ...Object.fromEntries(keep.map((name) => [name, process.env[name]])),
    PATH: `${path.join(here, "fixtures", "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CLAUDE_PLUGIN_DATA: tmp("skynet-data-"),
    XDG_CONFIG_HOME: tmp("skynet-xdg-"),
    CLAUDE_SCRATCHPAD: tmp("skynet-scratch-"),
    ...extraEnv
  };
  const run =(...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const runWith = (extra, ...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const start = (...args) => spawn(process.execPath, [cli, ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  return { repo, env, run, runWith, start };
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

test("result keeps output and status on separate lines", async () => {
  const { run } = setup({ FAKE_NO_NEWLINE: "1" });
  const r = run("delegate", "--backend", "codex", "--mode", "read", "--wait", "--", "nl");
  assert.match(r.out, /fake codex: nl\ndlg-\S+ codex read completed/);
});

test("write briefs tell the worker not to commit", () => {
  const { run } = setup();
  const r = run("delegate", "--backend", "codex", "--mode", "write", "--wait", "--", "edit");
  assert.equal(r.code, 0, r.err);
  const job = JSON.parse(run("status", r.out.split(" ")[0], "--json").out);
  assert.match(fs.readFileSync(job.promptFile, "utf8"), /Do not commit/);
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
  assert.deepEqual(saved.backends.openrouter, {
    enabled: false,
    billing: "free",
    models: { reasoning: "thinkingmachines/inkling-small:free", coding: "poolside/laguna-s-2.1:free", decision: "nvidia/nemotron-3.5-lightning:free", fallback: "openrouter/free" }
  });
  assert.equal(run("setup", "--enable", "openrouter", "--openrouter-coding-model", "a/b:free").code, 0);
  const again = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), "utf8"));
  assert.equal(again.backends.openrouter.enabled, true);
  assert.equal(again.backends.openrouter.models.coding, "a/b:free");
  assert.equal(again.backends.openrouter.models.reasoning, "thinkingmachines/inkling-small:free");
  assert.equal(run("setup", "--enable", "grok").code, 2);
});

test("delegate --wait runs in the foreground and prints the result", () => {
  const { run } = setup();
  const r = run("delegate", "--backend", "codex", "--mode", "read", "--wait", "--", "now");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^dlg-\S+ → codex/);
  assert.match(r.out, /fake codex: now/);
  assert.match(lines.at(-1), / completed/);
});

test("delegate --wait exits 1 when the backend fails", () => {
  const { run } = setup({ FAKE_MODE: "fail" });
  const r = run("delegate", "--backend", "codex", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, / failed .*boom/);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = (run, id) => JSON.parse(run("status", id, "--json").out);

test("cancel stops a --wait job and its backend", async () => {
  const { run, start } = setup({ FAKE_MODE: "sleep" });
  const child = start("delegate", "--backend", "codex", "--mode", "read", "--wait", "--", "x");
  let id = "";
  child.stdout.on("data", (d) => { id ||= String(d).split(" ")[0]; });
  const exited = new Promise((r) => child.on("exit", r));
  for (let i = 0; i < 50 && !(id && job(run, id).backendPid); i += 1) await sleep(100);
  const backendPid = job(run, id).backendPid;
  assert.ok(alive(backendPid));
  assert.match(run("cancel", id).out, /cancelled/);
  await exited;
  await sleep(200);
  assert.equal(alive(backendPid), false);
  assert.match(run("status", id).out, / cancelled/);
});

test("a hung backend times out as failed", () => {
  const { run } = setup({ FAKE_MODE: "sleep" });
  const r = run("delegate", "--backend", "codex", "--mode", "read", "--wait", "--timeout-s", "1", "--", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, / failed .*timed out after 1s/);
});

test("a running job with a dead worker shows failed", async () => {
  const { run } = setup({ FAKE_MODE: "sleep" });
  const id = run("delegate", "--backend", "codex", "--mode", "read", "--", "x").out.split(" ")[0];
  for (let i = 0; i < 50 && !job(run, id).backendPid; i += 1) await sleep(100);
  const { pid, backendPid } = job(run, id);
  process.kill(pid, "SIGKILL");
  process.kill(-backendPid, "SIGKILL");
  await sleep(200);
  assert.match(run("status", id).out, / failed .*worker gone/);
});

test("ollama without a model leaves no worktree or branch", () => {
  const { repo, env, run } = setup();
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "skynet"));
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), JSON.stringify({ backends: { ollama: { enabled: true, billing: "local" } } }));
  const r = run("delegate", "--backend", "ollama", "--mode", "write", "--parallel", "--", "x");
  assert.notEqual(r.code, 0);
  assert.equal(execFileSync("git", ["branch", "--list", "*--ollama"], { cwd: repo, encoding: "utf8" }).trim(), "");
  assert.deepEqual(fs.readdirSync(env.CLAUDE_SCRATCHPAD), []);
});

test("a brief on stdin keeps quotes and dollars", () => {
  const { repo, env } = setup();
  const brief = `say "hi" and $HOME \`x\` !`;
  const r = spawnSync(process.execPath, [cli, "delegate", "--backend", "codex", "--mode", "read", "--wait"], { cwd: repo, env, input: brief, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`fake codex: ${brief}`));
});

test("wait blocks until the job ends, or times out with exit 3", async () => {
  const { run } = setup();
  const id = run("delegate", "--backend", "codex", "--mode", "read", "--", "w").out.split(" ")[0];
  const done = run("wait", id, "--timeout-s", "10");
  assert.equal(done.code, 0);
  assert.match(done.out, / completed/);
  const slow = setup({ FAKE_MODE: "sleep" });
  const sid = slow.run("delegate", "--backend", "codex", "--mode", "read", "--", "w").out.split(" ")[0];
  const pending = slow.run("wait", sid, "--timeout-s", "1");
  assert.equal(pending.code, 3);
  assert.match(pending.out, / (queued|running)/);
  slow.run("cancel", sid);
});

test("openrouter write runs the coding model and read the reasoning model", () => {
  const { run } = setup();
  assert.equal(run("setup", "--enable", "openrouter", "--openrouter-coding-model", "c/x:free", "--openrouter-reasoning-model", "r/x:free").code, 0);
  assert.match(run("delegate", "--backend", "openrouter", "--mode", "write", "--wait", "--", "x").out, /fake opencode: openrouter\/c\/x:free/);
  assert.match(run("delegate", "--backend", "openrouter", "--mode", "read", "--wait", "--", "x").out, /fake opencode: openrouter\/r\/x:free/);
});

test("a rate-limited openrouter job retries once on the fallback model", () => {
  const { run } = setup({ FAKE_RATE_LIMIT: "1" });
  assert.equal(run("setup", "--enable", "openrouter").code, 0);
  const r = run("delegate", "--backend", "openrouter", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /fake opencode: openrouter\/openrouter\/free/);
});

test("a rate-limited job without a different fallback fails", () => {
  const { run } = setup({ FAKE_RATE_LIMIT: "1" });
  assert.equal(run("setup", "--enable", "openrouter", "--openrouter-fallback-model", "thinkingmachines/inkling-small:free").code, 0);
  const r = run("delegate", "--backend", "openrouter", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, /429 rate limited/);
});

const idOf = (r) => r.out.split(" ")[0];
const gitIn = (repo, ...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });

test("status shows mode and the brief's first line as title", async () => {
  const { run } = setup();
  const id = idOf(run("delegate", "--backend", "codex", "--mode", "read", "--", "Find the bug\nmore detail"));
  run("wait", id, "--timeout-s", "10");
  assert.match(run("status", id).out, new RegExp(`^${id} codex read completed .*"Find the bug"`));
});

test("a main-tree write job shows merge=none and no branch", () => {
  const { run } = setup();
  const r = run("delegate", "--backend", "codex", "--mode", "write", "--wait", "--", "edit");
  const line = run("status", idOf(r)).out;
  assert.match(line, / codex write completed .*merge=none/);
  assert.doesNotMatch(line, /branch=/);
});

test("a parallel write job shows its branch and merge state", async () => {
  const { run } = setup({ FAKE_EDIT: "1", FAKE_DELAY_MS: "1500" });
  const id = idOf(run("delegate", "--backend", "codex", "--mode", "write", "--parallel", "--", "edit"));
  assert.match(run("status", id).out, / write (queued|running) .*branch=feat\/x--codex merge=pending/);
  run("wait", id, "--timeout-s", "15");
  assert.match(run("status", id).out, / write completed .*branch=feat\/x--codex merge=merged/);
});

test("a parallel write that conflicts shows merge=conflict", () => {
  const { repo, run } = setup({ FAKE_EDIT: "1", FAKE_DELAY_MS: "1500" });
  const id = idOf(run("delegate", "--backend", "codex", "--mode", "write", "--parallel", "--", "edit"));
  fs.writeFileSync(path.join(repo, "edited.txt"), "lead\n");
  gitIn(repo, "add", "edited.txt");
  gitIn(repo, "commit", "-q", "-m", "lead");
  run("wait", id, "--timeout-s", "15");
  assert.match(run("status", id).out, /branch=feat\/x--codex merge=conflict/);
});

test("one wait returns every job as it ends, failing one included", () => {
  const { run, runWith } = setup();
  const a = idOf(run("delegate", "--backend", "codex", "--mode", "read", "--", "job a"));
  const b = idOf(runWith({ FAKE_MODE: "fail" }, "delegate", "--backend", "codex", "--mode", "read", "--", "job b"));
  const c = idOf(runWith({ FAKE_DELAY_MS: "800" }, "delegate", "--backend", "codex", "--mode", "read", "--", "job c"));
  const r = run("wait", a, b, c, "--timeout-s", "15");
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /fake codex: job a/, `stderr: ${r.err}`);
  assert.match(r.out, /fake codex: job c/);
  assert.match(r.out, new RegExp(`${b} codex read failed .*boom`));
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("dlg-")).length, 3);
  assert.ok(r.out.indexOf(c) > r.out.indexOf(a), "the slow job is reported after the fast one");
});

test("wait --any returns at the first finished job and exit 3 while others run", () => {
  const { run, runWith } = setup();
  const fast = idOf(run("delegate", "--backend", "codex", "--mode", "read", "--", "fast"));
  const slow = idOf(runWith({ FAKE_MODE: "sleep" }, "delegate", "--backend", "codex", "--mode", "read", "--", "slow"));
  const r = run("wait", fast, slow, "--any", "--timeout-s", "15");
  assert.equal(r.code, 3);
  assert.match(r.out, new RegExp(`${fast} codex read completed`));
  assert.match(r.out, new RegExp(`${slow} codex read (queued|running)`));
  run("cancel", slow);
});

test("wait over all-completed jobs exits 0", () => {
  const { run } = setup();
  const a = idOf(run("delegate", "--backend", "codex", "--mode", "read", "--", "a"));
  const b = idOf(run("delegate", "--backend", "codex", "--mode", "read", "--", "b"));
  assert.equal(run("wait", a, b, "--timeout-s", "15").code, 0);
});

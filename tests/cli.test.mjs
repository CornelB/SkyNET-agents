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

// A codex home whose model cache lists two versions of one family and a hidden model.
function codexHome() {
  const dir = tmp("skynet-codex-home-");
  fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({ models: [
    { slug: "acme-2-big", visibility: "list" },
    { slug: "acme-2.1-big", visibility: "list" },
    { slug: "acme-9-big", visibility: "hide" }
  ] }));
  return dir;
}
const writeConfig = (env, backends) => {
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "skynet"), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), JSON.stringify({ backends }));
};
const readConfig = (env) => JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), "utf8"));

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
  const keep = ["HOME", "LANG"].filter((name) => process.env[name] !== undefined);
  const env = {
    ...Object.fromEntries(keep.map((name) => [name, process.env[name]])),
    PATH: `${path.join(here, "fixtures", "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CLAUDE_PLUGIN_DATA: tmp("skynet-data-"),
    XDG_CONFIG_HOME: tmp("skynet-xdg-"),
    CLAUDE_SCRATCHPAD: tmp("skynet-scratch-"),
    // Write jobs create their scratch dir under TMPDIR: keep it inside the test.
    TMPDIR: tmp("skynet-tmp-"),
    // The codex model list comes from CODEX_HOME, never from the developer's home.
    CODEX_HOME: codexHome(),
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
  const started = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "hi there");
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /^dlg-\S+ → codex/);
  const id = started.out.split(" ")[0];
  assert.match(await waitFor(run, id, ["completed", "failed"]), / completed/);
  assert.match(run("result", id).out, /fake codex: hi there/);
});

test("result keeps output and status on separate lines", async () => {
  const { run } = setup({ FAKE_NO_NEWLINE: "1" });
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait", "--", "nl");
  assert.match(r.out, /fake codex: nl\ndlg-\S+ codex read completed/);
});

test("write briefs tell the worker not to commit", () => {
  const { run } = setup();
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "write", "--wait", "--", "edit");
  assert.equal(r.code, 0, r.err);
  const job = JSON.parse(run("status", r.out.split(" ")[0], "--json").out);
  assert.match(fs.readFileSync(job.promptFile, "utf8"), /Do not commit/);
});

// Each backend gets the prompt its own way (stdin, -p=, argument), so check what the worker receives.
for (const backend of ["codex", "ollama", "agy", "openrouter"]) {
  test(`${backend} write workers get their own scratch dir outside the work tree`, () => {
    const { env, run, runWith } = setup();
    const log = path.join(tmp("skynet-prompt-"), "prompt.log");
    let extra = { FAKE_PROMPT_LOG: log };
    if (backend === "ollama") extra = { ...extra, ...withSelector(env, "echo 127.0.0.1:11435").extra };
    if (backend === "openrouter") assert.equal(run("setup", "--enable", "openrouter").code, 0);
    const r = runWith(extra, "delegate", "--tier", "sonnet", "--backend", backend, "--mode", "write", "--wait", "--", "edit");
    assert.equal(r.code, 0, r.err);
    const scratch = path.join(env.TMPDIR, `skynet-job-${r.out.split(" ")[0]}`);
    assert.ok(fs.readFileSync(log, "utf8").includes(`scratch files in ${scratch}, never in the work tree. Change only the files this task asks for.`));
    assert.ok(fs.statSync(scratch).isDirectory());
    fs.rmSync(log);
    assert.equal(runWith(extra, "delegate", "--tier", "sonnet", "--backend", backend, "--mode", "read", "--wait", "--", "look").code, 0);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /scratch files/);
  });
}

test("agy output is captured from stdout", async () => {
  const { run } = setup();
  const id = run("delegate", "--tier", "sonnet", "--backend", "agy", "--mode", "read", "--", "yo").out.split(" ")[0];
  await waitFor(run, id, ["completed", "failed"]);
  assert.match(run("result", id).out, /fake agy: yo/);
});

test("failing backend ends failed with its last stderr line", async () => {
  const { run } = setup({ FAKE_MODE: "fail" });
  const id = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "x").out.split(" ")[0];
  const line = await waitFor(run, id, ["completed", "failed"]);
  assert.match(line, / failed .*boom/);
});

test("cancel kills a running job", async () => {
  const { run } = setup({ FAKE_MODE: "sleep" });
  const id = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "x").out.split(" ")[0];
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
  const started = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "write", "--parallel", "--", "edit");
  const id = started.out.split(" ")[0];
  const job = JSON.parse(run("status", id, "--json").out);
  assert.match(job.tree.path, /skynet-scratch-.*\/skynet-codex-dlg-/);
  await waitFor(run, id, ["completed", "failed"]);
  assert.match(run("result", id).out, /feat\/x--codex: merged into feat\/x/);
  assert.equal(fs.readFileSync(path.join(repo, "edited.txt"), "utf8"), "worker\n");
  assert.equal(execFileSync("git", ["branch", "--list", "feat/x--codex"], { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("all backends full hands the piece to the calling session and starts no job", () => {
  const full = JSON.stringify([{ provider: "codex", source: "oauth", usage: { primary: { usedPercent: 95, windowMinutes: 300, resetsAt: "2026-10-23T11:41:00Z" } } }]);
  const { env, run } = setup({ FAKE_CODEXBAR_JSON: full });
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "skynet"));
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), JSON.stringify({ backends: { codex: { enabled: true, billing: "subscription" } } }));
  const r = run("delegate", "--tier", "sonnet", "--mode", "read", "--", "x");
  assert.equal(r.code, 4);
  assert.match(r.out, /^→ self sonnet \(self, codex 5h 95% full/);
  assert.equal(run("status").out, "no jobs");
  const none = run("delegate", "--tier", "sonnet", "--mode", "read", "--not", "self", "--", "x");
  assert.equal(none.code, 1);
  assert.match(none.out, /^no backend: codex 5h 95% full/);
});

test("delegate without --tier is rejected", () => {
  const { run } = setup();
  const r = run("delegate", "--backend", "codex", "--mode", "read", "--", "x");
  assert.equal(r.code, 2);
  assert.match(r.err, /delegate needs --tier haiku\|sonnet\|opus\|fable/);
  assert.equal(run("status").out, "no jobs");
});

test("a mapped tier runs the newest listed version with its effort and records both", () => {
  const { env, run } = setup();
  writeConfig(env, { codex: { enabled: true, billing: "subscription", tiers: { sonnet: ["big@high"] } } });
  const r = run("delegate", "--tier", "haiku", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\S+ → codex acme-2\.1-big \(codex 5h 38%\)/);
  const job = JSON.parse(run("status", r.out.split(" ")[0], "--json").out);
  assert.deepEqual([job.tier, job.model, job.effort], ["haiku", "acme-2.1-big", "high"]);
});

test("--backend keeps the tier map: a tier the backend does not serve is refused", () => {
  const { env, run } = setup();
  writeConfig(env, { codex: { enabled: true, billing: "subscription", tiers: { sonnet: ["big"] } } });
  const r = run("delegate", "--tier", "fable", "--backend", "codex", "--mode", "read", "--", "x");
  assert.equal(r.code, 1);
  assert.equal(r.err, "codex no fable model");
  assert.equal(run("status").out, "no jobs");
});

test("an unreadable model list runs the slug the entry last resolved to", () => {
  const { env, run, runWith } = setup();
  writeConfig(env, { codex: { enabled: true, billing: "subscription", tiers: { sonnet: ["big"] } } });
  assert.equal(run("delegate", "--tier", "sonnet", "--mode", "read", "--wait", "--", "x").code, 0);
  const r = runWith({ CODEX_HOME: tmp("skynet-codex-empty-") }, "delegate", "--tier", "sonnet", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ codex acme-2\.1-big \(codex 5h 38%, model list unreadable\)/);
});

test("a backend at its parallel limit is skipped, counting jobs of every workspace", async () => {
  const first = setup({ FAKE_MODE: "sleep" });
  writeConfig(first.env, { codex: { enabled: true, billing: "subscription", maxParallel: 1 } });
  const id = idOf(first.run("delegate", "--tier", "sonnet", "--mode", "read", "--", "slow"));
  await waitFor(first.run, id, ["running"]);
  // Another repository on the same machine shares the state root and the config.
  const other = setup({ CLAUDE_PLUGIN_DATA: first.env.CLAUDE_PLUGIN_DATA, XDG_CONFIG_HOME: first.env.XDG_CONFIG_HOME });
  const r = other.run("delegate", "--tier", "sonnet", "--mode", "read", "--", "x");
  assert.equal(r.code, 4);
  assert.match(r.out, /^→ self sonnet \(self, codex at limit \(1 running\)\)/);
  first.run("cancel", id);
  assert.equal(other.run("delegate", "--tier", "sonnet", "--mode", "read", "--wait", "--", "x").code, 0);
});

test("setup merges: a map and a limit survive a later --enable, and --map repeats", () => {
  const { env, run } = setup();
  assert.equal(run("setup", "--enable", "codex", "--map", "codex:sonnet=big@high,small", "--map", "codex:fable=huge", "--max-parallel", "codex=3").code, 0);
  assert.deepEqual(readConfig(env).backends.codex, { enabled: true, billing: "subscription", tiers: { sonnet: ["big@high", "small"], fable: ["huge"] }, maxParallel: 3 });
  assert.equal(run("setup", "--enable", "codex,agy").code, 0);
  assert.deepEqual(readConfig(env).backends.codex.tiers, { sonnet: ["big@high", "small"], fable: ["huge"] });
  assert.equal(run("setup", "--map", "codex:fable=").code, 0);
  assert.deepEqual(readConfig(env).backends.codex.tiers, { sonnet: ["big@high", "small"] });
  assert.match(run("setup").out, /^codex .*tiers: sonnet=big@high,small → acme-2\.1-big maxParallel=3$/m);
  const bare = run("setup", "--map", "agy:sonnet=big");
  assert.equal(bare.code, 2);
  assert.match(bare.err, /agy entry big needs an effort/);
});

test("route prints the hand-off level, and with --role the pick first", () => {
  const { env, run } = setup();
  writeConfig(env, { codex: { enabled: true, billing: "subscription" } });
  assert.match(run("route").out, /^claude week 84% → hand off any part a worker can do alone$/);
  const r = run("route", "--role", "read", "--tier", "opus");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split("\n")[0], /^→ codex own model \(codex 5h 38%, model unmapped\)$/);
  assert.equal(run("route", "--role", "read").code, 2);
  assert.equal(run("status").out, "no jobs");
});

test("delegate without --mode is rejected", () => {
  const { run } = setup();
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--", "x");
  assert.equal(r.code, 2);
  assert.match(r.err, /--mode write\|read/);
});

test("setup saves the config from flags", () => {
  const { env, run } = setup();
  const r = run("setup", "--enable", "codex,ollama", "--billing", "codex=per-token");
  assert.equal(r.code, 0, r.err);
  const saved = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), "utf8"));
  assert.deepEqual(saved.backends.codex, { enabled: true, billing: "per-token" });
  assert.deepEqual(saved.backends.agy, { enabled: false, billing: "subscription" });
  assert.deepEqual(saved.backends.ollama, { enabled: true, billing: "local" });
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
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait", "--", "now");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.match(lines[0], /^dlg-\S+ → codex/);
  assert.match(r.out, /fake codex: now/);
  assert.match(lines.at(-1), / completed/);
});

test("delegate --wait exits 1 when the backend fails", () => {
  const { run } = setup({ FAKE_MODE: "fail" });
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait", "--", "x");
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
  const child = start("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait", "--", "x");
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
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait", "--timeout-s", "1", "--", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, / failed .*timed out after 1s/);
});

test("a running job with a dead worker shows failed", async () => {
  const { run } = setup({ FAKE_MODE: "sleep" });
  const id = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "x").out.split(" ")[0];
  for (let i = 0; i < 50 && !job(run, id).backendPid; i += 1) await sleep(100);
  const { pid, backendPid } = job(run, id);
  process.kill(pid, "SIGKILL");
  process.kill(-backendPid, "SIGKILL");
  await sleep(200);
  assert.match(run("status", id).out, / failed .*worker gone/);
});

test("ollama without OLLAMA_CODING_MODEL leaves no worktree or branch", () => {
  const { repo, env, run } = setup();
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "skynet"));
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), JSON.stringify({ backends: { ollama: { enabled: true, billing: "local" } } }));
  const r = run("delegate", "--tier", "sonnet", "--backend", "ollama", "--mode", "write", "--parallel", "--", "x");
  assert.notEqual(r.code, 0);
  assert.equal(execFileSync("git", ["branch", "--list", "*--ollama"], { cwd: repo, encoding: "utf8" }).trim(), "");
  assert.deepEqual(fs.readdirSync(env.CLAUDE_SCRATCHPAD), []);
});

test("a brief on stdin keeps quotes and dollars", () => {
  const { repo, env } = setup();
  const brief = `say "hi" and $HOME \`x\` !`;
  const r = spawnSync(process.execPath, [cli, "delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait"], { cwd: repo, env, input: brief, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`fake codex: ${brief}`));
});

test("wait blocks until the job ends, or times out with exit 3", async () => {
  const { run } = setup();
  const id = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "w").out.split(" ")[0];
  const done = run("wait", id, "--timeout-s", "10");
  assert.equal(done.code, 0);
  assert.match(done.out, / completed/);
  const slow = setup({ FAKE_MODE: "sleep" });
  const sid = slow.run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "w").out.split(" ")[0];
  const pending = slow.run("wait", sid, "--timeout-s", "1");
  assert.equal(pending.code, 3);
  assert.match(pending.out, / (queued|running)/);
  slow.run("cancel", sid);
});

test("openrouter write runs the coding model and read the reasoning model", () => {
  const { run } = setup();
  assert.equal(run("setup", "--enable", "openrouter", "--openrouter-coding-model", "c/x:free", "--openrouter-reasoning-model", "r/x:free").code, 0);
  assert.match(run("delegate", "--tier", "sonnet", "--backend", "openrouter", "--mode", "write", "--wait", "--", "x").out, /fake opencode: openrouter\/c\/x:free/);
  assert.match(run("delegate", "--tier", "sonnet", "--backend", "openrouter", "--mode", "read", "--wait", "--", "x").out, /fake opencode: openrouter\/r\/x:free/);
});

test("a rate-limited openrouter job retries once on the fallback model", () => {
  const { run } = setup({ FAKE_RATE_LIMIT: "1" });
  assert.equal(run("setup", "--enable", "openrouter").code, 0);
  const r = run("delegate", "--tier", "sonnet", "--backend", "openrouter", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /fake opencode: openrouter\/openrouter\/free/);
});

test("a rate-limited job without a different fallback fails", () => {
  const { run } = setup({ FAKE_RATE_LIMIT: "1" });
  assert.equal(run("setup", "--enable", "openrouter", "--openrouter-fallback-model", "thinkingmachines/inkling-small:free").code, 0);
  const r = run("delegate", "--tier", "sonnet", "--backend", "openrouter", "--mode", "read", "--wait", "--", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, /429 rate limited/);
});

const idOf = (r) => r.out.split(" ")[0];
const gitIn = (repo, ...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });

test("status shows mode and the brief's first line as title", async () => {
  const { run } = setup();
  const id = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "Find the bug\nmore detail"));
  run("wait", id, "--timeout-s", "10");
  assert.match(run("status", id).out, new RegExp(`^${id} codex read completed .*"Find the bug"`));
});

test("a main-tree write job shows merge=none and no branch", () => {
  const { run } = setup();
  const r = run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "write", "--wait", "--", "edit");
  const line = run("status", idOf(r)).out;
  assert.match(line, / codex write completed .*merge=none/);
  assert.doesNotMatch(line, /branch=/);
});

test("a parallel write job shows its branch and merge state", async () => {
  const { run } = setup({ FAKE_EDIT: "1", FAKE_DELAY_MS: "1500" });
  const id = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "write", "--parallel", "--", "edit"));
  assert.match(run("status", id).out, / write (queued|running) .*branch=feat\/x--codex merge=pending/);
  run("wait", id, "--timeout-s", "15");
  assert.match(run("status", id).out, / write completed .*branch=feat\/x--codex merge=merged/);
});

test("a parallel write that conflicts shows merge=conflict", () => {
  const { repo, run } = setup({ FAKE_EDIT: "1", FAKE_DELAY_MS: "1500" });
  const id = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "write", "--parallel", "--", "edit"));
  fs.writeFileSync(path.join(repo, "edited.txt"), "lead\n");
  gitIn(repo, "add", "edited.txt");
  gitIn(repo, "commit", "-q", "-m", "lead");
  run("wait", id, "--timeout-s", "15");
  assert.match(run("status", id).out, /branch=feat\/x--codex merge=conflict/);
});

test("one wait returns every job as it ends, failing one included", () => {
  const { run, runWith } = setup();
  const a = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "job a"));
  const b = idOf(runWith({ FAKE_MODE: "fail" }, "delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "job b"));
  const c = idOf(runWith({ FAKE_DELAY_MS: "800" }, "delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "job c"));
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
  const fast = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "fast"));
  const slow = idOf(runWith({ FAKE_MODE: "sleep" }, "delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "slow"));
  const r = run("wait", fast, slow, "--any", "--timeout-s", "15");
  assert.equal(r.code, 3);
  assert.match(r.out, new RegExp(`${fast} codex read completed`));
  assert.match(r.out, new RegExp(`${slow} codex read (queued|running)`));
  run("cancel", slow);
});

test("wait over all-completed jobs exits 0", () => {
  const { run } = setup();
  const a = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "a"));
  const b = idOf(run("delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--", "b"));
  assert.equal(run("wait", a, b, "--timeout-s", "15").code, 0);
});

// A selector in the test's temp dir: prints `body`'s answer and appends one line per call to `calls`.
function withSelector(env, body, { enabled = true } = {}) {
  const dir = tmp("skynet-sel-");
  const file = path.join(dir, "select");
  const calls = path.join(dir, "calls");
  fs.writeFileSync(file, `#!/usr/bin/env bash\necho "$@" >> "${calls}"\n${body}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "skynet"), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "skynet", "config.json"), JSON.stringify({ backends: { codex: { enabled: true, billing: "subscription" }, ollama: { enabled, billing: "local" } } }));
  const logs = { codex: path.join(dir, "codex.env"), ollama: path.join(dir, "ollama.env") };
  const extra = { OLLAMA_SELECTOR: file, OLLAMA_CODING_MODEL: "m", OLLAMA_CODING_MODEL_TIER: "sonnet", FAKE_CODEX_ENV_LOG: logs.codex, FAKE_OLLAMA_LOG: logs.ollama };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  return { extra, calls: () => read(calls).split("\n").filter(Boolean), log: (name) => read(logs[name]) };
}

test("delegate --backend ollama runs the job on the selected server and asks once", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo 127.0.0.1:11435");
  const r = runWith(sel.extra, "delegate", "--tier", "sonnet", "--backend", "ollama", "--mode", "read", "--wait", "--", "hi");
  assert.equal(r.code, 0, r.err);
  const id = r.out.split(" ")[0];
  assert.equal(JSON.parse(runWith(sel.extra, "status", id, "--json").out).ollamaHost, "http://127.0.0.1:11435");
  assert.match(sel.log("codex"), /^CODEX_OSS_BASE_URL=http:\/\/127\.0\.0\.1:11435\/v1$/m);
  assert.match(sel.log("ollama"), /^OLLAMA_HOST=http:\/\/127\.0\.0\.1:11435$/m);
  assert.deepEqual(sel.calls(), ["coding m"]);
});

test("delegate --backend ollama asks the selector even with ollama disabled", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo 127.0.0.1:11435", { enabled: false });
  const r = runWith(sel.extra, "delegate", "--tier", "sonnet", "--backend", "ollama", "--mode", "read", "--wait", "--", "hi");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(sel.calls(), ["coding m"]);
  assert.match(sel.log("codex"), /11435\/v1/);
});

test("a selector refusal stops delegate --backend ollama before a job exists", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo busy >&2; exit 1");
  const r = runWith(sel.extra, "delegate", "--tier", "sonnet", "--backend", "ollama", "--mode", "read", "--", "hi");
  assert.equal(r.code, 1);
  assert.match(r.err, /busy/);
  assert.equal(runWith(sel.extra, "status").out, "no jobs");
});

test("delegate --backend codex does not ask the selector", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo 127.0.0.1:11435");
  assert.equal(runWith(sel.extra, "delegate", "--tier", "sonnet", "--backend", "codex", "--mode", "read", "--wait", "--", "hi").code, 0);
  assert.deepEqual(sel.calls(), []);
});

test("without OLLAMA_CODING_MODEL the selector is not asked", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo 127.0.0.1:11435");
  const r = runWith({ ...sel.extra, OLLAMA_CODING_MODEL: "" }, "delegate", "--tier", "sonnet", "--backend", "ollama", "--mode", "read", "--", "hi");
  assert.notEqual(r.code, 0);
  assert.equal(r.err, "ollama skipped, no model set");
  assert.deepEqual(sel.calls(), []);
});

test("ollama takes its declared tier and below, and nothing without a declared tier", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo 127.0.0.1:11435");
  const above = runWith(sel.extra, "delegate", "--tier", "opus", "--backend", "ollama", "--mode", "write", "--", "hi");
  assert.equal(above.code, 1);
  assert.equal(above.err, "ollama no opus model");
  const undeclared = runWith({ ...sel.extra, OLLAMA_CODING_MODEL_TIER: "" }, "delegate", "--tier", "haiku", "--backend", "ollama", "--mode", "write", "--", "hi");
  assert.equal(undeclared.err, "ollama skipped, no tier declared");
  // The selector runs only after the static checks pass.
  assert.deepEqual(sel.calls(), []);
  assert.equal(runWith(sel.extra, "delegate", "--tier", "haiku", "--backend", "ollama", "--mode", "write", "--wait", "--", "hi").code, 0);
});

test("route names the selected server and counts it as idle", () => {
  const { env, runWith } = setup();
  const sel = withSelector(env, "echo 127.0.0.1:11435");
  const usage = JSON.stringify([
    { provider: "codex", usage: { primary: { usedPercent: 10, windowMinutes: 300 }, secondary: { usedPercent: 6, windowMinutes: 10080 } } },
    { provider: "claude", usage: { primary: { usedPercent: 0, windowMinutes: 300 }, secondary: { usedPercent: 10, windowMinutes: 10080 } } }
  ]);
  const r = runWith({ ...sel.extra, FAKE_CODEXBAR_JSON: usage }, "route", "--role", "write", "--tier", "sonnet");
  assert.equal(r.code, 0, r.err);
  const [first, second] = r.out.split("\n");
  assert.match(first, /^→ ollama m \(ollama http:\/\/127\.0\.0\.1:11435, selected\)$/);
  assert.match(second, /GPU idle/);
  // A local backend is in the write funnel only.
  assert.match(runWith({ ...sel.extra, FAKE_CODEXBAR_JSON: usage }, "route", "--role", "read", "--tier", "sonnet").out, /^→ codex own model/);
});

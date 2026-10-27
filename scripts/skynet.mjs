#!/usr/bin/env node
// skynet CLI: setup, route, delegate, worker, status, result, cancel. Every line it prints is one item.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { buildInvocation } from "./lib/backends.mjs";
import { configPath, detectBackends, loadConfig, saveConfig } from "./lib/config.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { buildStatusSnapshot, formatElapsedDuration, readStoredJob, resolveCancelableJob, resolveResultJob } from "./lib/job-control.mjs";
import { handoffLevel, route } from "./lib/router.mjs";
import { ensureStateDir, generateJobId, resolveJobLogFile, resolveJobsDir, resolveStateDir, upsertJob, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, createJobRecord, nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { readUsage } from "./lib/usage.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { createWorkerTree, finishWorkerTree } from "./lib/worktree.mjs";

const SELF = fileURLToPath(import.meta.url);
const BACKENDS = ["codex", "agy", "openrouter", "ollama"];

const DEFAULT_BILLING = { ollama: "local", openrouter: "free" };
const DEFAULT_TIMEOUT_S = 3600;
const ACTIVE = new Set(["queued", "running"]);

class UsageError extends Error {}

const print = (line) => process.stdout.write(`${line}\n`);
// Empty codex home for ollama jobs, shared by all workspaces; codex fills it on first run.
const ossHome = () => {
  const dir = path.join(path.dirname(resolveStateDir(process.cwd())), "codex-oss-home");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const signalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
};

function patchJob(workspaceRoot, id, patch) {
  upsertJob(workspaceRoot, { id, ...patch });
  writeJobFile(workspaceRoot, id, { ...(readStoredJob(workspaceRoot, id) ?? {}), id, ...patch });
}

// A running job whose worker process is gone is failed; record it so it stops showing as running.
function settle(workspaceRoot, job) {
  if (ACTIVE.has(job.status) && job.pid && !isAlive(Number(job.pid))) {
    if (job.backendPid) signalGroup(Number(job.backendPid), "SIGKILL");
    const patch = { status: "failed", summary: "worker gone", pid: null, completedAt: nowIso() };
    patchJob(workspaceRoot, job.id, patch);
    return { ...job, ...patch };
  }
  return job;
}

const list = (value) => (value ? String(value).split(",").map((s) => s.trim()).filter(Boolean) : []);

function setup(options) {
  if (!options.enable) {
    const found = detectBackends();
    const cfg = loadConfig().backends;
    const state = (name) => (cfg[name] ? `${cfg[name].enabled ? "enabled" : "disabled"} ${cfg[name].billing ?? ""}`.trim() : "not configured");
    print(`codex ${found.codex.installed ? (found.codex.loggedIn ? "logged in" : "not logged in") : "missing"}, ${state("codex")}`);
    print(`agy ${found.agy.installed ? "installed" : "missing"}, ${state("agy")}`);
    print(`openrouter ${found.openrouter.installed ? (found.openrouter.keySet ? "opencode, key set" : "opencode, no key") : "opencode missing"}, ${state("openrouter")}`);
    print(`ollama ${found.ollama.installed ? `models: ${found.ollama.models.join(", ") || "none"}` : "missing"}, ${state("ollama")}`);
    print(`codexbar ${found.codexbar.installed ? "installed" : "missing"}`);
    return 0;
  }
  const enabled = list(options.enable);
  const unknown = enabled.filter((name) => !BACKENDS.includes(name));
  if (unknown.length) {
    throw new UsageError(`unknown backend: ${unknown.join(", ")}`);
  }
  const billing = Object.fromEntries(list(options.billing).map((pair) => pair.split("=")));
  const backends = {};
  for (const name of BACKENDS) {
    backends[name] = { enabled: enabled.includes(name), billing: billing[name] ?? DEFAULT_BILLING[name] ?? "subscription" };
  }
  if (options["ollama-model"]) backends.ollama.model = options["ollama-model"];
  if (options["openrouter-model"]) backends.openrouter.model = options["openrouter-model"];
  if (options["agy-window"]) backends.agy.window = options["agy-window"];
  saveConfig({ backends });
  print(`saved ${configPath()}`);
  return 0;
}

async function routeCommand() {
  const usage = await readUsage();
  print(route(usage, loadConfig()).line);
  print(handoffLevel(usage).line);
  return 0;
}

function composePrompt(brief, { mode, paths }) {
  const parts = [brief.trim()];
  if (paths.length) parts.push(`Scope: work only in ${paths.join(", ")}.`);
  parts.push(mode === "read" ? "Do not edit files." : "Do not commit. Leave your changes uncommitted.");
  parts.push("End with a summary of at most 5 lines.");
  return parts.join("\n\n");
}

async function delegate(options, positionals) {
  if (options.mode !== "write" && options.mode !== "read") {
    throw new UsageError("delegate needs --mode write|read");
  }
  const brief = positionals.join(" ") || readStdinIfPiped();
  if (!brief.trim()) {
    throw new UsageError("delegate needs a brief after --");
  }
  const cwd = process.cwd();
  const config = loadConfig();
  let backend = options.backend;
  let reason = `→ ${backend} (override)`;
  if (!backend) {
    const picked = route(await readUsage(), config);
    if (!picked.backend) {
      print(picked.line);
      return 1;
    }
    ({ backend, line: reason } = picked);
  }
  if (!BACKENDS.includes(backend)) {
    throw new UsageError(`unknown backend ${backend}`);
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const id = generateJobId("dlg");
  ensureStateDir(workspaceRoot);
  const jobsDir = resolveJobsDir(workspaceRoot);
  const promptFile = path.join(jobsDir, `${id}.prompt.md`);
  const outFile = path.join(jobsDir, `${id}.out.md`);
  const prompt = composePrompt(brief, { mode: options.mode, paths: list(options.paths) });
  // Fail before creating anything when the invocation cannot be built (e.g. no ollama or openrouter model).
  buildInvocation(backend, { mode: options.mode, cwd: workspaceRoot, promptFile, outFile, prompt, model: config.backends[backend]?.model, ossHome: ossHome() });
  const timeoutS = Number(options["timeout-s"] ?? (config.timeoutMinutes ? config.timeoutMinutes * 60 : DEFAULT_TIMEOUT_S));
  if (!(timeoutS > 0)) {
    throw new UsageError("--timeout-s must be a positive number");
  }
  const tree = options.parallel
    ? createWorkerTree({ repo: workspaceRoot, backend, scratchDir: process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), jobId: id })
    : null;
  fs.writeFileSync(promptFile, prompt);

  const job = createJobRecord({
    id,
    backend,
    mode: options.mode,
    status: "queued",
    title: brief.trim().split("\n")[0].slice(0, 80),
    workspaceRoot,
    cwd: tree?.path ?? workspaceRoot,
    promptFile,
    outFile,
    model: config.backends[backend]?.model ?? null,
    timeoutS,
    tree,
    logFile: resolveJobLogFile(workspaceRoot, id)
  });
  writeJobFile(workspaceRoot, id, job);
  upsertJob(workspaceRoot, job);

  print(`${id} ${reason}`);
  if (options.wait) {
    await worker(id, workspaceRoot);
    result([id]);
    return readStoredJob(workspaceRoot, id)?.status === "completed" ? 0 : 1;
  }
  const child = spawn(process.execPath, [SELF, "worker", id], { cwd: workspaceRoot, detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return 0;
}

// The backend gets its own process group so cancel and timeout can kill it and its children.
function runBackend(invocation, { cwd, logFile, timeoutS, onSpawn }) {
  return new Promise((resolve) => {
    const stdin = invocation.stdinFile ? fs.openSync(invocation.stdinFile, "r") : "ignore";
    const stdout = fs.openSync(invocation.stdoutFile ?? logFile, invocation.stdoutFile ? "w" : "a");
    let lastErr = "";
    let timedOut = false;
    const child = spawn(invocation.cmd, invocation.args, { cwd, stdio: [stdin, stdout, "pipe"], detached: true, env: { ...process.env, ...invocation.env } });
    if (child.pid) onSpawn(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), 5000).unref();
    }, timeoutS * 1000);
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      const lines = String(chunk).split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length) lastErr = lines.at(-1);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, lastErr: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ code: 124, lastErr: `timed out after ${timeoutS}s` });
      else resolve({ code: code ?? 1, lastErr: lastErr || (signal ? `killed by ${signal}` : "") });
    });
  });
}

async function worker(id, workspaceRoot = process.cwd()) {
  const job = readStoredJob(workspaceRoot, id);
  if (!job) {
    throw new UsageError(`no job ${id}`);
  }
  const prompt = fs.readFileSync(job.promptFile, "utf8");
  const invocation = buildInvocation(job.backend, { mode: job.mode, cwd: job.cwd, promptFile: job.promptFile, outFile: job.outFile, prompt, model: job.model, ossHome: ossHome() });
  appendLogLine(job.logFile, `starting ${job.backend}`);
  await runTrackedJob(job, async () => {
    const { code, lastErr } = await runBackend(invocation, {
      cwd: job.cwd,
      logFile: job.logFile,
      timeoutS: job.timeoutS ?? DEFAULT_TIMEOUT_S,
      onSpawn: (backendPid) => patchJob(workspaceRoot, id, { backendPid })
    });
    let summary = code === 0 ? null : lastErr || `exit ${code}`;
    const cancelled = readStoredJob(workspaceRoot, id)?.status === "cancelled";
    if (!cancelled && code !== 0 && job.tree) {
      summary = `${summary}, worktree kept at ${job.tree.path}`;
    }
    if (!cancelled && code === 0 && job.tree) {
      summary = finishWorkerTree({ repo: workspaceRoot, backend: job.backend, ...job.tree }).line;
    }
    return { exitStatus: code, summary, rendered: null, payload: null };
  }, { logFile: job.logFile });
  return 0;
}

function statusLine(job) {
  const elapsed = formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null);
  return [job.id, job.backend, job.status, elapsed, job.summary ?? job.errorMessage].filter(Boolean).join(" ");
}

function status(options, positionals) {
  const snapshot = buildStatusSnapshot(process.cwd(), { reference: positionals[0], all: options.all });
  const jobs = snapshot.jobs.map((job) => settle(snapshot.workspaceRoot, job));
  if (options.json) {
    print(JSON.stringify(jobs.length === 1 ? readStoredJob(resolveWorkspaceRoot(process.cwd()), jobs[0].id) ?? jobs[0] : jobs));
    return 0;
  }
  if (!jobs.length) {
    print("no jobs");
  }
  jobs.forEach((job) => print(statusLine(job)));
  return 0;
}

function result(positionals) {
  const { job } = resolveResultJob(process.cwd(), positionals[0]);
  const output = fs.existsSync(job.outFile ?? "") ? fs.readFileSync(job.outFile, "utf8") : "";
  if (output) {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
  print(statusLine(job));
  return 0;
}

function cancel(positionals) {
  const { workspaceRoot, job } = resolveCancelableJob(process.cwd(), positionals[0]);
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  patchJob(workspaceRoot, job.id, { status: "cancelled", pid: null, completedAt: nowIso() });
  if (stored.backendPid) signalGroup(Number(stored.backendPid), "SIGTERM");
  if (stored.pid && Number(stored.pid) !== process.pid) {
    try {
      process.kill(Number(stored.pid), "SIGTERM");
    } catch {
      // already gone
    }
  }
  print(`${job.id} cancelled${stored.tree ? `, worktree kept at ${stored.tree.path}` : ""}`);
  return 0;
}

async function waitFor(options, positionals) {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const { job: found } = buildSingle(workspaceRoot, positionals[0]);
  const deadline = Date.now() + Number(options["timeout-s"] ?? 540) * 1000;
  let job = settle(workspaceRoot, readStoredJob(workspaceRoot, found.id) ?? found);
  while (ACTIVE.has(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    job = settle(workspaceRoot, readStoredJob(workspaceRoot, found.id) ?? job);
  }
  print(statusLine(job));
  return ACTIVE.has(job.status) ? 3 : job.status === "completed" ? 0 : 1;
}

function buildSingle(workspaceRoot, reference) {
  if (!reference) {
    throw new UsageError("wait needs a job id");
  }
  const { jobs } = buildStatusSnapshot(workspaceRoot, { reference });
  return { job: jobs[0] };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "paths", "backend", "enable", "billing", "ollama-model", "openrouter-model", "agy-window", "timeout-s"],
    booleanOptions: ["parallel", "wait", "json", "all"]
  });
  switch (command) {
    case "setup": return setup(options);
    case "route": return routeCommand();
    case "delegate": return delegate(options, positionals);
    case "worker": return worker(positionals[0]);
    case "status": return status(options, positionals);
    case "result": return result(positionals);
    case "cancel": return cancel(positionals);
    case "wait": return waitFor(options, positionals);
    default: throw new UsageError("usage: skynet setup|route|delegate|status|wait|result|cancel");
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`skynet: ${error.message}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
);

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
import { gpuIdle, readGpu } from "./lib/gpu.mjs";
import { handoffLevel, route } from "./lib/router.mjs";
import { ensureStateDir, generateJobId, resolveJobLogFile, resolveJobsDir, resolveStateDir, upsertJob, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, createJobRecord, nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { readUsage } from "./lib/usage.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { createWorkerTree, finishWorkerTree } from "./lib/worktree.mjs";

const SELF = fileURLToPath(import.meta.url);
const BACKENDS = ["codex", "agy", "openrouter", "ollama"];

const DEFAULT_BILLING = { ollama: "local", openrouter: "free" };
// Free-tier picks (openrouter.ai, Oct 2026): best Intelligence Index score, the coding agent model,
// a small fast model for classification, and the free router for a rate-limited job's one retry.
// setup flags override each one.
const OPENROUTER_MODELS = {
  reasoning: "thinkingmachines/inkling-small:free",
  coding: "poolside/laguna-s-2.1:free",
  decision: "nvidia/nemotron-3.5-lightning:free",
  fallback: "openrouter/free"
};
const RATE_LIMITED = /\b429\b|rate[ -]?limit/i;
// OpenRouter write jobs run the coding model and read jobs the reasoning model; the other backends have one model.
// Ollama takes OLLAMA_CODING_MODEL from the environment (Claude Code settings env) over the saved model.
const ollamaModel = (config) => process.env.OLLAMA_CODING_MODEL || config.backends.ollama?.model;
const modelFor = (config, backend, mode) => {
  const cfg = config.backends[backend];
  if (backend === "ollama") return ollamaModel(config);
  return cfg?.models ? cfg.models[mode === "write" ? "coding" : "reasoning"] : cfg?.model;
};
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
    const roles = (models) => (models ? ` ${Object.entries(models).map(([role, id]) => `${role}=${id}`).join(" ")}` : "");
    const state = (name) => (cfg[name] ? `${cfg[name].enabled ? "enabled" : "disabled"} ${cfg[name].billing ?? ""}${roles(cfg[name].models)}`.trim() : "not configured");
    print(`codex ${found.codex.installed ? (found.codex.loggedIn ? "logged in" : "not logged in") : "missing"}, ${state("codex")}`);
    print(`agy ${found.agy.installed ? "installed" : "missing"}, ${state("agy")}`);
    print(`openrouter ${found.openrouter.installed ? (found.openrouter.keySet ? "opencode, key set" : "opencode, no key") : "opencode missing"}, ${cfg.openrouter ? state("openrouter") : `not configured, defaults${roles(OPENROUTER_MODELS)}`}`);
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
  backends.openrouter.models = Object.fromEntries(Object.entries(OPENROUTER_MODELS).map(([role, id]) => [role, options[`openrouter-${role}-model`] ?? id]));
  if (options["agy-window"]) backends.agy.window = options["agy-window"];
  saveConfig({ backends });
  print(`saved ${configPath()}`);
  return 0;
}

// The GPU is read only when ollama could take the job.
const ollamaGpu = (config) => (config.backends.ollama?.enabled ? readGpu({ model: ollamaModel(config) }) : undefined);

async function routeCommand() {
  const usage = await readUsage();
  const config = loadConfig();
  const gpu = ollamaGpu(config);
  print(route(usage, config, gpu).line);
  print(handoffLevel(usage, { ollamaIdle: gpu !== undefined && gpuIdle(gpu) }).line);
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
    const picked = route(await readUsage(), config, ollamaGpu(config));
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
  buildInvocation(backend, { mode: options.mode, cwd: workspaceRoot, promptFile, outFile, prompt, model: modelFor(config, backend, options.mode), ossHome: ossHome() });
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
    model: modelFor(config, backend, options.mode) ?? null,
    fallbackModel: config.backends[backend]?.models?.fallback ?? null,
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
  const attempt = (model) =>
    runBackend(buildInvocation(job.backend, { mode: job.mode, cwd: job.cwd, promptFile: job.promptFile, outFile: job.outFile, prompt, model, ossHome: ossHome() }), {
      cwd: job.cwd,
      logFile: job.logFile,
      timeoutS: job.timeoutS ?? DEFAULT_TIMEOUT_S,
      onSpawn: (backendPid) => patchJob(workspaceRoot, id, { backendPid })
    });
  appendLogLine(job.logFile, `starting ${job.backend}`);
  await runTrackedJob(job, async () => {
    let { code, lastErr } = await attempt(job.model);
    // A rate-limited model gets one retry on the fallback. A write job's retry starts from the tree the
    // first attempt left, partial edits included.
    const output = () => `${fs.readFileSync(job.logFile, "utf8")}${fs.existsSync(job.outFile) ? fs.readFileSync(job.outFile, "utf8") : ""}`;
    const stopped = () => readStoredJob(workspaceRoot, id)?.status === "cancelled";
    if (code !== 0 && job.fallbackModel && job.fallbackModel !== job.model && !stopped() && RATE_LIMITED.test(output())) {
      appendLogLine(job.logFile, `${job.model} rate limited, retrying on ${job.fallbackModel}`);
      ({ code, lastErr } = await attempt(job.fallbackModel));
    }
    let summary = code === 0 ? null : lastErr || `exit ${code}`;
    const cancelled = stopped();
    if (!cancelled && code !== 0 && job.tree) {
      summary = `${summary}, worktree kept at ${job.tree.path}`;
    }
    if (!cancelled && code === 0 && job.tree) {
      const finished = finishWorkerTree({ repo: workspaceRoot, backend: job.backend, ...job.tree });
      summary = finished.line;
      patchJob(workspaceRoot, id, { merge: finished.state });
    }
    return { exitStatus: code, summary, rendered: null, payload: null };
  }, { logFile: job.logFile });
  return 0;
}

// Write jobs carry their branch and merge state: merged, conflict, pending (not merged yet, or kept), none (main tree).
function statusLine(job) {
  const elapsed = formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null);
  const merge = job.mode !== "write" ? null : job.tree ? `branch=${job.tree.branch} merge=${job.merge ?? "pending"}` : "merge=none";
  const title = job.title ? `"${job.title}"` : null;
  return [job.id, job.backend, job.mode, job.status, elapsed, merge, title, job.summary ?? job.errorMessage].filter(Boolean).join(" ");
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
  printResult(resolveResultJob(process.cwd(), positionals[0]).job);
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

function printResult(job) {
  const output = fs.existsSync(job.outFile ?? "") ? fs.readFileSync(job.outFile, "utf8") : "";
  if (output) {
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  }
  print(statusLine(job));
}

// Waits for one or more jobs and prints each one's output and status line as it ends.
// --any returns after the first ends. Exit 0 all completed, 1 any failed or cancelled, 3 any still running.
async function waitFor(options, positionals) {
  if (!positionals.length) {
    throw new UsageError("wait needs one or more job ids");
  }
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const ids = positionals.map((reference) => buildStatusSnapshot(workspaceRoot, { reference }).jobs[0].id);
  const deadline = Date.now() + Number(options["timeout-s"] ?? 540) * 1000;
  // The state list, not the job file, carries summary and merge state.
  const load = (id) => settle(workspaceRoot, buildStatusSnapshot(workspaceRoot, { reference: id }).jobs[0]);
  const pending = new Set(ids);
  const ended = [];
  for (;;) {
    for (const id of pending) {
      const job = load(id);
      if (!ACTIVE.has(job.status)) {
        printResult(job);
        pending.delete(id);
        ended.push(job);
      }
    }
    if (!pending.size || (options.any && ended.length) || Date.now() >= deadline) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  pending.forEach((id) => print(statusLine(load(id))));
  return pending.size ? 3 : ended.every((job) => job.status === "completed") ? 0 : 1;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "paths", "backend", "enable", "billing", "ollama-model", "openrouter-reasoning-model", "openrouter-coding-model", "openrouter-decision-model", "openrouter-fallback-model", "agy-window", "timeout-s"],
    booleanOptions: ["parallel", "wait", "json", "all", "any"]
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

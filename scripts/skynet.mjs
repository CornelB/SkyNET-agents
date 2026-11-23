#!/usr/bin/env node
// skynet CLI: setup, route, delegate, worker, status, result, cancel. Every line it prints is one item.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { buildInvocation, jobScratchDir, ollamaContextWindow } from "./lib/backends.mjs";
import { configPath, detectBackends, loadConfig, saveConfig } from "./lib/config.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { buildStatusSnapshot, formatElapsedDuration, readStoredJob, resolveCancelableJob, resolveResultJob } from "./lib/job-control.mjs";
import { gpuIdle, readGpu } from "./lib/gpu.mjs";
import { handoffLevel, route } from "./lib/router.mjs";
import { selectOllamaServer } from "./lib/selector.mjs";
import { ensureStateDir, generateJobId, resolveJobLogFile, resolveJobsDir, resolveStateDir, upsertJob, writeJobFile } from "./lib/state.mjs";
import { TIERS, ollamaTier, parseEntry, readAgySlugs, readCodexSlugs, resolveTier, tierIndex, tierMap } from "./lib/tiers.mjs";
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
// Ollama's model is OLLAMA_CODING_MODEL from the environment (Claude Code settings env); skynet saves none.
const ollamaModel = () => process.env.OLLAMA_CODING_MODEL || undefined;
// The calling session is "claude" in Claude Code and "self" anywhere else.
const inClaude = () => Boolean(process.env.CLAUDECODE);
const modelFor = (config, backend, mode) => {
  const cfg = config.backends[backend];
  if (backend === "ollama") return ollamaModel();
  return cfg?.models ? cfg.models[mode === "write" ? "coding" : "reasoning"] : cfg?.model;
};
const DEFAULT_TIMEOUT_S = 3600;
const ACTIVE = new Set(["queued", "running"]);
const ROLES = ["write", "read", "advisor"];
const TIER_USAGE = `--tier ${TIERS.join("|")}`;
// delegate's exit code when the funnel ends on the calling session: no job, the caller runs the piece.
const EXIT_CALLER = 4;

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

// --map <backend>:<tier>=<entry>[,<entry>...] -> [backend, tier, entries]. An empty list removes the tier.
function parseMap(value) {
  const match = /^([a-z]+):([a-z]+)=(.*)$/i.exec(value);
  if (!match) {
    throw new UsageError(`--map needs <backend>:<tier>=<family>[@<effort>][,...], got ${value}`);
  }
  const [, backend, tierName, rest] = match;
  if (!BACKENDS.includes(backend) || backend === "ollama") {
    throw new UsageError(backend === "ollama" ? "ollama takes its tier from OLLAMA_CODING_MODEL_TIER" : `unknown backend ${backend}`);
  }
  const tier = parseTier(tierName, `--map needs a tier: ${TIERS.join(", ")}`);
  const entries = list(rest);
  // An agy slug ends in its effort, so an entry without one can never resolve.
  const bare = backend === "agy" ? entries.find((entry) => !parseEntry(entry).effort) : undefined;
  if (bare) {
    throw new UsageError(`agy entry ${bare} needs an effort: ${bare}@<effort>`);
  }
  return [backend, tier, entries];
}

function parseMaxParallel(value) {
  const [backend, count] = value.split("=");
  if (!BACKENDS.includes(backend) || !(Number.isInteger(Number(count)) && Number(count) > 0)) {
    throw new UsageError(`--max-parallel needs <backend>=<n>, got ${value}`);
  }
  return [backend, Number(count)];
}

function setup(options) {
  const maps = (options.map ?? []).map(parseMap);
  const limits = (options["max-parallel"] ?? []).map(parseMaxParallel);
  if (!options.enable && !maps.length && !limits.length) {
    const found = detectBackends();
    const config = loadConfig();
    const cfg = config.backends;
    const resolve = tierResolver(config);
    const roles = (models) => (models ? ` ${Object.entries(models).map(([role, id]) => `${role}=${id}`).join(" ")}` : "");
    // Each mapped tier with what it runs today: `sonnet=<entries> → <slug>`.
    const tiers = (name) => {
      const map = tierMap(name, cfg[name]);
      if (!map) return "";
      const shown = TIERS.filter((tier) => map[tier]?.length).map((tier) => {
        const resolved = resolve(name, tier);
        const origin = cfg[name]?.tiers?.[tier] ? "" : " (built in)";
        return `${tier}=${map[tier].join(",")}${origin} → ${resolved.serves ? resolved.model ?? "own model" : "no model"}`;
      });
      return shown.length ? ` tiers: ${shown.join("; ")}` : "";
    };
    const limit = (name) => (cfg[name]?.maxParallel ? ` maxParallel=${cfg[name].maxParallel}` : "");
    const state = (name) => (cfg[name] ? `${cfg[name].enabled ? "enabled" : "disabled"} ${cfg[name].billing ?? ""}${roles(cfg[name].models)}${tiers(name)}${limit(name)}`.trim() : "not configured");
    print(`codex ${found.codex.installed ? (found.codex.loggedIn ? "logged in" : "not logged in") : "missing"}, ${state("codex")}`);
    print(`agy ${found.agy.installed ? "installed" : "missing"}, ${state("agy")}`);
    print(`openrouter ${found.openrouter.installed ? (found.openrouter.keySet ? "opencode, key set" : "opencode, no key") : "opencode missing"}, ${cfg.openrouter ? state("openrouter") : `not configured, defaults${roles(OPENROUTER_MODELS)}`}`);
    print(`ollama ${found.ollama.installed ? `models: ${found.ollama.models.join(", ") || "none"}` : "missing"}, ${state("ollama")}`);
    print(`codexbar ${found.codexbar.installed ? "installed" : "missing"}`);
    return 0;
  }
  // setup merges: a key it does not set keeps its saved value (tier maps, limits, anything hand-set).
  const config = loadConfig();
  const backends = config.backends;
  if (options.enable) {
    const enabled = list(options.enable);
    const unknown = enabled.filter((name) => !BACKENDS.includes(name));
    if (unknown.length) {
      throw new UsageError(`unknown backend: ${unknown.join(", ")}`);
    }
    const billing = Object.fromEntries(list(options.billing).map((pair) => pair.split("=")));
    for (const name of BACKENDS) {
      backends[name] = { ...backends[name], enabled: enabled.includes(name), billing: billing[name] ?? DEFAULT_BILLING[name] ?? "subscription" };
    }
    backends.openrouter.models = Object.fromEntries(Object.entries(OPENROUTER_MODELS).map(([role, id]) => [role, options[`openrouter-${role}-model`] ?? id]));
    if (options["agy-window"]) backends.agy.window = options["agy-window"];
  }
  for (const [name, tier, entries] of maps) {
    backends[name] = { ...backends[name], tiers: { ...backends[name]?.tiers } };
    if (entries.length) {
      backends[name].tiers[tier] = entries;
    } else {
      delete backends[name].tiers[tier];
    }
  }
  for (const [name, count] of limits) {
    backends[name] = { ...backends[name], maxParallel: count };
  }
  saveConfig({ ...config, backends });
  print(`saved ${configPath()}`);
  return 0;
}

// State root shared by every workspace: job state dirs, the ollama codex home, the resolved-model file.
const stateRoot = () => path.dirname(resolveStateDir(process.cwd()));
const savedModelsFile = () => path.join(stateRoot(), "resolved-models.json");
function loadSavedModels() {
  try {
    return JSON.parse(fs.readFileSync(savedModelsFile(), "utf8"));
  } catch {
    return {};
  }
}
// The last slug an entry resolved to: what runs when the backend's model list cannot be read.
function saveResolvedModel(key, model) {
  const saved = loadSavedModels();
  if (saved[key] === model) return;
  fs.mkdirSync(stateRoot(), { recursive: true });
  fs.writeFileSync(savedModelsFile(), `${JSON.stringify({ ...saved, [key]: model }, null, 2)}\n`);
}

// resolve(backend, tier) for the router. A backend's model list is read once, and only when a walk reaches it.
function tierResolver(config) {
  const lists = {};
  const saved = loadSavedModels();
  const listSlugs = (backend) => {
    if (!(backend in lists)) {
      lists[backend] = backend === "codex" ? readCodexSlugs() : backend === "agy" ? readAgySlugs() : null;
    }
    return lists[backend];
  };
  return (backend, tier) => resolveTier(backend, config.backends[backend] ?? {}, tier, { listSlugs, saved });
}

// Live jobs per backend, in every workspace under the state root. A job whose worker is gone is settled first.
function runningJobs() {
  const counts = {};
  let dirs = [];
  try {
    dirs = fs.readdirSync(stateRoot(), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return counts;
  }
  for (const dir of dirs) {
    let jobs = [];
    try {
      jobs = JSON.parse(fs.readFileSync(path.join(stateRoot(), dir.name, "state.json"), "utf8")).jobs ?? [];
    } catch {
      continue;
    }
    for (const job of jobs) {
      if (!ACTIVE.has(job.status) || !job.workspaceRoot) continue;
      if (ACTIVE.has(settle(job.workspaceRoot, job).status)) {
        counts[job.backend] = (counts[job.backend] ?? 0) + 1;
      }
    }
  }
  return counts;
}

// What the router may ask about ollama. The selector and the GPU are read only when the walk gets that far.
const ollamaFacts = () => ({
  model: ollamaModel(),
  tier: ollamaTier(),
  select: () => ollamaSelection(),
  readGpu: () => readGpu({ model: ollamaModel() })
});

function parseTier(value, usage) {
  if (tierIndex(value ?? "") < 0) {
    throw new UsageError(usage);
  }
  return TIERS[tierIndex(value)];
}

// OLLAMA_SELECTOR's answer for the coding model; undefined without a selector or a model.
const ollamaSelection = () => (ollamaModel() ? selectOllamaServer("coding", ollamaModel()) : undefined);

// What routing knows about ollama, read only when ollama could take the job. A selector answer replaces
// the GPU read: the selector judges whether its server is free.
function ollamaState(config) {
  if (!config.backends.ollama?.enabled) {
    return { gpu: undefined, selection: undefined, idle: false };
  }
  const selection = ollamaSelection();
  if (selection) {
    return { gpu: undefined, selection, idle: !selection.refused };
  }
  const gpu = readGpu({ model: ollamaModel() });
  return { gpu, selection, idle: gpu !== undefined && gpuIdle(gpu) };
}

// Without --role: the hand-off level only. With it: the pick for that role and tier, then the level. Starts nothing.
async function routeCommand(options) {
  const usage = await readUsage();
  const config = loadConfig();
  const handoff = () => handoffLevel(usage, { ollamaIdle: ollamaState(config).idle, config }).line;
  if (!options.role) {
    print(handoff());
    return 0;
  }
  if (!ROLES.includes(options.role)) {
    throw new UsageError(`route needs --role ${ROLES.join("|")}`);
  }
  const tier = options.role === "advisor" ? "fable" : parseTier(options.tier, `route --role ${options.role} needs ${TIER_USAGE}`);
  const picked = route({
    role: options.role,
    tier,
    usage,
    config,
    inClaude: inClaude(),
    needsShell: Boolean(options["needs-shell"]),
    not: list(options.not),
    running: runningJobs(),
    ollama: ollamaFacts(),
    resolve: tierResolver(config)
  });
  print(picked.line);
  print(handoff());
  return picked.step ? 0 : 1;
}

// The one prompt every backend gets: codex and ollama read it from the prompt file, agy and openrouter as an argument.
function composePrompt(brief, { mode, paths, scratchDir }) {
  const parts = [brief.trim()];
  if (paths.length) parts.push(`Scope: work only in ${paths.join(", ")}.`);
  if (mode === "read") {
    parts.push("Do not edit files.");
  } else {
    parts.push("Do not commit. Leave your changes uncommitted.");
    parts.push(`Put helper scripts, test harnesses and other scratch files in ${scratchDir}, never in the work tree. Change only the files this task asks for.`);
  }
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
  const tier = parseTier(options.tier, `delegate needs ${TIER_USAGE}`);
  const forced = options.backend ?? null;
  if (forced && !BACKENDS.includes(forced)) {
    throw new UsageError(`unknown backend ${forced}`);
  }
  const cwd = process.cwd();
  const config = loadConfig();
  // An override skips the quota rules, so it reads no usage; it keeps the tier map, the selector and the limit.
  const picked = route({
    role: options.mode,
    tier,
    usage: forced ? [] : await readUsage(),
    config,
    inClaude: inClaude(),
    needsShell: Boolean(options["needs-shell"]),
    not: list(options.not),
    forced,
    running: runningJobs(),
    ollama: ollamaFacts(),
    resolve: tierResolver(config)
  });
  if (!picked.step) {
    if (forced) {
      process.stderr.write(`${picked.line.replace(/^no backend: /, "")}\n`);
    } else {
      print(picked.line);
    }
    return 1;
  }
  if (!picked.backend) {
    // The calling session runs this piece itself, at the tier the line names.
    print(picked.line);
    return EXIT_CALLER;
  }
  const backend = picked.backend;
  // No mapped model: ollama runs its environment's model, openrouter its role model, the others the CLI's own.
  const model = picked.model ?? modelFor(config, backend, options.mode) ?? null;
  const effort = picked.effort ?? null;
  const reason = forced ? `→ ${backend} ${model ?? "own model"} (override)` : picked.line;
  const ollamaHost = backend === "ollama" ? picked.ollamaHost ?? null : null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const id = generateJobId("dlg");
  ensureStateDir(workspaceRoot);
  const jobsDir = resolveJobsDir(workspaceRoot);
  const promptFile = path.join(jobsDir, `${id}.prompt.md`);
  const outFile = path.join(jobsDir, `${id}.out.md`);
  const scratchDir = jobScratchDir(id);
  const prompt = composePrompt(brief, { mode: options.mode, paths: list(options.paths), scratchDir });
  // Fail before creating anything when the invocation cannot be built (e.g. no ollama or openrouter model).
  buildInvocation(backend, { mode: options.mode, cwd: workspaceRoot, promptFile, outFile, prompt, model, effort, ossHome: ossHome() });
  if (picked.key && picked.model && !picked.note) {
    saveResolvedModel(picked.key, picked.model);
  }
  const timeoutS = Number(options["timeout-s"] ?? (config.timeoutMinutes ? config.timeoutMinutes * 60 : DEFAULT_TIMEOUT_S));
  if (!(timeoutS > 0)) {
    throw new UsageError("--timeout-s must be a positive number");
  }
  const tree = options.parallel
    ? createWorkerTree({ repo: workspaceRoot, backend, scratchDir: process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), jobId: id })
    : null;
  fs.writeFileSync(promptFile, prompt);
  if (options.mode === "write") {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

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
    tier,
    model,
    effort,
    ollamaHost,
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
  // The pid makes a worker that dies before it starts the job visible, so it cannot hold a slot of the parallel limit.
  if (child.pid) patchJob(workspaceRoot, id, { pid: child.pid });
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
  const contextWindow = job.backend === "ollama" && job.model ? ollamaContextWindow(job.model, { host: job.ollamaHost }) : undefined;
  const attempt = (model) =>
    runBackend(buildInvocation(job.backend, { mode: job.mode, cwd: job.cwd, promptFile: job.promptFile, outFile: job.outFile, prompt, model, effort: job.effort, ossHome: ossHome(), contextWindow, ollamaHost: job.ollamaHost }), {
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
      patchJob(workspaceRoot, id, { model: job.fallbackModel });
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
    valueOptions: ["mode", "paths", "backend", "enable", "billing","openrouter-reasoning-model", "openrouter-coding-model", "openrouter-decision-model", "openrouter-fallback-model", "agy-window", "timeout-s", "tier", "role", "not"],
    listOptions: ["map", "max-parallel"],
    booleanOptions: ["parallel", "wait", "json", "all", "any", "needs-shell"]
  });
  switch (command) {
    case "setup": return setup(options);
    case "route": return routeCommand(options);
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

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
import { terminateProcessTree } from "./lib/process.mjs";
import { handoffLevel, route } from "./lib/router.mjs";
import { ensureStateDir, generateJobId, resolveJobLogFile, resolveJobsDir, upsertJob, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, createJobRecord, nowIso, runTrackedJob } from "./lib/tracked-jobs.mjs";
import { readUsage } from "./lib/usage.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { createWorkerTree, finishWorkerTree } from "./lib/worktree.mjs";

const SELF = fileURLToPath(import.meta.url);
const BACKENDS = ["codex", "agy", "ollama"];

class UsageError extends Error {}

const print = (line) => process.stdout.write(`${line}\n`);
const list = (value) => (value ? String(value).split(",").map((s) => s.trim()).filter(Boolean) : []);

function setup(options) {
  if (!options.enable) {
    const found = detectBackends();
    const cfg = loadConfig().backends;
    const state = (name) => (cfg[name] ? `${cfg[name].enabled ? "enabled" : "disabled"} ${cfg[name].billing ?? ""}`.trim() : "not configured");
    print(`codex ${found.codex.installed ? (found.codex.loggedIn ? "logged in" : "not logged in") : "missing"}, ${state("codex")}`);
    print(`agy ${found.agy.installed ? "installed" : "missing"}, ${state("agy")}`);
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
    backends[name] = { enabled: enabled.includes(name), billing: billing[name] ?? (name === "ollama" ? "local" : "subscription") };
  }
  if (options["ollama-model"]) backends.ollama.model = options["ollama-model"];
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
  if (mode === "read") parts.push("Do not edit files.");
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
  const tree = options.parallel
    ? createWorkerTree({ repo: workspaceRoot, backend, scratchDir: process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), jobId: id })
    : null;
  // Fail before spawning when the invocation cannot be built (e.g. no ollama model).
  buildInvocation(backend, { mode: options.mode, cwd: tree?.path ?? workspaceRoot, promptFile, outFile, prompt, model: config.backends[backend]?.model });
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
    tree,
    logFile: resolveJobLogFile(workspaceRoot, id)
  });
  writeJobFile(workspaceRoot, id, job);
  upsertJob(workspaceRoot, job);

  const child = spawn(process.execPath, [SELF, "worker", id], { cwd: workspaceRoot, detached: true, stdio: "ignore", env: process.env });
  child.unref();
  print(`${id} ${reason}`);
  return 0;
}

function runBackend(invocation, cwd, logFile) {
  return new Promise((resolve) => {
    const stdin = invocation.stdinFile ? fs.openSync(invocation.stdinFile, "r") : "ignore";
    const stdout = fs.openSync(invocation.stdoutFile ?? logFile, invocation.stdoutFile ? "w" : "a");
    let lastErr = "";
    const child = spawn(invocation.cmd, invocation.args, { cwd, stdio: [stdin, stdout, "pipe"] });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(logFile, chunk);
      const lines = String(chunk).split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length) lastErr = lines.at(-1);
    });
    child.on("error", (error) => resolve({ code: 127, lastErr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, lastErr }));
  });
}

async function worker(id) {
  const workspaceRoot = process.cwd();
  const job = readStoredJob(workspaceRoot, id);
  if (!job) {
    throw new UsageError(`no job ${id}`);
  }
  const prompt = fs.readFileSync(job.promptFile, "utf8");
  const invocation = buildInvocation(job.backend, { mode: job.mode, cwd: job.cwd, promptFile: job.promptFile, outFile: job.outFile, prompt, model: job.model });
  appendLogLine(job.logFile, `starting ${job.backend}`);
  await runTrackedJob(job, async () => {
    const { code, lastErr } = await runBackend(invocation, job.cwd, job.logFile);
    let summary = code === 0 ? null : lastErr || `exit ${code}`;
    if (code === 0 && job.tree) {
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
  const { jobs } = buildStatusSnapshot(process.cwd(), { reference: positionals[0], all: options.all });
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
  if (fs.existsSync(job.outFile ?? "")) {
    process.stdout.write(fs.readFileSync(job.outFile, "utf8"));
  }
  print(statusLine(job));
  return 0;
}

function cancel(positionals) {
  const { workspaceRoot, job } = resolveCancelableJob(process.cwd(), positionals[0]);
  terminateProcessTree(Number(job.pid));
  const patch = { id: job.id, status: "cancelled", pid: null, completedAt: nowIso() };
  upsertJob(workspaceRoot, patch);
  writeJobFile(workspaceRoot, job.id, { ...(readStoredJob(workspaceRoot, job.id) ?? job), ...patch });
  print(`${job.id} cancelled`);
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "paths", "backend", "enable", "billing", "ollama-model", "agy-window"],
    booleanOptions: ["parallel", "json", "all"]
  });
  switch (command) {
    case "setup": return setup(options);
    case "route": return routeCommand();
    case "delegate": return delegate(options, positionals);
    case "worker": return worker(positionals[0]);
    case "status": return status(options, positionals);
    case "result": return result(positionals);
    case "cancel": return cancel(positionals);
    default: throw new UsageError("usage: skynet setup|route|delegate|status|result|cancel");
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`skynet: ${error.message}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
);

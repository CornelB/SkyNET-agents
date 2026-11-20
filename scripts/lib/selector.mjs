import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process.mjs";

// OLLAMA_SELECTOR: a user-owned executable that names the Ollama server for a role's model.
// Contract: docs/specs/2026-11-20-ollama-selector.md. Unset or empty: undefined, nothing runs.
export const SELECTOR_TIMEOUT_MS = 10000;
const SERVER_LINE = /^(http:\/\/)?[A-Za-z0-9._-]+:[0-9]+\/?$/;
const NOT_EXECUTABLE = "OLLAMA_SELECTOR not executable";

// Reasons land in JSON status files and one-line status output.
export function sanitizeReason(text) {
  return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 300);
}

const lastLine = (text) => (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1);

// -> {host: "http://h:p" | null} or {refused: reason}
export function parseSelectorAnswer({ status, signal, timedOut, stdout, stderr }) {
  if (timedOut) {
    return { refused: "selector timed out" };
  }
  if (status === null || status === undefined) {
    return { refused: sanitizeReason(`selector killed by ${signal}`) };
  }
  if (status !== 0) {
    return { refused: sanitizeReason(lastLine(stderr) ?? `selector exit ${status}`) };
  }
  const line = (stdout ?? "").split("\n")[0].trim();
  if (!line) {
    return { host: null };
  }
  if (!SERVER_LINE.test(line)) {
    return { refused: sanitizeReason(`selector printed ${line}`) };
  }
  return { host: `${line.startsWith("http://") ? "" : "http://"}${line.replace(/\/$/, "")}` };
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return path.isAbsolute(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The environment that sends the ollama CLI and codex --oss to a server; {} for the default server.
// codex ignores OLLAMA_HOST and reads CODEX_OSS_BASE_URL.
export function ollamaHostEnv(host) {
  return host ? { OLLAMA_HOST: host, CODEX_OSS_BASE_URL: `${host}/v1` } : {};
}

// Not runCommand: it drops timeout and reads a signal death as status 0. stdout and stderr go to files,
// so a child the selector leaves behind cannot hold the call open.
export function selectOllamaServer(role, model, { env = process.env, spawn = spawnSync, run = runCommand, timeoutMs = SELECTOR_TIMEOUT_MS } = {}) {
  const file = env.OLLAMA_SELECTOR;
  if (!file) {
    return undefined;
  }
  if (!executable(file)) {
    return { refused: NOT_EXECUTABLE };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-select-"));
  const outFile = path.join(dir, "stdout");
  const errFile = path.join(dir, "stderr");
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  let result;
  try {
    result = spawn(file, [role, model], { stdio: ["ignore", out, err], timeout: timeoutMs, killSignal: "SIGKILL", env });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const stdout = fs.readFileSync(outFile, "utf8");
  const stderr = fs.readFileSync(errFile, "utf8");
  fs.rmSync(dir, { recursive: true, force: true });
  const picked = parseSelectorAnswer({
    status: result.error && result.error.code !== "ETIMEDOUT" ? 127 : result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout,
    stderr: result.error && result.error.code !== "ETIMEDOUT" ? result.error.message : stderr
  });
  if (picked.host) {
    const shown = run("ollama", ["show", model], { env: { ...env, ...ollamaHostEnv(picked.host) } });
    if (shown.error || shown.status !== 0) {
      return { refused: sanitizeReason(`${model} not served by ${picked.host}`) };
    }
  }
  return picked;
}

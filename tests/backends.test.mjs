import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildInvocation, ollamaContextWindow } from "../scripts/lib/backends.mjs";

const io = { cwd: "/repo", promptFile: "/jobs/p.md", outFile: "/jobs/out.md", prompt: "do it" };

test("codex write", () => {
  assert.deepEqual(buildInvocation("codex", { ...io, mode: "write" }), {
    cmd: "codex",
    args: ["exec", "--skip-git-repo-check", "-C", "/repo", "-s", "workspace-write", "-o", "/jobs/out.md", "-"],
    stdinFile: "/jobs/p.md"
  });
});

test("codex read", () => {
  assert.deepEqual(buildInvocation("codex", { ...io, mode: "read" }).args, ["exec", "--skip-git-repo-check", "-C", "/repo", "-s", "read-only", "-o", "/jobs/out.md", "-"]);
});

test("ollama runs through codex --oss", () => {
  assert.deepEqual(buildInvocation("ollama", { ...io, mode: "write", model: "qwen3.6:35b-a3b-coding-mtp-q4_K_M", ossHome: "/data/oss" }), {
    cmd: "codex",
    args: ["exec", "--skip-git-repo-check", "-C", "/repo", "-s", "workspace-write", "-o", "/jobs/out.md", "--oss", "--local-provider", "ollama", "-c", "model_provider=ollama", "-m", "qwen3.6:35b-a3b-coding-mtp-q4_K_M", "-"],
    stdinFile: "/jobs/p.md",
    env: { CODEX_HOME: "/data/oss" }
  });
});

test("ollama with a served window tells codex the window and compacts at 3/4 of it", () => {
  const args = buildInvocation("ollama", { ...io, mode: "read", model: "m", ossHome: "/data/oss", contextWindow: 32768 }).args;
  assert.deepEqual(args.slice(args.indexOf("m") + 1), ["-c", "model_context_window=32768", "-c", "model_auto_compact_token_limit=24576", "-"]);
});

const show = (stdout, status = 0) => () => ({ status, stdout, error: null });
const SHOW = "  Model\n    context length      65536\n\n  Parameters\n    num_ctx             32768\n";

test("ollamaContextWindow reads num_ctx, else the environment, capped at the trained length", () => {
  assert.equal(ollamaContextWindow("m", { run: show(SHOW), env: {} }), 32768);
  assert.equal(ollamaContextWindow("m", { run: show("    context length      65536\n"), env: { OLLAMA_CONTEXT_LENGTH: "16384" } }), 16384);
  assert.equal(ollamaContextWindow("m", { run: show(SHOW.replace("32768", "999999")), env: {} }), 65536);
});

test("ollamaContextWindow is undefined when nothing states the window or ollama show fails", () => {
  assert.equal(ollamaContextWindow("m", { run: show("    context length      65536\n"), env: {} }), undefined);
  assert.equal(ollamaContextWindow("m", { run: show(SHOW, 1), env: {} }), undefined);
  assert.equal(ollamaContextWindow("m", { run: () => ({ status: 0, stdout: "", error: new Error("ENOENT") }), env: {} }), undefined);
});

test("ollama without a model throws", () => {
  assert.throws(() => buildInvocation("ollama", { ...io, mode: "read", ossHome: "/data/oss" }), /OLLAMA_CODING_MODEL not set/);
  assert.throws(() => buildInvocation("ollama", { ...io, mode: "read", model: "m" }), /ossHome/);
});

// The permissions file an agy job runs with, read from the path its argv names.
const agyPermissions = (mode) => {
  const args = buildInvocation("agy", { ...io, mode }).args;
  assert.ok(args.includes("--sandbox"), `${mode} job runs without --sandbox`);
  return JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8")).permissions;
};

test("agy write job edits and runs shell commands in the sandbox", () => {
  const inv = buildInvocation("agy", { ...io, mode: "write" });
  assert.equal(inv.args[inv.args.indexOf("--mode") + 1], "accept-edits");
  assert.equal(inv.stdoutFile, "/jobs/out.md");
  const p = agyPermissions("write");
  assert.deepEqual(p.allow.sort(), ["command(*)", "read_file(*)", "write_file(*)"]);
  // unsandboxed(*) in deny also denies every sandboxed shell command; with no rule, leaving the sandbox ends the run.
  assert.ok(!p.allow.includes("unsandboxed(*)") && !p.deny.includes("unsandboxed(*)"));
});

test("agy read job can only read", () => {
  const args = buildInvocation("agy", { ...io, mode: "read" }).args;
  assert.ok(!args.includes("--mode"), "read job must not run plan mode, which waits for a click");
  const p = agyPermissions("read");
  assert.deepEqual(p.allow, ["read_file(*)"]);
  for (const rule of ["write_file(*)", "command(*)", "read_url(*)", "mcp(*)", "unsandboxed(*)"]) {
    assert.ok(p.deny.includes(rule), `read job does not deny ${rule}`);
  }
});

test("unknown backend throws", () => {
  assert.throws(() => buildInvocation("grok", { ...io, mode: "read" }), /unknown backend grok/);
});

test("agy prompt that starts with a dash stays one value", () => {
  assert.equal(buildInvocation("agy", { ...io, prompt: "- fix a", mode: "read" }).args.at(-1), "-p=- fix a");
});

test("openrouter runs through opencode with a job permission config", () => {
  const inv = buildInvocation("openrouter", { ...io, mode: "write", model: "poolside/laguna-s-2.1:free" });
  assert.equal(inv.cmd, "opencode");
  assert.deepEqual(inv.args, ["run", "--standalone", "-m", "openrouter/poolside/laguna-s-2.1:free", "--agent", "build", "--auto", "--", "do it"]);
  assert.equal(inv.stdoutFile, "/jobs/out.md");
  const { permission } = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(permission.read["*.env"], "deny");
  assert.equal(permission.external_directory, "deny");
});

test("openrouter read uses the plan agent", () => {
  assert.equal(buildInvocation("openrouter", { ...io, mode: "read", model: "m" }).args[5], "plan");
});

test("openrouter without a model throws", () => {
  assert.throws(() => buildInvocation("openrouter", { ...io, mode: "read" }), /openrouter model not configured/);
});

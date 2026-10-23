import assert from "node:assert/strict";
import test from "node:test";

import { buildInvocation } from "../scripts/lib/backends.mjs";

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
    args: ["exec", "--skip-git-repo-check", "-C", "/repo", "-s", "workspace-write", "-o", "/jobs/out.md", "--oss", "--local-provider", "ollama", "-m", "qwen3.6:35b-a3b-coding-mtp-q4_K_M", "-"],
    stdinFile: "/jobs/p.md",
    env: { CODEX_HOME: "/data/oss" }
  });
});

test("ollama without a model throws", () => {
  assert.throws(() => buildInvocation("ollama", { ...io, mode: "read", ossHome: "/data/oss" }), /ollama model not configured/);
  assert.throws(() => buildInvocation("ollama", { ...io, mode: "read", model: "m" }), /ossHome/);
});

test("agy write", () => {
  assert.deepEqual(buildInvocation("agy", { ...io, mode: "write" }), {
    cmd: "agy",
    args: ["--output-format", "text", "--mode", "accept-edits", "--print-timeout", "0s", "--sandbox", "-p", "do it"],
    stdoutFile: "/jobs/out.md"
  });
});

test("agy read", () => {
  assert.deepEqual(buildInvocation("agy", { ...io, mode: "read" }).args, ["--output-format", "text", "--mode", "plan", "--print-timeout", "0s", "-p", "do it"]);
});

test("unknown backend throws", () => {
  assert.throws(() => buildInvocation("grok", { ...io, mode: "read" }), /unknown backend grok/);
});

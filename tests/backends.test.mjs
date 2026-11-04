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
    args: ["exec", "--skip-git-repo-check", "-C", "/repo", "-s", "workspace-write", "-o", "/jobs/out.md", "--oss", "--local-provider", "ollama", "-c", "model_provider=ollama", "-m", "qwen3.6:35b-a3b-coding-mtp-q4_K_M", "-"],
    stdinFile: "/jobs/p.md",
    env: { CODEX_HOME: "/data/oss" }
  });
});

test("ollama without a model throws", () => {
  assert.throws(() => buildInvocation("ollama", { ...io, mode: "read", ossHome: "/data/oss" }), /OLLAMA_CODING_MODEL not set/);
  assert.throws(() => buildInvocation("ollama", { ...io, mode: "read", model: "m" }), /ossHome/);
});

test("agy write", () => {
  assert.deepEqual(buildInvocation("agy", { ...io, mode: "write" }), {
    cmd: "agy",
    args: ["--output-format", "text", "--mode", "accept-edits", "--print-timeout", "0s", "--sandbox", "-p=do it"],
    stdoutFile: "/jobs/out.md"
  });
});

test("agy read", () => {
  assert.deepEqual(buildInvocation("agy", { ...io, mode: "read" }).args, ["--output-format", "text", "--mode", "plan", "--print-timeout", "0s", "-p=do it"]);
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

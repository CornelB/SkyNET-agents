import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkerTree, finishWorkerTree } from "../scripts/lib/worktree.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function repoOn(branch) {
  const repo = tmp("skynet-repo-");
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "switch", "-q", "-c", branch);
  return repo;
}

const branches = (repo) => git(repo, "branch", "--format=%(refname:short)").split("\n");

test("names the branch after the base and dedupes", () => {
  const repo = repoOn("feat/x");
  const scratchDir = tmp("skynet-scratch-");
  const first = createWorkerTree({ repo, backend: "codex", scratchDir, jobId: "j1" });
  const second = createWorkerTree({ repo, backend: "codex", scratchDir, jobId: "j2" });
  assert.equal(first.branch, "feat/x--codex");
  assert.equal(second.branch, "feat/x--codex-2");
  assert.equal(first.base, "feat/x");
  assert.equal(first.path, path.join(scratchDir, "skynet-codex-j1"));
  assert.ok(fs.existsSync(path.join(first.path, "a.txt")));
});

test("merges worker changes and cleans up", () => {
  const repo = repoOn("feat/x");
  const tree = createWorkerTree({ repo, backend: "agy", scratchDir: tmp("skynet-scratch-"), jobId: "j" });
  fs.writeFileSync(path.join(tree.path, "b.txt"), "two\n");
  const done = finishWorkerTree({ repo, backend: "agy", ...tree });
  assert.equal(done.merged, true);
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "two\n");
  assert.ok(!branches(repo).includes("feat/x--agy"));
  assert.ok(!fs.existsSync(tree.path));
});

test("conflict keeps tree and branch", () => {
  const repo = repoOn("feat/x");
  const tree = createWorkerTree({ repo, backend: "codex", scratchDir: tmp("skynet-scratch-"), jobId: "j" });
  fs.writeFileSync(path.join(tree.path, "a.txt"), "worker\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "lead\n");
  git(repo, "commit", "-q", "-am", "lead");
  const done = finishWorkerTree({ repo, backend: "codex", ...tree });
  assert.equal(done.merged, false);
  assert.match(done.line, /conflict/);
  assert.ok(branches(repo).includes("feat/x--codex"));
  assert.ok(fs.existsSync(tree.path));
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("not a git repo throws and creates nothing", () => {
  const dir = tmp("skynet-norepo-");
  const scratchDir = tmp("skynet-scratch-");
  assert.throws(() => createWorkerTree({ repo: dir, backend: "codex", scratchDir, jobId: "j" }), /not a git repo/);
  assert.deepEqual(fs.readdirSync(scratchDir), []);
});

test("detached HEAD throws", () => {
  const repo = repoOn("feat/x");
  git(repo, "switch", "-q", "--detach");
  assert.throws(() => createWorkerTree({ repo, backend: "codex", scratchDir: tmp("skynet-scratch-"), jobId: "j" }), /detached HEAD/);
  assert.deepEqual(branches(repo).filter((b) => b.includes("--")), []);
});

import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";

const git = (cwd, ...args) => runCommand("git", args, { cwd });
const gitChecked = (cwd, ...args) => runCommandChecked("git", args, { cwd }).stdout.trim();

function currentBranch(repo) {
  if (git(repo, "rev-parse", "--git-dir").status !== 0) {
    throw new Error("not a git repo");
  }
  const head = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (head.status !== 0) {
    throw new Error("detached HEAD");
  }
  return head.stdout.trim();
}

function freeBranchName(repo, wanted) {
  const exists = (name) => git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${name}`).status === 0;
  let name = wanted;
  for (let n = 2; exists(name); n += 1) {
    name = `${wanted}-${n}`;
  }
  return name;
}

// Worker branches are <base>--<backend>: a "/" suffix would collide with the base ref.
export function createWorkerTree({ repo, backend, scratchDir, jobId }) {
  const base = currentBranch(repo);
  const branch = freeBranchName(repo, `${base}--${backend}`);
  const treePath = path.join(scratchDir, `skynet-${backend}-${jobId}`);
  gitChecked(repo, "worktree", "add", "-q", "-b", branch, treePath, base);
  return { path: treePath, branch, base };
}

// Parallel workers can finish together; one merge at a time into the user's tree.
function withMergeLock(repo, timeoutMs, fn) {
  const lock = path.resolve(repo, gitChecked(repo, "rev-parse", "--git-common-dir"), "skynet-merge.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        return null;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmdirSync(lock);
  }
}

function cleanup(repo, treePath, branch) {
  gitChecked(repo, "worktree", "remove", "--force", treePath);
  gitChecked(repo, "branch", "-D", branch);
}

export function finishWorkerTree({ repo, path: treePath, branch, base, backend, lockTimeoutMs = 120_000 }) {
  gitChecked(treePath, "add", "-A");
  const hasChanges = git(treePath, "diff", "--cached", "--quiet").status !== 0;
  if (hasChanges) {
    gitChecked(treePath, "commit", "-q", "-m", `chore(${backend}): delegated work`);
  }
  if (git(treePath, "rev-list", "--count", `${base}..${branch}`).stdout.trim() === "0") {
    cleanup(repo, treePath, branch);
    return { merged: true, state: "merged", line: `${branch}: no changes` };
  }
  const outcome = withMergeLock(repo, lockTimeoutMs, () => {
    if (git(repo, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim() !== base) {
      return { merged: false, state: "pending", line: `${branch}: kept, ${repo} is not on ${base}` };
    }
    const merge = git(repo, "merge", "--no-ff", "-q", "-m", `merge ${branch}`, branch);
    if (merge.status !== 0) {
      if (git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status === 0) {
        git(repo, "merge", "--abort");
      }
      return { merged: false, state: "conflict", line: `${branch}: conflict with ${base}, kept at ${treePath}` };
    }
    cleanup(repo, treePath, branch);
    return { merged: true, state: "merged", line: `${branch}: merged into ${base}` };
  });
  return outcome ?? { merged: false, state: "pending", line: `${branch}: merge lock busy, kept at ${treePath}` };
}

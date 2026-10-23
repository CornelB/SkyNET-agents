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

function cleanup(repo, treePath, branch) {
  gitChecked(repo, "worktree", "remove", "--force", treePath);
  gitChecked(repo, "branch", "-D", branch);
}

export function finishWorkerTree({ repo, path: treePath, branch, base, backend }) {
  gitChecked(treePath, "add", "-A");
  const hasChanges = git(treePath, "diff", "--cached", "--quiet").status !== 0;
  if (hasChanges) {
    gitChecked(treePath, "commit", "-q", "-m", `chore(${backend}): delegated work`);
  }
  if (git(treePath, "rev-list", "--count", `${base}..${branch}`).stdout.trim() === "0") {
    cleanup(repo, treePath, branch);
    return { merged: true, line: `${branch}: no changes` };
  }
  if (git(repo, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim() !== base) {
    return { merged: false, line: `${branch}: kept, ${repo} is not on ${base}` };
  }
  const merge = git(repo, "merge", "--no-ff", "-q", "-m", `merge ${branch}`, branch);
  if (merge.status !== 0) {
    git(repo, "merge", "--abort");
    return { merged: false, line: `${branch}: conflict with ${base}, kept at ${treePath}` };
  }
  cleanup(repo, treePath, branch);
  return { merged: true, line: `${branch}: merged into ${base}` };
}

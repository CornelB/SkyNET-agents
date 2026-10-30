---
description: Delegate work to Codex, Antigravity, OpenRouter or local Ollama, picked by live usage. Use to hand off or offload a self-contained piece to an external worker, or when told to delegate to Codex, agy or Ollama to save Claude usage. To split work across several agents or Claude subagents, use /skynet:workflow.
argument-hint: '[what to delegate]'
allowed-tools: Bash(node:*), Bash(git:*)
---

Delegate this: $ARGUMENTS

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs"`.

1. Run `<cli> route`. Line 1 is the backend pick, line 2 the hand-off level from Claude's own usage. If line 1 starts with `no backend:`, show it and stop.
2. Decide what to hand off. The request above is the floor. The hand-off level says how much more of the current task to give away: `hand off what was named`, `hand off any part a worker can do alone`, or `hand off everything but orchestration and diff review`.
3. For each piece, write a brief of at most 15 lines: goal, files or paths, constraints, done-when. The worker has none of this conversation.
4. Pick the mode yourself: `write` to fix or implement, `read` to review, investigate or explain.
5. Start each piece without waiting. Pass the brief on stdin with a quoted heredoc, never inside quotes on the command line:
   ```
   <cli> delegate --mode <write|read> [--paths a,b] [--parallel] <<'BRIEF'
   <brief>
   BRIEF
   ```
   Add `--parallel` to every writer when more than one writer runs at the same time; each gets its own worktree and branch, merged back when it finishes.
6. Show only the line each start prints (`<job-id> → <backend> (...)`). Then one Bash call, `run_in_background: true`, for all job ids: `<cli> wait <id> [<id> ...] --any --timeout-s 3000`. It prints each finished job's output and status line and returns at the first finish; exit 3 means others still run, so run it again for the ids left. Keep working meanwhile.
7. When a job ends, read its output. For a write job, read `git diff` (or the merge line), then keep or revert the changes. Report one line per job.

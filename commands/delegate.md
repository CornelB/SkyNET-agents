---
description: '[Delegate] a task; hand it to Codex, Antigravity, OpenRouter or local Ollama, picked by live usage. Use to hand off or offload a self-contained piece to an external worker, or when told to delegate to Codex, agy or Ollama to save Claude usage. Workers are offline: a piece that needs the network, an MCP server, a connector or the browser stays with Claude. To split work across several agents or Claude subagents, use /skynet:workflow.'
argument-hint: '[task] to delegate'
allowed-tools: Bash(node:*), Bash(git:*)
---

Delegate this: $ARGUMENTS

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs"`.

1. Run `<cli> route`. It prints the hand-off level, from Claude's own usage and from subscription quota that would go unused.
2. Decide what to hand off. The request above is the floor. The hand-off level says how much more of the current task to give away: `hand off what was named`, `hand off any part a worker can do alone`, or `hand off everything but orchestration and diff review`.
   A worker is offline: it takes local work only, the files and the shell inside the repo. A piece that needs a remote host or service (ssh, HTTP, a package install, a git fetch or push), an MCP server, a connector, the browser or this session's credentials stays with you or a Claude subagent. This beats the floor, the hand-off level and a backend the user named. When the request itself is such a piece, say `not delegated: <what it needs>` and do it.
3. For each piece, write a brief of at most 15 lines: goal, files or paths, constraints, done-when. The worker has none of this conversation. Split a piece that has a remote part: fetch remote logs or data into a local file first and name that file in the brief, and apply any remote change yourself after the job.
4. Pick the mode yourself: `write` to fix or implement, `read` to review, investigate or explain. Pick the tier the piece needs: `haiku` for small, mechanical, easily checked work; `sonnet` for implementation and scoped research; `opus` for ambiguous or cross-cutting work and substantive review; `fable` only when the user asks for it or the final result needs the strongest reasoning. skynet picks the backend and a model of that tier or better.
5. Start each piece without waiting. Pass the brief on stdin with a quoted heredoc, never inside quotes on the command line:
   ```
   <cli> delegate --mode <write|read> --tier <tier> [--needs-shell] [--backend <name>] [--not <backend>] [--paths a,b] [--parallel] <<'BRIEF'
   <brief>
   BRIEF
   ```
   `--needs-shell`: the piece must run builds or tests. `--backend`: only when the user named a vendor (Antigravity or Google is `agy`, Codex or OpenAI is `codex`). `--not`: a backend this piece already failed on.
   Add `--parallel` to every writer when more than one writer runs at the same time; each gets its own worktree and branch, merged back when it finishes.
6. Show only the line each start prints. `<job-id> → <backend> <model> (...)`: the job runs. `→ claude <tier> (...)` with exit 4: no job started, because no backend has a model of that tier with quota and a free slot; run that piece yourself as a subagent of that tier. `no backend: ...` with exit 1: no job; do the piece yourself. Then one Bash call, `run_in_background: true`, for all job ids: `<cli> wait <id> [<id> ...] --any --timeout-s 3000`. It prints each finished job's output and status line and returns at the first finish; exit 3 means others still run, so run it again for the ids left. Run `wait` from the directory the jobs were started in; elsewhere it answers "No job found". Keep working meanwhile.
7. When a job ends, read its output. For a write job, read `git diff` (or the merge line), then keep or revert the changes. A job that failed goes again at the same tier with `--not <its backend>`. Report one line per job.

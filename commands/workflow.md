---
description: '[Workflow] Split workload to multiple sub-agents; plan and run delegated work: split a task into bounded pieces and give each to yourself, a Claude subagent with model and effort set, or a Codex, Antigravity, OpenRouter or Ollama worker picked by live usage. Use it first, before any other command, whenever the user says fan out, use agents or subagents, spawn agents or workers, orchestrate, split or distribute the workload, run in parallel, or names Haiku, Sonnet, Opus, Fable or Codex for parts of a task. Also for task delegation, research that would flood the context, or saving Claude usage.'
argument-hint: '[task] to split and delegate'
allowed-tools: Bash(node:*), Bash(git:*), Bash(python3:*)
---

Plan and run this: $ARGUMENTS

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs"`.

1. Do it yourself when delegation adds nothing: one grep or glob, one query, a known set of files, a mechanical edit. Say `no fan-out: <reason>` and do the task. Zero agents is a valid plan.
2. Delegate only when one of these holds:
   - the work splits into independent pieces that can progress in parallel;
   - a search is open-ended enough that its output would flood this context;
   - a piece needs a different model or effort than this session;
   - an independent review or comparison has a clear benefit.
3. Read usage: `<cli> route` (the hand-off level: how much leaves this session) and `python3 "${CLAUDE_PLUGIN_ROOT}/skills/usage/scripts/ai_usage.py" --provider claude` (the `Fable only` window).
4. Split the work. Each piece has one objective, the minimum inputs, constraints, a deliverable, and how you will check it. Dependent pieces run in order. Use the fewest agents that cover the work; no duplicate assignments unless comparison is the point. You own the synthesis.
5. Pick the tier, then the executor, for each piece. A model or backend the user named wins, except over the external-worker condition.
   - **Tier**: `haiku` for small, mechanical, easily checked work; `sonnet` for implementation and scoped research; `opus` for ambiguous or cross-cutting work and substantive review; `fable` only when the user asks for it or the final result needs the strongest reasoning.
   - **External worker** (`skynet`): self-contained code, review or investigation that needs nothing from this conversation. A worker is offline: it takes local work only, so no remote host or service (ssh, HTTP, a package install, a git fetch or push) and no Claude-only tools (MCP servers, connectors, the browser, this session's credentials). Hand off more of these as the hand-off level rises. skynet picks the backend and a model of the piece's tier or better.
   - **Claude subagent** (Agent tool): everything else, on the model of the piece's tier. Never Fable when `Fable only` is above 80%: use Opus.
   - **Effort**: pass `effort` on every Agent call, `medium` unless the piece is unusually hard, high-stakes, or a failed retry (raise) or trivial (`low`). An unset `effort` runs at the agent's default, not the level you chose.
6. Show the plan, one line per piece, and nothing else: `<n>. <piece> → <self | haiku/low | sonnet/medium | opus/high | skynet write <tier> | skynet read <tier>>`.
7. Start all independent pieces in one message.
   - Claude subagent: a brief with goal, paths, constraints, done-when; set `model` and `effort`.
   - External worker: start each one without waiting, brief on stdin with a quoted heredoc. Split a piece that has a remote part: fetch remote logs or data into a local file first and name it in the brief, and apply any remote change yourself after the job. Run `wait` from the directory the jobs were started in. `--needs-shell`: the piece must run builds or tests. `--backend`: only when the user named a vendor (Antigravity or Google is `agy`, Codex or OpenAI is `codex`). `--not`: a backend this piece already failed on. Add `--parallel` to every writer when more than one writer runs at the same time.
     ```
     <cli> delegate --mode <write|read> --tier <tier> [--needs-shell] [--backend <name>] [--not <backend>] [--paths a,b] [--parallel] <<'BRIEF'
     <brief of at most 15 lines>
     BRIEF
     ```
     Each start prints one line:
     - `<job-id> → <backend> <model> (...)`: the job runs.
     - `→ claude <tier> (...)`, exit 4: no job. No backend has a model of that tier with quota and a free slot; run the piece as a Claude subagent of that tier.
     - `no backend: ...`, exit 1: no job. Do the piece yourself.

     Then one Bash call, `run_in_background: true`, for all job ids: `<cli> wait <id> <id> ... --any --timeout-s 3000`. It prints each finished job's output and status line and returns at the first finish; exit 3 means others still run, so run it again for the ids left. `<cli> status` shows every job's mode, title, branch and merge state.
8. Check every result before you use it: read the diff of each write job, test the claims of each read. A job that failed goes again at the same tier with `--not <its backend>`. A result that fails its check goes again one tier up; at `fable`, do the piece yourself. Never keep a diff you have not read. Report one line per piece.

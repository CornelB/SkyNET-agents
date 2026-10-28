# SkyNET agents: usage-aware delegation

Status: approved 2026-10-23.

## Intent

A Claude Code plugin that lets the lead agent of a session hand work to other harnesses as subagents. The purpose is to stretch quota: Claude and Codex windows last longer while the work still gets done. The user says "delegate this"; the plugin picks the backend from live usage and the installer's cost setup. The user never names a model.

## Goals

- One delegation entry point for three backends: Codex, Antigravity (`agy`), local Ollama.
- Backend choice from live usage (codexbar) and a per-machine cost config.
- Claude's own usage drives how much the lead delegates: more as Claude fills up.
- Workers edit files directly, like a native Claude subagent. The lead reviews the diff.
- Parallel writers in one repo, split by path, each in its own throwaway worktree.
- One job list across backends: status, result, cancel.
- Terse. Every plugin output is one line unless the user asks for detail.

## Non-goals

- Reviews. `review-board` covers them. No review, adversarial-review, or stop-time review gate.
- Session transfer.
- Grok as a delegation target. The usage skill may still report it.
- Cross-repo delegation. A session delegates inside its own repo.
- Naming a model per call.
- Pushing worker branches.

## Anti-goals (failure even if it works)

- Chatty output: multi-line announcements, progress narration, recaps.
- Delegation that costs the lead more tokens than it saves (long briefs, re-reading large diffs, redoing bad output).
- Manual babysitting: approval prompts, hand merges, chasing stuck jobs.
- Ollama output that must be redone, so quota is spent twice.

## Decided

- **From scratch, no fork.** The plugin does not fork `openai/codex-plugin-cc`. Generic job plumbing (job control, tracked jobs, state, process, args, fs) may be copied; copied files keep their Apache-2.0 notice and the repo gets a `NOTICE`. The `agy` invocation pattern (flags, output parsing, fake-CLI test fixture) comes from `thepushkarp/cc-gemini-plugin`.
- **No app-server broker.** Every backend is a plain CLI job:
  - Codex: `codex exec`, sandbox `workspace-write` (write) or `read-only`.
  - Antigravity: `agy -p` with its sandbox and auto-approved tools.
  - Ollama: `codex exec --oss --local-provider ollama`, so Ollama gets the Codex harness, sandbox and edit tools. No agent loop of our own.
- **`skynet:usage`.** The `ai-usage` skill moves from SkyNET-skills into this plugin and is deleted there. Codex loses the skill. `review-board` (SkyNET-review, `scripts/lib/codex-usage.py`) looks for it at the plugin's install path; without skynet installed it falls back to its existing `codex app-server` source.
- **`skynet:setup`.** Detects which backends are on PATH and logged in, checks `codexbar`, lists pulled Ollama models, asks how each backend is paid (subscription quota, pay per token, local). Writes a gitignored machine-local config. A backend setup did not enable is never routed to.
- **`skynet:delegate`** command plus a matching subagent type. Input: a brief, a mode (write or read-only), optional paths. The lead picks the mode, never the worker.
- **`skynet:status`, `skynet:result`, `skynet:cancel`** over all backends.
- **Routing.** Before each delegation, read usage (`--json`). Full thresholds come from the usage skill: 5h at 90% or more, week or model window at 95% or more. Order: enabled, not-full subscription backends with the most room first; then Ollama; pay-per-token last. Ollama is never first because it is free. Pay-per-token means a backend logged in with an API key instead of a plan (e.g. Codex with an OpenAI API key, Ollama cloud models); setup records which applies. The choice is announced in one line, e.g. `→ agy (codex week 96%)`.
- **Claude usage shapes delegation, only when asked.** No hook, no per-turn cost. When the user says "delegate", the lead also reads Claude's usage and hands off more of the task as Claude fills.
- **Worktrees.** A single writer uses the main tree. Each extra parallel writer gets a worktree under the session scratchpad, on a local branch cut from the feature branch tip. On finish the lead reviews the diff, merges it into the feature branch, removes the worktree and deletes the branch. Overlapping files: the lead resolves or sends one worker back.
- **Plugin `skynet` lives in `SkyNET-agents`.** Marketplace and remote are deferred until decided; local install for now.
- **Migration.** Once skynet works, remind the user to uninstall the `codex` and `cc-gemini-plugin` plugins.

## Builder's calls (marked as such)

- Worker branch name: `<feature-branch>--<backend>` (a `/` suffix collides with the parent ref). Any non-colliding scheme is fine.
- "Prefer Ollama" mark below the full threshold: 75% on the 5h or week window. Tune later.
- How much to hand off once asked: Claude week below 70%, delegate only what the user named; 70% or more, also any part a worker can do alone; 90% or more, everything except orchestration and diff review. Tune later.
- Antigravity window: the window of agy's configured default model; if unknown, the highest of its model windows.
- Language: Node `.mjs` for the runtime (matches the copied plumbing), Python for the usage script (as it is today).
- Default Ollama model, config file name and location, job state directory.
- Brief format and result format, as long as both stay short.

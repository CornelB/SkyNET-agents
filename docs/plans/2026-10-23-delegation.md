# SkyNET delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin `skynet` that routes delegated work to Codex, Antigravity or local Ollama by live usage and runs it as tracked background jobs.

**Architecture:** One Node CLI `scripts/skynet.mjs` with subcommands (`setup`, `route`, `delegate`, `worker`, `status`, `result`, `cancel`). Pure modules for config, routing and argv building; job plumbing copied from `openai/codex-plugin-cc`. Usage comes from the moved `usage` skill (`ai_usage.py --json`). Slash commands and one subagent type are thin wrappers that call the CLI.

**Tech Stack:** Node 22 ESM, `node:test`, no npm dependencies. Python 3 for `ai_usage.py`. CLIs: `codex` 0.164, `agy` 1.4.6, `ollama`, `codexbar`.

**Spec:** `docs/specs/2026-10-23-delegation.md`

## Global Constraints

- Plugin name `skynet`. Commands `skynet:setup`, `skynet:delegate`, `skynet:status`, `skynet:result`, `skynet:cancel`; skill `skynet:usage`; agent `skynet:delegate`.
- Backends: `codex`, `agy`, `ollama`. Grok is never a target.
- Full: 5h `>= 90`, week `>= 95`, applicable model window `>= 95`. Near full: 5h or week `>= 75`.
- Route order: subscription not near full (most room first) → ollama → subscription near full → pay-per-token. Never a full, disabled, errored or no-data backend.
- Hand-off level from Claude week: `< 70` named, `>= 70` independent, `>= 90` all.
- Every CLI output is one line per item. No progress narration.
- Config: `$XDG_CONFIG_HOME/skynet/config.json` (default `~/.config/skynet/config.json`), never in the repo.
- Worker branch: `<feature-branch>--<backend>`, local only, never pushed. Worktrees under the session scratchpad.
- Files copied from codex-plugin-cc keep an Apache-2.0 header line; root `NOTICE` names the source.
- Usage skill rules carry over: never `codexbar usage --provider all`, never read `~/.config/codexbar/config.json`, never use reset credits.

## Review Focus

1. `codexbar` missing or failing entirely → cloud backends have no data; route must fall to ollama with reason `no usage data`, not crash. Test in Task 4.
2. Not a git repo, or detached HEAD, when a parallel writer needs a worktree → one-line error, no partial branch left. Test in Task 6.
3. Backend CLI exits non-zero or hangs → job ends `failed` with the CLI's last stderr line; cancel kills the process tree. Test in Task 7.
4. Antigravity windows are model windows only (`Gemini Models`, `Claude and GPT`); with no configured window the highest counts. Test in Task 4.
5. All backends full → no job starts; line names the earliest reset time. Test in Task 4.

---

### Task 1: Plugin scaffold and copied job plumbing

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `NOTICE`
- Create (copy from `~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/lib/`): `scripts/lib/{process,args,fs,state,tracked-jobs,job-control,workspace}.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Produces: the copied modules' existing exports unchanged, except: `SESSION_ID_ENV = "SKYNET_SESSION_ID"`; state dir prefix `skynet`; `job-control.mjs` no longer imports `codex.mjs` (drop the `getSessionRuntimeStatus` enrichment).
- `marketplace.json`: name `skynet-local`, one plugin `skynet`, source `./`. (Real marketplace deferred.)

- [ ] **Step 1:** Write `tests/state.test.mjs`: `upsertJob(cwd, {id, status:"running"})` then `listJobs(cwd)` returns that job; `generateJobId("dlg")` starts with `dlg-`. Use a temp cwd and set the state root env var the copied `state.mjs` honours to a temp dir.
- [ ] **Step 2:** `node --test tests/` → FAIL (modules missing).
- [ ] **Step 3:** Copy the seven modules, apply the three edits above, add the header line `// Derived from openai/codex-plugin-cc (Apache-2.0). See NOTICE.` Write `plugin.json` (name, version `0.1.0`, description, author CornelB, license MIT), `marketplace.json`, `package.json` (`"type":"module"`, `"test":"node --test tests/"`), `NOTICE`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: scaffold skynet plugin with job plumbing`.

### Task 2: Usage skill moved in

**Files:**
- Create: `skills/usage/SKILL.md`, `skills/usage/scripts/ai_usage.py` (copy from `SkyNET-skills/skills/ai-usage/`; drop `agents/openai.yaml`)
- Create: `scripts/lib/usage.mjs`, `tests/fixtures/fake-codexbar.mjs`
- Test: `tests/usage.test.mjs`

**Interfaces:**
- Produces: `readUsage({python="python3", env}={}) -> Promise<UsageEntry[]>` where `UsageEntry = {provider, source, windows:[{name, used_percent, resets_at, lasts_to_reset}], error}` (the `--json` shape). On script exit 2 or spawn failure returns `[]`.

- [ ] **Step 1:** Tests: with `PATH` pointing at a dir holding `fake-codexbar` (prints a fixture JSON), `readUsage()` returns 3 entries and `codex` window `5h` has `used_percent` 38. With no codexbar on `PATH`, returns `[]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Copy the skill. In `SKILL.md`: name `usage`, script path `scripts/ai_usage.py` relative to the skill, delegation example `/skynet:delegate`. Implement `readUsage` via `execFile` of the script with `--json`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(usage): move ai-usage skill into skynet`.

### Task 3: Config and setup detection

**Files:**
- Create: `scripts/lib/config.mjs`
- Test: `tests/config.test.mjs`

**Interfaces:**
- Produces:
  - `configPath(env=process.env) -> string`
  - `loadConfig(env) -> Config`; missing file → `{backends:{}}`
  - `saveConfig(cfg, env) -> void` (mkdir, mode 0600)
  - `Config = {backends: {codex?, agy?, ollama?: {enabled:boolean, billing:"subscription"|"per-token"|"local", model?:string, window?:string}}}`
  - `detectBackends({run}) -> {codex:{installed, loggedIn}, agy:{installed}, ollama:{installed, models:string[]}, codexbar:{installed}}`. `run` is `runCommand` from `process.mjs` (injectable for tests). Codex login from `codex login status` containing `Logged in`; ollama models from `ollama list` column 1.

- [ ] **Step 1:** Tests: round trip save/load under a temp `XDG_CONFIG_HOME`; file mode is `0600`; `detectBackends` with a stub `run` returning `Logged in using ChatGPT` and an `ollama list` table yields `codex.loggedIn === true` and `ollama.models` `["qwen3.6:35b-a3b", ...]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(config): add machine-local config and backend detection`.

### Task 4: Router

**Files:**
- Create: `scripts/lib/router.mjs`
- Test: `tests/router.test.mjs`

**Interfaces:**
- Consumes: `UsageEntry[]` (Task 2), `Config` (Task 3).
- Produces:
  - `route(usage, config) -> {backend: "codex"|"agy"|"ollama"|null, line: string}`
  - `handoffLevel(usage) -> {level: "named"|"independent"|"all", line: string}` from provider `claude`, window `week`; no data → `named`.
  - Provider map: `codex`→`codex`, `antigravity`→`agy`. Ollama has no usage entry and is never full.
  - Relevant windows: codex `5h`, `week`; agy the window named `config.backends.agy.window`, else the max of all its windows (treated as a model window, full at `>= 95`).
  - Room = `100 - max(relevant used_percent)`.
  - `line` format: `→ agy (codex week 96%)` naming the first skipped higher-ranked backend and why (`full`, `near full`, `error`, `no usage data`, `disabled`); all unavailable → `no backend: codex 5h full until 14:41, ollama disabled` naming the earliest reset as local `HH:MM`.

- [ ] **Step 1:** Tests, one per rule, with spec values:
  - codex 5h 38 week 6, agy 1 → `agy` (room 99 beats codex 62).
  - codex 5h 90 → codex full; agy enabled → `agy`, line contains `codex 5h 90%`.
  - codex week 95 → full.
  - codex 5h 80, agy 80, ollama enabled → `ollama` (both near full).
  - codex 5h 80, ollama disabled, agy disabled → `codex`.
  - codex `billing:"per-token"` not full, ollama enabled → `ollama`.
  - usage `[]`, ollama enabled → `ollama`, line contains `no usage data`.
  - agy windows 96 and 0, no `window` config → full.
  - all full, ollama disabled → `backend:null`, line starts `no backend:`.
  - `handoffLevel` at claude week 69 / 70 / 90 → `named` / `independent` / `all`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement as tiers: `[subscription && !near, ollama, subscription && near, per-token]`, sort tier 1 by room descending, take the first available.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(router): pick backend from usage and config`.

### Task 5: Backend invocations

**Files:**
- Create: `scripts/lib/backends.mjs`
- Test: `tests/backends.test.mjs`

**Interfaces:**
- Produces: `buildInvocation(backend, {mode:"write"|"read", cwd, promptFile, outFile, model?}) -> {cmd, args, stdinFile?}`. Exact argv:
  - codex: `codex exec --skip-git-repo-check -C <cwd> -s <workspace-write|read-only> -o <outFile> -` with stdin from `promptFile`.
  - ollama: same as codex plus `--oss --local-provider ollama -m <model>` (model from config, required).
  - agy: `agy -p --output-format text --disable-slash-commands --mode <accept-edits|plan> --print-timeout 0s` (write adds `--sandbox`), prompt on stdin, stdout captured to `outFile` by the worker; cwd set on spawn.

- [ ] **Step 1:** Tests assert the exact `args` arrays for codex write, codex read, ollama write with model `qwen3.6:35b-a3b-coding-mtp-q4_K_M`, agy write, agy read; ollama without model throws `ollama model not configured`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(backends): build codex, agy and ollama invocations`.

### Task 6: Worker worktrees

**Files:**
- Create: `scripts/lib/worktree.mjs`
- Test: `tests/worktree.test.mjs`

**Interfaces:**
- Produces:
  - `createWorkerTree({repo, backend, scratchDir}) -> {path, branch, base}`: base = current branch; branch = `<base>--<backend>`, suffix `-2`, `-3` if taken; path = `<scratchDir>/skynet-<backend>-<jobId>`. Throws `not a git repo` / `detached HEAD` before creating anything.
  - `finishWorkerTree({repo, path, branch, base}) -> {merged:boolean, line}`: commits the worker's changes in the tree (`chore(<backend>): delegated work`), merges `--no-ff` into `base` in `repo`; on conflict aborts the merge and keeps tree and branch (`line` says so); on success `git worktree remove` and `git branch -d`.

- [ ] **Step 1:** Tests on a temp repo with branch `feat/x`: branch name `feat/x--codex`; second call gives `feat/x--codex-2`; a change in the tree merges into `feat/x` and the branch is gone; a conflicting change leaves the branch and returns `merged:false`; temp dir that is not a repo throws `not a git repo` and creates no branch; detached HEAD throws `detached HEAD`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `runCommandChecked("git", ...)`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(worktree): create and merge worker worktrees`.

### Task 7: CLI and job lifecycle

**Files:**
- Create: `scripts/skynet.mjs`, `tests/fixtures/fake-codex.mjs`, `tests/fixtures/fake-agy.mjs`
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces subcommands (all print one line per item):
  - `setup [--enable codex,agy,ollama] [--billing codex=subscription,...] [--ollama-model M] [--agy-window NAME]` → without flags prints detection, one line per backend; with flags saves config.
  - `route` → `route()` line plus `handoffLevel()` line.
  - `delegate --mode write|read [--paths a,b] [--parallel] [--backend B] -- <brief>` (`--backend` only for tests and explicit override) → routes, writes brief to job dir, spawns detached `worker <jobId>`, prints `<jobId> → <backend> (<reason>)`. `--parallel` uses `createWorkerTree` and `CLAUDE_SCRATCHPAD` (fallback `os.tmpdir()`); otherwise the main tree.
  - `worker <jobId>` → runs `buildInvocation`, tracks with `runTrackedJob`, on finish of a parallel job calls `finishWorkerTree`. Status `completed` / `failed` (with the CLI's last stderr line).
  - `status [jobId]`, `result <jobId>` (prints `outFile` content, which may be long), `cancel <jobId>` (`terminateProcessTree`).

- [ ] **Step 1:** Tests with fixtures on `PATH`: `delegate --backend codex --mode read -- hi` prints a line matching `/^dlg-\S+ → codex/`; after the worker exits `status` shows `completed` and `result` prints the fake output; a fake that exits 3 with stderr `boom` ends `failed` with `boom`; a fake that sleeps is `cancel`led and its pid is gone; routing with all full prints `no backend:` and starts no job.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(cli): delegate, status, result and cancel`.

### Task 8: Commands, agent and docs

**Files:**
- Create: `commands/{setup,delegate,status,result,cancel}.md`, `agents/delegate.md`, `README.md` (replace), `docs/reference/configuration.md`

**Interfaces:**
- Consumes: CLI from Task 7 via `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs"`.
- `setup.md`: runs `setup`, asks the billing per detected backend with one AskUserQuestion, saves, prints the saved lines.
- `delegate.md` and `agents/delegate.md` (tools: Bash): run `route`; apply the hand-off level to decide what to delegate; write a short brief (goal, paths, done-when); pick mode (write for fix/implement, read for review/investigate/explain); `--parallel` when another writer is running in this tree; print only the CLI's line. After completion: read `git diff`, keep or revert.
- `configuration.md`: every config key and default; no machine values.

- [ ] **Step 1:** Install locally: `claude plugin marketplace add /work/SkyNET/SkyNET-agents` and `claude plugin install skynet@skynet-local`. Verify `claude plugin list` shows `skynet`.
- [ ] **Step 2:** Run `/skynet:setup` then `/skynet:delegate` with a read-only brief in a scratch repo; expect one routing line and a completed job.
- [ ] **Step 3:** Commit `feat: add skynet commands, agent and docs`.

### Task 9: Cut over other repos

**Files:**
- Modify: `SkyNET-review/scripts/lib/codex-usage.py:35-40` (`read_ai_usage` roots)
- Delete: `SkyNET-skills/skills/ai-usage/`

- [ ] **Step 1:** In `codex-usage.py`, look for `ai_usage.py` under `~/.claude/plugins/cache/*/skynet/*/skills/usage/scripts/` (newest version dir) before the old roots; keep the existing `live` and `snapshot` fallbacks. Run SkyNET-review's `bats tests/` → PASS.
- [ ] **Step 2:** Commit in SkyNET-review `fix(codex): read usage from the skynet plugin`. Push.
- [ ] **Step 3:** `git rm -r skills/ai-usage` in SkyNET-skills; commit `refactor: move ai-usage into the skynet plugin`. Push.
- [ ] **Step 4:** Remind the user to uninstall the `codex` and `cc-gemini-plugin` plugins.

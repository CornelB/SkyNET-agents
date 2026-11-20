# Ollama Server Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional user-owned executable, `OLLAMA_SELECTOR`, picks the Ollama server for the delegate `ollama` backend and the review-board `codex-oss` seat.

**Architecture:** SkyNET-agents gets one module (`scripts/lib/selector.mjs`) that runs and parses the selector; the router takes its answer in place of the GPU read, the job record carries the chosen server, and the worker passes it to codex and `ollama show`. SkyNET-review gets the same contract in bash inside `codex-oss.sh`'s gate. Unset variable = no new code path runs.

**Tech Stack:** Node 22 ESM + `node:test` (SkyNET-agents); bash 3.2-compatible + bats + shellcheck (SkyNET-review).

**Spec:** `docs/specs/2026-11-20-ollama-selector.md`

## Global Constraints

- Selector call: `$OLLAMA_SELECTOR <role> <model>`, role `coding` or `review`, stdin empty, stdout to a temporary file, cap 10 seconds.
- Server line regex: `^(http://)?[A-Za-z0-9._-]+:[0-9]+/?$`; U = line with `http://` added when absent, trailing `/` removed. First stdout line only, trimmed.
- Fixed reasons, verbatim: `OLLAMA_SELECTOR not executable`, `selector exit <n>`, `selector timed out`, `selector killed by <signal>`, `selector printed <line>`, `<model> not served by <U>`.
- Reasons: control characters removed, cut to 300 characters.
- With U: `OLLAMA_HOST=U` and `CODEX_OSS_BASE_URL=U/v1` for codex and the plugin's own `ollama` calls.
- With `OLLAMA_SELECTOR` unset, every existing test passes unchanged and no output changes.
- No host, model tag or rule of the user in either repo (tests use `127.0.0.1:11435` and model `m`).
- bash: no GNU-only tools (`timeout`, `sed -i` without suffix); use `rc_run_capped`.

## Review Focus

1. A selector that starts a background child holding stdout: the call returns after the selector exits, not when the child does. Tests in Task 1 and Task 4.
2. A reason with ESC, CR or `|`: the JSON status files and the `seat|status|detail` line stay parseable (bash also maps `|` to `/`). Tests in Task 1 and Task 4.
3. Selector set, model variable unset: the selector is not called and today's "not set" errors stay. Tests in Task 3 and Task 4.
4. `delegate --backend codex` with a selector set: the selector does not run. Test in Task 3.
5. The worker never calls the selector again: one selector call for `delegate --backend ollama --wait`. Test in Task 3.

---

### Task 0: Spec touch-ups

**Files:** Modify `docs/specs/2026-11-20-ollama-selector.md`

- [ ] **Step 1:** SkyNET-agents item 4: drop "the `ollama ps` check in `readGpu` runs against U" (item 3 no longer consults `readGpu` with a selector); keep the status line naming the server: `ollama <U>, selected` or `ollama default server, selected`.
- [ ] **Step 2:** Contract rule 3: "killed with SIGKILL" applies to Node; bash relies on `rc_run_capped`'s kill and its 124 marker.
- [ ] **Step 3:** Commit with this plan: `docs(plan): ollama server selector`.

### Task 1: Selector module (SkyNET-agents)

**Files:**
- Create: `scripts/lib/selector.mjs`
- Test: `tests/selector.test.mjs`

**Interfaces:**
- Produces:
  - `SELECTOR_TIMEOUT_MS = 10000`
  - `sanitizeReason(text: string): string`
  - `parseSelectorAnswer({ status: number|null, signal: string|null, timedOut: boolean, stdout: string, stderr: string }): { host: string|null } | { refused: string }`
  - `selectOllamaServer(role: "coding"|"review", model: string, { env = process.env, spawn = spawnSync, run = runCommand, timeoutMs = SELECTOR_TIMEOUT_MS } = {}): undefined | { host: string|null } | { refused: string }` — `undefined` when `env.OLLAMA_SELECTOR` is unset or empty.
  - `ollamaHostEnv(host: string|null): {} | { OLLAMA_HOST: string, CODEX_OSS_BASE_URL: string }`

- [ ] **Step 1: Write the failing tests** in `tests/selector.test.mjs`:
  - `parseSelectorAnswer`: `{status:0, stdout:""}` → `{host:null}`; `"  127.0.0.1:11435  \nignored\n"` → `{host:"http://127.0.0.1:11435"}`; `"http://h:1/"` → `{host:"http://h:1"}`; `"https://h:1"` → `{refused:"selector printed https://h:1"}`; `"h"` → `{refused:"selector printed h"}`; `{status:3, stderr:"a\nbusy\n\n"}` → `{refused:"busy"}`; `{status:3, stderr:""}` → `{refused:"selector exit 3"}`; `{timedOut:true}` → `{refused:"selector timed out"}`; `{status:null, signal:"SIGTERM"}` → `{refused:"selector killed by SIGTERM"}`.
  - `sanitizeReason("\x1b[31mred\r")` → `"[31mred"`; a 400-character string → length 300.
  - `selectOllamaServer`: `OLLAMA_SELECTOR` unset and `""` → `undefined`, spawn not called; `"rel/path"`, a missing absolute path and a non-executable temp file → `{refused:"OLLAMA_SELECTOR not executable"}`.
  - With a real executable temp script that prints `127.0.0.1:11435` and an injected `run` that returns status 0: `{host:"http://127.0.0.1:11435"}`, and `run` was called with `("ollama", ["show","m"], {env})` where `env.OLLAMA_HOST === "http://127.0.0.1:11435"`. With `run` returning status 1: `{refused:"m not served by http://127.0.0.1:11435"}`. Empty output: `{host:null}` and `run` not called. The script receives argv `coding m` (script writes `$@` to a file the test reads).
  - Real script `sleep 5` with `timeoutMs: 300` → `{refused:"selector timed out"}` in under 3 s.
  - Real script `sleep 5 & echo 127.0.0.1:1` (background child holds stdout) → host answer in under 3 s.
  - `ollamaHostEnv(null)` → `{}`; `ollamaHostEnv("http://h:1")` → `{OLLAMA_HOST:"http://h:1", CODEX_OSS_BASE_URL:"http://h:1/v1"}`.
- [ ] **Step 2:** `node --test tests/selector.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement** `scripts/lib/selector.mjs`. Executable check: `path.isAbsolute` + `fs.accessSync(p, fs.constants.X_OK)` + `statSync().isFile()`. Spawn: `spawn(p, [role, model], { stdio: ["ignore", fd, "pipe"], timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", env })` with `fd` opened on a file in `fs.mkdtempSync(os.tmpdir())`; `timedOut = result.error?.code === "ETIMEDOUT"`; read and remove the file and its directory afterwards. Do not use `runCommand` for the selector (drops `timeout`, maps a signal to status 0). Sanitize with `/[\x00-\x08\x0b-\x1f\x7f]/g`.
- [ ] **Step 4:** `node --test tests/selector.test.mjs` → PASS; `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(ollama): selector module that picks the server for a job`.

### Task 2: Router takes the selector's answer (SkyNET-agents)

**Files:** Modify `scripts/lib/router.mjs` (`assess`, `route`); Test `tests/router.test.mjs`

**Interfaces:**
- Consumes: the answer shape of `selectOllamaServer`.
- Produces: `route(usage, config, gpu, selection)`; `selection` is `undefined` (today's behaviour) or the selector answer.

- [ ] **Step 1: Failing tests:**
  - `route([codex(10, 6), agy(10)], cfg(), undefined, { host: "http://127.0.0.1:11435" })` → backend `ollama`, line matches `/^→ ollama \(ollama http:\/\/127\.0\.0\.1:11435, selected,/`.
  - `{ host: null }` → status `ollama default server, selected`, backend `ollama`.
  - `{ refused: "busy" }` with codex room → backend `codex`, line contains `ollama skipped, busy`; with everything else disabled → `no backend: ..., ollama skipped, busy`.
- [ ] **Step 2:** `node --test tests/router.test.mjs` → FAIL.
- [ ] **Step 3: Implement.** In `assess` for `ollama`, `selection` wins over `gpu`: refused → `{ available: false, status: "ollama skipped, <reason>" }`; else `{ available: true, tier: 0, room: 0, status: "ollama <host ?? 'default server'>, selected" }`. `route` passes `selection` through.
- [ ] **Step 4:** `npm test` → PASS (all existing router tests unchanged).
- [ ] **Step 5:** Commit `feat(ollama): route on the selector's answer instead of the local GPU`.

### Task 3: CLI, worker, invocation and docs (SkyNET-agents)

**Files:**
- Modify: `scripts/skynet.mjs` (`ollamaGpu`, `routeCommand`, `delegate`, `worker`), `scripts/lib/backends.mjs` (`ollamaContextWindow`, `buildInvocation`), `docs/reference/configuration.md` (Environment table, "local server" paragraph, GPU idle row)
- Create: `tests/fixtures/bin/ollama` (`show` prints `context length 131072`; appends `OLLAMA_HOST=<value>` to `$FAKE_OLLAMA_LOG` when set; exits 0)
- Modify: `tests/fixtures/bin/codex` (appends `CODEX_OSS_BASE_URL=<value>` to `$FAKE_CODEX_ENV_LOG` when set)
- Test: `tests/backends.test.mjs`, `tests/cli.test.mjs`

**Interfaces:**
- Consumes: `selectOllamaServer`, `ollamaHostEnv` (Task 1); `route(..., selection)` (Task 2).
- Produces: `ollamaContextWindow(model, { run, env, host })` — `host` (string|null) adds `ollamaHostEnv(host)` to the `ollama show` spawn env; `buildInvocation(backend, { ..., ollamaHost })` merges `ollamaHostEnv(ollamaHost)` into the ollama invocation `env`; job record field `ollamaHost: string|null`.

- [ ] **Step 1: Failing tests.**
  - `backends.test.mjs`: `buildInvocation("ollama", {..., ollamaHost: "http://h:1"}).env` deep-equals `{ CODEX_HOME, OLLAMA_HOST: "http://h:1", CODEX_OSS_BASE_URL: "http://h:1/v1" }`; without `ollamaHost`, `{ CODEX_HOME }` as today. `ollamaContextWindow("m", { run, host: "http://h:1" })` calls `run` with `options.env.OLLAMA_HOST === "http://h:1"`; without `host`, no `env` option.
  - `cli.test.mjs` (config with ollama enabled, `OLLAMA_CODING_MODEL=m`, a selector script in the test temp dir that prints `127.0.0.1:11435` and appends a line to a marker file per call):
    - `delegate --backend ollama --mode read --wait -- hi` → exit 0; stored job `ollamaHost === "http://127.0.0.1:11435"`; `$FAKE_CODEX_ENV_LOG` has `CODEX_OSS_BASE_URL=http://127.0.0.1:11435/v1`; `$FAKE_OLLAMA_LOG` has `OLLAMA_HOST=http://127.0.0.1:11435`; marker file has exactly 1 line.
    - Same with ollama disabled in config → still runs the selector (marker 1 line) and uses U.
    - Selector `echo busy >&2; exit 1` → `delegate --backend ollama` exits 1, stderr contains `busy`, no job in `status`.
    - `delegate --backend codex` with the selector set → marker file absent.
    - `route` → first line matches `/^→ ollama \(ollama http:\/\/127\.0\.0\.1:11435, selected/`, second line contains `GPU idle`.
    - Selector set, `OLLAMA_CODING_MODEL` unset, `--backend ollama` → today's `OLLAMA_CODING_MODEL not set` error, marker absent.
- [ ] **Step 2:** `npm test` → the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `skynet.mjs`: `ollamaSelection()` = `ollamaModel() ? selectOllamaServer("coding", ollamaModel()) : undefined`. Auto-route (`routeCommand`, `delegate` without `--backend`): when ollama is enabled, `selection = ollamaSelection()`; `gpu` is read only when `selection === undefined`; `route(usage, config, gpu, selection)`; hand-off `ollamaIdle` = `selection ? !selection.refused : gpu !== undefined && gpuIdle(gpu)`. `--backend ollama`: `selection = ollamaSelection()`; refused → print the reason to stderr, return 1 before `buildInvocation`. Job record `ollamaHost: backend === "ollama" && selection && !selection.refused ? selection.host : null`.
  - `worker`: `ollamaContextWindow(job.model, { host: job.ollamaHost })`; `buildInvocation(..., ollamaHost: job.ollamaHost)`.
  - Docs per spec "Docs", with the spec's generic example selector.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(ollama): delegate runs ollama jobs on the server the selector picks`.
- [ ] **Step 6:** Release commit `chore: release 0.10.0` bumping `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `.codex-plugin/plugin.json`. Push.

### Task 4: codex-oss seat (SkyNET-review)

**Files:**
- Modify: `scripts/seats/codex-oss.sh` (`seat_gate`, `seat_describe`, new `ollama_select`), `tests/test_helper.bash` (unset list, `fake_codex` env log, new `fake_selector`), `tests/tribunal.bats` (`fake_ollama_show`: log `OLLAMA_HOST`, `FAKE_SHOW_FAIL=1` exits 1), `tests/discovery.bats`, `skills/review-engine/SKILL.md:74`, `docs/DESIGN.md:62`, `README.md`
- Move `fake_ollama_show` into `tests/test_helper.bash` so `discovery.bats` can use it.

**Interfaces:**
- `ollama_select` (bash function): returns 0 and, with U, exports `OLLAMA_HOST=U`, `CODEX_OSS_BASE_URL=U/v1`, sets `RC_OLLAMA_URL=U`; returns 1 with `GATE_REASON` set on refusal. Called in `seat_gate` right after the `OLLAMA_REVIEWER_MODEL` check (codex-oss.sh:28), before the `RC_DIFF_FILE` return (:29).
- `fake_selector <body>`: writes `$BATS_TEST_TMPDIR/select` (`#!/usr/bin/env bash` + body), `chmod +x`, exports `OLLAMA_SELECTOR` to it.

- [ ] **Step 1: Failing tests** (`discovery.bats`, with `fake_codex`, `fake_ollama_show`, `OLLAMA_REVIEWER_MODEL=qwen3-coder`):
  - `fake_selector 'echo 127.0.0.1:11435'` → `codex-oss|available|ollama qwen3-coder @ http://127.0.0.1:11435, read-only sandbox`.
  - `fake_selector 'exit 0'` → `codex-oss|available|ollama qwen3-coder, read-only sandbox`.
  - `fake_selector 'echo busy >&2; exit 1'` → `codex-oss|disabled|busy`; `'exit 3'` → `codex-oss|disabled|selector exit 3`.
  - `OLLAMA_SELECTOR=rel/select` and a non-executable file → `codex-oss|disabled|OLLAMA_SELECTOR not executable`.
  - `fake_selector 'echo nope'` → `codex-oss|disabled|selector printed nope`.
  - `fake_selector 'printf "\033[31ma|b\r\n" >&2; exit 1'` → `codex-oss|disabled|[31ma/b`.
  - `FAKE_SHOW_FAIL=1` with a host → `codex-oss|disabled|qwen3-coder not served by http://127.0.0.1:11435`.
  - `fake_selector 'sleep 30'` → `codex-oss|disabled|selector timed out` (the only 10 s test).
  - `fake_selector 'sleep 30 & echo 127.0.0.1:11435'` → available, in under 5 s.
  - Selector set, `OLLAMA_REVIEWER_MODEL` unset → `codex-oss|disabled|OLLAMA_REVIEWER_MODEL not set`, selector not called.
  - `tribunal.bats`: with `fake_selector 'echo 127.0.0.1:11435'`, `tribunal run -s codex-oss` → `$FAKE_LOG.base` lines all `http://127.0.0.1:11435/v1`, `$FAKE_LOG.ollama_host` lines all `http://127.0.0.1:11435`; with `'echo busy >&2; exit 1'` the run output contains `codex-oss|busy` as the context-size test does today.
- [ ] **Step 2:** `bats tests` → new tests FAIL.
- [ ] **Step 3: Implement** `ollama_select`: absolute + `-f` + `-x` check; `rc_run_capped 10 "$OLLAMA_SELECTOR" review "$OLLAMA_REVIEWER_MODEL" </dev/null >"$out" 2>"$err"`; 124 → timed out; rc > 128 → `selector killed by signal $((rc - 128))`; non-zero → last non-empty stderr line; first stdout line trimmed and matched with `case`/`grep -E` on the global regex; then `ollama show "$OLLAMA_REVIEWER_MODEL"` under the exported `OLLAMA_HOST`. Reasons through one helper: `tr -d '\000-\010\013-\037\177' | tr '|' '/'`, last non-empty line, `cut -c1-300`. Temp files via `mktemp`, removed with `rm -f`. `seat_describe` adds ` @ $RC_OLLAMA_URL` when set.
- [ ] **Step 4:** `bats tests` and `shellcheck scripts/*.sh scripts/lib/*.sh scripts/seats/*.sh` → PASS.
- [ ] **Step 5:** Docs (SKILL.md gate row, DESIGN.md:62, README env section) pointing to the contract. Commit `feat(codex-oss): run the seat on the server the ollama selector picks`.
- [ ] **Step 6:** `chore: bump review-board to 0.6.0 so installs pick up the ollama selector` bumping `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`. Push.

### Task 5: The user's own selector (outside both repos)

**Files:** the user's selector script, in a location the user owns. Nothing in either SkyNET repo.

- [ ] **Step 1:** Script per the contract: the models that need the second server → that server's `host:port`; every other model → print nothing (default server). Busy rule: when the other server's `/api/ps` lists a model, exit 1 with `<server> holds <names>` on stderr. No unload, no pull.
- [ ] **Step 2:** Check by hand: a listed model prints the second server while the default server holds nothing; another model prints nothing; with a model loaded on the other server, exit 1 and the reason.
- [ ] **Step 3:** Give the user the one-line `settings.json` change (`"OLLAMA_SELECTOR": "<path>"` in `env`); do not write that file.

### Task 6: Live check

- [ ] **Step 1:** No benchmark is using the Ollama servers; both servers are running.
- [ ] **Step 2:** With a throwaway selector in the scratchpad that prints the second server for the smallest installed model: one `delegate --backend ollama --mode read --wait` from the SkyNET-agents checkout and one `scripts/run-tribunal.sh` codex-oss lens from SkyNET-review, both with `OLLAMA_SELECTOR` set on the command only.
- [ ] **Step 3:** Evidence: the second server's log shows the requests in the window, the default server's does not. `ollama stop <model>` against that server right after. Evidence stays out of the repos.

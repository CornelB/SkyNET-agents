# Ollama server selector

Applies to the two invocations of `codex exec --oss` against Ollama:

- SkyNET-agents: the `ollama` delegation backend (`scripts/skynet.mjs`, `scripts/lib/backends.mjs`, `scripts/lib/gpu.mjs`, `scripts/lib/router.mjs`), role `coding`, model `OLLAMA_CODING_MODEL`.
- SkyNET-review: the `codex-oss` tribunal seat (`scripts/seats/codex-oss.sh`), role `review`, model `OLLAMA_REVIEWER_MODEL`.

## Problem

Both plugins talk to one Ollama server: `localhost:11434` for `codex --oss`, and the ambient `OLLAMA_HOST` (default the same address) for the `ollama` CLI. A user can run more than one Ollama server, for example one per GPU backend, where each model runs well on one server only. Nothing in the plugins can send a role's model to a different server, and the rule that picks the server differs per machine.

## Goal

The user keeps choosing each role's model with the existing environment variables. An optional, user-owned program answers which server runs that model. The plugins ship the contract only; no server address, model name or rule of any user is added to either repo, and nothing the user writes is lost when a plugin updates.

A fixed server per role (`OLLAMA_CODING_HOST`, `OLLAMA_REVIEWER_HOST`) would be smaller, but the rule the user needs depends on more than the role: model name, which server holds a model, free VRAM.

## Contract

1. `OLLAMA_SELECTOR` (environment, set in the `env` block of Claude Code `settings.json` like the model variables): the absolute path of an executable. Unset or empty: both plugins behave exactly as today, and no selector code path runs. Set to a path that is not absolute, does not exist or is not executable: refusal `OLLAMA_SELECTOR not executable`, checked before any call.
2. Call: `$OLLAMA_SELECTOR <role> <model>`. `<role>` is `coding` or `review`. `<model>` is the role's model variable, verbatim. stdin is empty; the environment is inherited. stdout goes to a temporary file, not a pipe, so a child the selector leaves behind cannot hold the call open.
3. Cap: 10 seconds, then the selector is killed.
   - Node: its own `spawnSync` with `timeout` and `killSignal: "SIGKILL"`. `runCommand` in `scripts/lib/process.mjs` drops `timeout` and maps a signal death to status 0, so it is not used here.
   - Bash: `rc_run_capped` from `scripts/lib/common.sh` (no GNU `timeout`; the repo also runs on macOS bash 3.2); its kill and 124 marker.
4. Answer. Only the first line of stdout counts, trimmed; later lines are ignored.
   - Exit 0, first line empty: the default server, as today.
   - Exit 0, first line matches `^(http://)?[A-Za-z0-9._-]+:[0-9]+/?$`: the server for this job. U is that line with `http://` added when absent and a trailing `/` removed.
   - Exit 0, any other first line: refusal `selector printed <line>`.
   - Non-zero exit: refusal with the last non-empty stderr line as the reason, else `selector exit <n>`.
   - Cap reached: refusal `selector timed out`. Death by another signal: refusal `selector killed by <signal>`.
   - Every reason has control characters removed and is cut to 300 characters, like `cell_error` in SkyNET-review `scripts/run-tribunal.sh`, because it lands in JSON status files.
5. With U, every Ollama call of that job goes to U:
   - the plugin's own `ollama` CLI calls (`show`, `ps`) run with `OLLAMA_HOST=U`;
   - codex runs with `CODEX_OSS_BASE_URL=U/v1`. codex 0.171.0 ignores `OLLAMA_HOST` (verified 2026-11-20); the plugins set it for codex too only because one environment serves both.
6. With U, `ollama show <model>` against U must succeed, else refusal `<model> not served by <U>`. This covers a server that is down and a model the server does not have, and keeps codex from pulling the model onto U. Without a selector, a failing `ollama show` keeps today's meaning ("no context window").
7. The selector runs more than once per job (`route` then `delegate`; discovery then each lens) and also for jobs that end on another backend. It must be quick and must have no side effects: it does not load, unload or pull models.
8. The selector decides on any criteria the user wants. The plugins pass no other input and read no other output.

## SkyNET-agents

1. The selector runs where `ollama` is assessed or forced:
   - `route` and the auto-route of `delegate`, when the `ollama` backend is enabled and `OLLAMA_CODING_MODEL` is set;
   - `delegate --backend ollama`, whenever `OLLAMA_CODING_MODEL` is set. This path skips `route()` and the `enabled` flag today (`scripts/skynet.mjs`, `delegate`).
2. A refusal makes `ollama` unavailable for routing, with status `ollama skipped, <reason>`, and it does not count as an idle GPU for the hand-off level. `delegate --backend ollama` fails with the same reason before it creates a job.
3. Idle rule with a selector: any answer other than a refusal (U or the default server) counts as idle, so `ollama` ranks first and the hand-off level rises as with an idle GPU today. The selector already judges whether its server is free; the local amdgpu read can describe a card the selected server does not use. With a selector set, `readGpu` is not consulted for the idle decision.
4. With a selector answer, the status line names the server: `ollama <U>, selected` or `ollama default server, selected`. With `OLLAMA_SELECTOR` unset the status stays `ollama local, ...` (pinned in `tests/router.test.mjs`).
5. The job record stores U as `ollamaHost` (`null` for the default server). The worker uses the stored value for `ollamaContextWindow` and for the invocation environment; it does not call the selector again. `ollamaContextWindow` already takes `env` for `OLLAMA_CONTEXT_LENGTH`; the spawn environment gets a parameter of its own.
6. `setup` (`ollama list`) is unchanged.

## SkyNET-review

1. `seat_gate` of `codex-oss` runs the selector right after the `OLLAMA_REVIEWER_MODEL` check and before the `RC_DIFF_FILE` early return, so discovery and `/review-board:status` (no diff file) run it too, and `ollama_ctx` reads the served context from U. The gate runs in the seat's main shell, for discovery (`-c`) and for each lens: each lens asks again, and only the server or a refusal can change between lenses, not the model.
2. A refusal gates the seat off: `codex-oss|disabled|<reason>` in discovery, `codex-oss|skipped|<reason>` for a lens.
3. With U, the seat exports `OLLAMA_HOST` and `CODEX_OSS_BASE_URL` for `ollama_ctx` and `seat_invoke`. `seat_describe` names the server: `ollama <model> @ <U>, read-only sandbox`.
4. The seat contract in `scripts/lib/seat.sh` and the other seats do not change.

## Docs

- SkyNET-agents `docs/reference/configuration.md`: `OLLAMA_SELECTOR` in the Environment table with the contract and the example below; the "local server" paragraph and the GPU-idle routing row say what changes with a selector.
- SkyNET-review `skills/review-engine/SKILL.md` and `docs/DESIGN.md` (codex-oss gate rows) and `README.md`: the same variable, pointing to the contract.

Example selector, generic (not shipped as a file):

```bash
#!/usr/bin/env bash
# ollama-select <role> <model>: print the server for this model; print nothing for the default server; exit 1 to skip Ollama.
case "$2" in
  *-big*) echo 127.0.0.1:11435 ;;
esac
```

## Not in scope

- claude-council, which reads one `OLLAMA_HOST` for the session.
- Which server is busy: that is the selector's own rule (rule 7 rules out unloading).
- Model choice: it stays with `OLLAMA_CODING_MODEL` and `OLLAMA_REVIEWER_MODEL`.
- `https` servers.

## Known limits

- The `OLLAMA_CONTEXT_LENGTH` fallback for the context window is read from the client's environment and applied to whichever server is selected.

## Acceptance

- Bats (SkyNET-review):
  - `tests/test_helper.bash` unsets `OLLAMA_SELECTOR`, `OLLAMA_HOST` and `CODEX_OSS_BASE_URL`; the fake codex and the fake ollama record both variables.
  - Unset selector: the codex-oss argv and environment are unchanged.
  - A selector that prints `127.0.0.1:11435`: the fake codex sees `CODEX_OSS_BASE_URL=http://127.0.0.1:11435/v1`, the fake ollama sees `OLLAMA_HOST=http://127.0.0.1:11435`.
  - Empty output: default. Non-zero exit with a stderr line: `disabled|<line>` and `skipped|<line>`. Not executable, malformed line, `ollama show` failing on U, a reason with control characters: refused with the fixed or sanitised reasons. The timeout case runs once, through `codex-oss.sh -c`.
- Node (SkyNET-agents):
  - The selector reader for each case of rule 4 with an injected spawner, signal death included.
  - Routing with a refusal marks `ollama` unavailable with the reason; with U, the `ollama ps` call carries `OLLAMA_HOST`. `--backend ollama` runs the selector with the backend disabled.
  - A CLI test with an `ollama` stub in `tests/fixtures/bin` and a fake codex that records its environment: the job record stores `ollamaHost`, and the worker's codex and `ollama show` calls carry the variables.
  - With the variable unset, every existing test passes unchanged.
- Live: one delegate job and one codex-oss lens on the smallest installed model, routed by a selector to a second server. Evidence: that server's log shows the requests, the default server's does not. `ollama stop` right after. Live evidence (hosts, model tags) stays out of the repo.

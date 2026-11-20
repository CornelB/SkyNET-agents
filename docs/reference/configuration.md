# Configuration

skynet reads one machine-local file: `$XDG_CONFIG_HOME/skynet/config.json`, default `~/.config/skynet/config.json`, mode `0600`. `/skynet:setup` writes it. It is never part of the repo.

```json
{
  "backends": {
    "codex":  { "enabled": true,  "billing": "subscription" },
    "agy":    { "enabled": true,  "billing": "subscription", "window": "Gemini Models" },
    "openrouter": {
      "enabled": false,
      "billing": "free",
      "models": { "reasoning": "<model id>", "coding": "<model id>", "decision": "<model id>", "fallback": "<model id>" }
    },
    "ollama": { "enabled": true,  "billing": "local" }
  }
}
```

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `backends.<name>.enabled` | `true`, `false` | `false` | A backend that is not enabled is never picked. Setup enables only the backends named in `--enable`. Keep openrouter off on the free tier: free models share a small daily request cap, and one job spends many requests. |
| `backends.<name>.billing` | `subscription`, `per-token`, `local`, `free` | `subscription`; `local` for ollama; `free` for openrouter | `per-token` backends rank after ollama. |
| `backends.openrouter.models.reasoning` | an openrouter.ai model id | `thinkingmachines/inkling-small:free` | Model for read jobs. |
| `backends.openrouter.models.coding` | an openrouter.ai model id | `poolside/laguna-s-2.1:free` | Model for write jobs. |
| `backends.openrouter.models.decision` | an openrouter.ai model id | `nvidia/nemotron-3.5-lightning:free` | Small, fast classifier model. Saved only; no job uses it yet. |
| `backends.openrouter.models.fallback` | an openrouter.ai model id | `openrouter/free` | A job that fails with a rate limit (`429`, "rate limit") retries once on this model. The free router picks a random free model per request. |
| `backends.agy.window` | a codexbar window name | none: the highest agy window | The Antigravity usage window that counts for routing. |

| `timeoutMinutes` | minutes | `60` | A job still running after this is killed and recorded as failed (`timed out`). `delegate --timeout-s` overrides it per job. |

Backend names: `codex`, `agy`, `openrouter`, `ollama`.

Delegation treats every worker as offline: a task that needs a remote host or service (ssh, HTTP, a package install, a git fetch or push), an MCP server, a connector, the browser or the session's credentials stays with Claude. Codex, Ollama and agy shells have no network. An OpenRouter job has network but no sandbox, and its provider can log prompts, so it gets no remote work either.

Codex and Ollama jobs run in the codex sandbox (`-s read-only` or `workspace-write`, network off by default), so their shell has no network; codex itself still reaches the model, and for Ollama that is the local server, or the server `OLLAMA_SELECTOR` picks: `ssh` fails with "Could not resolve hostname" and a permission error on `/etc/ssh/ssh_config.d/*`, so a remote log read comes back as an access failure, not as "nothing matched". Fetch remote data into a local file first. A job is registered under the directory it was started from; `wait`, `result`, `status` and `cancel` run from another directory do not see it ("No job found").

Every write job gets a scratch dir, `$TMPDIR/skynet-job-<job id>` (`/tmp` when `TMPDIR` is unset), created before the worker starts. The prompt every backend receives tells the worker to put helper scripts, test harnesses and other scratch files there, never in the work tree, and to change only the files the brief asks for. Codex `workspace-write` includes the temp dir, agy's write settings allow `write_file(*)` (its sandbox shell still cannot write anywhere), and the OpenRouter job config allows `$TMPDIR/skynet-job-*` and no other path outside the tree. skynet does not delete scratch dirs; `/tmp` clears them on reboot.

Ollama jobs run codex with its own empty `CODEX_HOME` (`<job state root>/codex-oss-home`), so the user's codex config, MCP servers, skills and `AGENTS.md` do not reach the local model.

agy jobs run `agy --sandbox --settings <file>`. The file is this plugin's own: `scripts/agy-settings-read.json` for read jobs, `scripts/agy-settings-write.json` for write jobs. It replaces the permissions in `~/.gemini/antigravity-cli/settings.json` for that run only; model and project still come from that file, which skynet never writes. Read jobs may only read files; writes, shell, URL reads, MCP and leaving the sandbox are denied. Write jobs may read, write and run shell commands with `--mode accept-edits`; URL reads and MCP are denied, and a request to leave the sandbox ends the job (a `deny` rule for `unsandboxed` would also deny every sandboxed shell command). The sandbox shell is read-only and has no network, so builds and tests that write files fail: give those jobs to codex. agy's `search_web` tool cannot be turned off.

OpenRouter jobs run `opencode run --standalone --auto`, with `--agent build` for write and `--agent plan` for read. `opencode` reads `OPENROUTER_API_KEY` from the environment. Each job sets `OPENCODE_CONFIG_CONTENT` to deny reads of `.env` files, paths outside the job's tree other than the job scratch dirs (`$TMPDIR/skynet-job-*`, below), and questions. Free OpenRouter endpoints can log prompts, so the brief and the files the model reads leave the machine. opencode has no sandbox: a write job runs shell commands as the user. A write job's fallback retry starts from the tree the first attempt left, partial edits included.

## Environment

| Variable | Meaning |
|----------|---------|
| `CLAUDE_PLUGIN_DATA` | Job state root. Default: `<tmpdir>/skynet`. |
| `CLAUDE_SCRATCHPAD` | Where `--parallel` worktrees go. Default: the system temp dir. |
| `OLLAMA_CODING_MODEL` | An `ollama list` name. The model that ollama jobs run (`codex exec --oss --local-provider ollama -c model_provider=ollama -m <model>`) and that the GPU-idle `ollama ps` check looks for. Required for ollama jobs. Set it in the `env` block of Claude Code `settings.json`. |
| `OLLAMA_SELECTOR` | Optional. The absolute path of an executable that picks the Ollama server for each ollama job; see [Ollama selector](#ollama-selector). Set it in the `env` block of Claude Code `settings.json`. Unset: the default server. |
| `SKYNET_SESSION_ID` | When set, `status`, `result` and `cancel` without a job id see only this session's jobs. |

## Routing

| Rule | Value |
|------|-------|
| Full | 5h at 90% or more; week or model window at 95% or more |
| Near full | any counted window at 75% or more |
| Order | subscription with room (most room first), free openrouter, ollama, subscription near full, per-token |
| GPU idle | ollama enabled and, with `OLLAMA_SELECTOR` set, any selector answer other than a refusal (a refusal takes ollama out of routing); without a selector, the amdgpu card with the most VRAM under 20% busy with under half its VRAM in use, or `ollama ps` lists `OLLAMA_CODING_MODEL`. Ollama then ranks first. No amdgpu card: the order above applies. |
| Hand-off level (Claude week) | below 70%: what was named; 70% or more: any part a worker can do alone; 90% or more: everything but orchestration and diff review. GPU idle raises "what was named" to "any part a worker can do alone". |

## Ollama selector

`OLLAMA_SELECTOR` lets a machine run more than one Ollama server and send each model to the server that runs it well. The model stays `OLLAMA_CODING_MODEL`; the selector only names the server. The same variable drives the review-board `codex-oss` seat (role `review`). Full contract: [the spec](../specs/2026-11-20-ollama-selector.md).

- Call: `$OLLAMA_SELECTOR coding <model>`, stdin empty, 10 seconds at most. It runs on every `route` and auto-routed `delegate` while ollama is enabled, and on `delegate --backend ollama`, so it must be quick and must not load, unload or pull models.
- Answer: print `host:port` (or `http://host:port`) to run there; print nothing for the default server; exit non-zero to keep the job off Ollama, with the reason on the last stderr line.
- With a server, codex gets `CODEX_OSS_BASE_URL=http://host:port/v1` and skynet's own `ollama` calls get `OLLAMA_HOST`. A server that cannot `ollama show` the model is a refusal.
- Any answer other than a refusal counts as an idle GPU for routing.
- The selector is the user's file, outside this plugin: plugin updates do not touch it.

```bash
#!/usr/bin/env bash
# ollama-select <role> <model>: print the server for this model; print nothing for the default server; exit 1 to skip Ollama.
case "$2" in
  *-big*) echo 127.0.0.1:11435 ;;
esac
```

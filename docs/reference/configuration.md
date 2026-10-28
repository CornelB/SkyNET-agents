# Configuration

skynet reads one machine-local file: `$XDG_CONFIG_HOME/skynet/config.json`, default `~/.config/skynet/config.json`, mode `0600`. `/skynet:setup` writes it. It is never part of the repo.

```json
{
  "backends": {
    "codex":  { "enabled": true,  "billing": "subscription" },
    "agy":    { "enabled": true,  "billing": "subscription", "window": "Gemini Models" },
    "openrouter": {
      "enabled": true,
      "billing": "free",
      "models": { "reasoning": "<model id>", "coding": "<model id>", "decision": "<model id>" }
    },
    "ollama": { "enabled": true,  "billing": "local", "model": "<pulled model>" }
  }
}
```

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `backends.<name>.enabled` | `true`, `false` | `false` | A backend that is not enabled is never picked. |
| `backends.<name>.billing` | `subscription`, `per-token`, `local`, `free` | `subscription`; `local` for ollama; `free` for openrouter | `per-token` backends rank after ollama. |
| `backends.ollama.model` | an `ollama list` name | none, required for ollama | Model that `codex exec --oss --local-provider ollama` runs. |
| `backends.openrouter.models.reasoning` | an openrouter.ai model id | `thinkingmachines/inkling-small:free` | Model for read jobs. |
| `backends.openrouter.models.coding` | an openrouter.ai model id | `poolside/laguna-s-2.1:free` | Model for write jobs. |
| `backends.openrouter.models.decision` | an openrouter.ai model id | `nvidia/nemotron-3.5-lightning:free` | Small, fast classifier model. Saved only; no job uses it yet. |
| `backends.agy.window` | a codexbar window name | none: the highest agy window | The Antigravity usage window that counts for routing. |

| `timeoutMinutes` | minutes | `60` | A job still running after this is killed and recorded as failed (`timed out`). `delegate --timeout-s` overrides it per job. |

Backend names: `codex`, `agy`, `openrouter`, `ollama`.

Ollama jobs run codex with its own empty `CODEX_HOME` (`<job state root>/codex-oss-home`), so the user's codex config, MCP servers, skills and `AGENTS.md` do not reach the local model.

OpenRouter jobs run `opencode run --standalone --auto`, with `--agent build` for write and `--agent plan` for read. `opencode` reads `OPENROUTER_API_KEY` from the environment. Each job sets `OPENCODE_CONFIG_CONTENT` to deny reads of `.env` files, paths outside the job's tree and questions. Free OpenRouter endpoints can log prompts, so the brief and the files the model reads leave the machine. opencode has no sandbox: a write job runs shell commands as the user.

## Environment

| Variable | Meaning |
|----------|---------|
| `CLAUDE_PLUGIN_DATA` | Job state root. Default: `<tmpdir>/skynet`. |
| `CLAUDE_SCRATCHPAD` | Where `--parallel` worktrees go. Default: the system temp dir. |
| `SKYNET_SESSION_ID` | When set, `status`, `result` and `cancel` without a job id see only this session's jobs. |

## Routing

| Rule | Value |
|------|-------|
| Full | 5h at 90% or more; week or model window at 95% or more |
| Near full | any counted window at 75% or more |
| Order | subscription with room (most room first), free openrouter, ollama, subscription near full, per-token |
| Hand-off level (Claude week) | below 70%: what was named; 70% or more: any part a worker can do alone; 90% or more: everything but orchestration and diff review |

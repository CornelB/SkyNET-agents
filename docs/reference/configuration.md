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

Ollama jobs run codex with its own empty `CODEX_HOME` (`<job state root>/codex-oss-home`), so the user's codex config, MCP servers, skills and `AGENTS.md` do not reach the local model.

OpenRouter jobs run `opencode run --standalone --auto`, with `--agent build` for write and `--agent plan` for read. `opencode` reads `OPENROUTER_API_KEY` from the environment. Each job sets `OPENCODE_CONFIG_CONTENT` to deny reads of `.env` files, paths outside the job's tree and questions. Free OpenRouter endpoints can log prompts, so the brief and the files the model reads leave the machine. opencode has no sandbox: a write job runs shell commands as the user. A write job's fallback retry starts from the tree the first attempt left, partial edits included.

## Environment

| Variable | Meaning |
|----------|---------|
| `CLAUDE_PLUGIN_DATA` | Job state root. Default: `<tmpdir>/skynet`. |
| `CLAUDE_SCRATCHPAD` | Where `--parallel` worktrees go. Default: the system temp dir. |
| `OLLAMA_CODING_MODEL` | An `ollama list` name. The model that ollama jobs run (`codex exec --oss --local-provider ollama -c model_provider=ollama -m <model>`) and that the GPU-idle `ollama ps` check looks for. Required for ollama jobs. Set it in the `env` block of Claude Code `settings.json`. |
| `SKYNET_SESSION_ID` | When set, `status`, `result` and `cancel` without a job id see only this session's jobs. |

## Routing

| Rule | Value |
|------|-------|
| Full | 5h at 90% or more; week or model window at 95% or more |
| Near full | any counted window at 75% or more |
| Order | subscription with room (most room first), free openrouter, ollama, subscription near full, per-token |
| GPU idle | ollama enabled and the amdgpu card with the most VRAM under 20% busy with under half its VRAM in use, or `ollama ps` lists `OLLAMA_CODING_MODEL`. Ollama then ranks first. No amdgpu card: the order above applies. |
| Hand-off level (Claude week) | below 70%: what was named; 70% or more: any part a worker can do alone; 90% or more: everything but orchestration and diff review. GPU idle raises "what was named" to "any part a worker can do alone". |

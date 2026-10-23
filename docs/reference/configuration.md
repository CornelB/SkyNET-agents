# Configuration

skynet reads one machine-local file: `$XDG_CONFIG_HOME/skynet/config.json`, default `~/.config/skynet/config.json`, mode `0600`. `/skynet:setup` writes it. It is never part of the repo.

```json
{
  "backends": {
    "codex":  { "enabled": true,  "billing": "subscription" },
    "agy":    { "enabled": true,  "billing": "subscription", "window": "Gemini Models" },
    "ollama": { "enabled": true,  "billing": "local", "model": "<pulled model>" }
  }
}
```

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `backends.<name>.enabled` | `true`, `false` | `false` | A backend that is not enabled is never picked. |
| `backends.<name>.billing` | `subscription`, `per-token`, `local` | `subscription`; `local` for ollama | `per-token` backends rank after ollama. |
| `backends.ollama.model` | an `ollama list` name | none, required for ollama | Model that `codex exec --oss --local-provider ollama` runs. |
| `backends.agy.window` | a codexbar window name | none: the highest agy window | The Antigravity usage window that counts for routing. |

| `timeoutMinutes` | minutes | `60` | A job still running after this is killed and recorded as failed (`timed out`). `delegate --timeout-s` overrides it per job. |

Backend names: `codex`, `agy`, `ollama`.

Ollama jobs run codex with its own empty `CODEX_HOME` (`<job state root>/codex-oss-home`), so the user's codex config, MCP servers, skills and `AGENTS.md` do not reach the local model.

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
| Order | subscription with room (most room first), ollama, subscription near full, per-token |
| Hand-off level (Claude week) | below 70%: what was named; 70% or more: any part a worker can do alone; 90% or more: everything but orchestration and diff review |

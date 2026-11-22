---
description: Detect delegation backends and save which ones skynet may use and how each is paid
allowed-tools: Bash(node:*), AskUserQuestion
---

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" setup` and show its lines as they are.
2. Ask in one AskUserQuestion call, only about backends that are installed:
   - which backends skynet may use (multi-select: codex, agy, openrouter, ollama). Leave openrouter unselected unless the user picks it: free models share a small daily request cap, and one delegated job spends many requests;
   - for each chosen cloud backend, how it is paid: `subscription` (plan quota) or `per-token` (API key);
   - for openrouter: how it is paid, `free` or `per-token`. Its four models (reasoning, coding, decision, fallback) default to free-tier picks that step 1 shows; ask to change them only if the user wants to.
   - for each chosen cloud backend, optionally its tier map: which model family serves each tier (`haiku`, `sonnet`, `opus`, `fable`), by family name without a version, with an effort where the user wants one (agy needs one). A backend without a map serves every tier on its CLI's own model. Never propose a map yourself; ask, and take the user's words.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" setup --enable <list> --billing <name=billing,...> [--map <backend>:<tier>=<family>[@<effort>][,<family>...]]... [--max-parallel <backend>=<n>]... [--openrouter-reasoning-model <id>] [--openrouter-coding-model <id>] [--openrouter-decision-model <id>] [--openrouter-fallback-model <id>]`. One `--map` per backend and tier. setup keeps every saved key it is not given, so a map survives a later run without `--map`.
   Ollama has no map: its tier is `OLLAMA_CODING_MODEL_TIER` in the `env` block of Claude Code `settings.json`, next to `OLLAMA_CODING_MODEL`. Without it ollama takes no job.
4. Run step 1 again and show its lines. Say nothing else.

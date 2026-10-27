---
description: Detect delegation backends and save which ones skynet may use and how each is paid
allowed-tools: Bash(node:*), AskUserQuestion
---

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" setup` and show its lines as they are.
2. Ask in one AskUserQuestion call, only about backends that are installed:
   - which backends skynet may use (multi-select: codex, agy, openrouter, ollama);
   - for each chosen cloud backend, how it is paid: `subscription` (plan quota) or `per-token` (API key);
   - for openrouter: how it is paid, `free` (a `:free` model) or `per-token`, and which model id from openrouter.ai/models (prefer a free model that supports tools);
   - if ollama is chosen, which model, from the listed models (prefer a coding model).
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" setup --enable <list> --billing <name=billing,...> [--openrouter-model <id>] [--ollama-model <model>]`.
4. Run step 1 again and show its lines. Say nothing else.

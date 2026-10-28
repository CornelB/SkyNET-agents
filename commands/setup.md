---
description: Detect delegation backends and save which ones skynet may use and how each is paid
allowed-tools: Bash(node:*), AskUserQuestion
---

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" setup` and show its lines as they are.
2. Ask in one AskUserQuestion call, only about backends that are installed:
   - which backends skynet may use (multi-select: codex, agy, openrouter, ollama);
   - for each chosen cloud backend, how it is paid: `subscription` (plan quota) or `per-token` (API key);
   - for openrouter: how it is paid, `free` or `per-token`. Its four models (reasoning, coding, decision, fallback) default to free-tier picks that step 1 shows; ask to change them only if the user wants to;
   - if ollama is chosen, which model, from the listed models (prefer a coding model).
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" setup --enable <list> --billing <name=billing,...> [--openrouter-reasoning-model <id>] [--openrouter-coding-model <id>] [--openrouter-decision-model <id>] [--openrouter-fallback-model <id>] [--ollama-model <model>]`.
4. Run step 1 again and show its lines. Say nothing else.

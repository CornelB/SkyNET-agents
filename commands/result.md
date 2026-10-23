---
description: Show the output of a finished skynet delegation job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/skynet.mjs" result $ARGUMENTS`

Show the output above as it is. Do not summarize it.

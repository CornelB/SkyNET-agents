---
name: skynet
description: Set up delegation backends, plan parallel work, orchestrate repository workers, delegate tasks, inspect job status or results, cancel jobs, check usage, summarize git history, read logs or look up facts through the SkyNET plugin in Codex.
---

Resolve the plugin root as two directories above this skill's directory. Read the matching source file below in full, then follow it with the Codex adaptations below. Paths are relative to the plugin root.

| Request | Source instructions |
| --- | --- |
| Detect backends and configure billing or enabled providers | `commands/setup.md` |
| Plan and execute delegated work | `commands/workflow.md` |
| Orchestrate a feature across repositories | `commands/orchestrate.md` |
| Delegate a task | `commands/delegate.md` |
| Inspect jobs | `commands/status.md` |
| Read job results | `commands/result.md` |
| Cancel a job | `commands/cancel.md` |
| Check provider usage | `skills/usage/SKILL.md` |
| Act as the delegation agent | `agents/delegate.md` |
| Summarize git history or diffs | `agents/git-summarizer.md` |
| Extract relevant errors from logs | `agents/log-reader.md` |
| Look up a fact with sources | `agents/web-lookup.md` |

Treat the user's requested operation and task as `$ARGUMENTS`. Replace `${CLAUDE_PLUGIN_ROOT}` in source instructions with the resolved plugin root before running commands. Resolve source-relative paths from that root, including the usage script.

Use Codex file, shell, web, tool-discovery and agent tools for the corresponding Claude tools. Tool allowlists in source frontmatter describe intended access; the active Codex permissions remain authoritative. Ask setup questions through the available user-input tool or conversation, preserving the user's provider and billing choices.

For in-session workers, use fresh Codex agents with the source's bounded briefs and access constraints. Use available Codex models and effort settings and report the actual choices; Claude-specific tiers and quota rules apply only to Claude executions. External workers keep the CLI's existing backend routing, usage and permission rules. If in-session agent tools are unavailable, report that limitation and use an external backend only when the source permits it.

Pass multiline briefs through a file or standard input using the available shell tool. Preserve the source's job tracking, wait and result checks, offline-worker restrictions and read-only requirements for git summaries, log reading and factual lookups.

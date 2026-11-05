# skynet

A Claude Code plugin that delegates work to Codex, Antigravity (`agy`), OpenRouter or local Ollama. It picks the backend from live usage (codexbar) and the machine's billing setup, so Claude and Codex quota lasts longer. Workers edit the tree directly; the lead reviews the diff.

## Needs

- `node` 22+, `python3`, `git`
- [`codexbar`](https://github.com/steipete/CodexBar) for usage
- one or more of `codex`, `agy`, `opencode`, `ollama`. Ollama runs through `codex exec --oss`, so it needs `codex` too. OpenRouter runs through `opencode run` and needs `OPENROUTER_API_KEY`.

## Install

```bash
claude plugin marketplace add CornelB/SkyNET-marketplace
```

```bash
claude plugin install SkyNET-agents@SkyNET-marketplace
```

Then run `/skynet:setup`.

## Use

| Command | Does |
|---------|------|
| `/skynet:setup` | Detect backends, save which may be used and how each is paid. |
| `/skynet:workflow <task>` | Plan a fan-out: each piece goes to you, a Claude subagent (model and effort set) or an external worker. |
| `/skynet:orchestrate <feature>` | Make this session the orchestrator of a feature built by worker sessions, one lane per repository: scope gate, worker briefs, five-line reports, state file. |
| `/skynet:delegate <task>` | Route, brief and start one or more jobs. |
| `/skynet:status [job]` | One line per job: backend, mode, status, branch and merge state for write jobs, title. A running job whose worker died shows as failed. |
| `/skynet:result [job]` | Show a finished job's output. |
| `/skynet:cancel [job]` | Stop a running job. |
| skill `skynet:usage` | Usage lines from codexbar. |
| agent `skynet:delegate` | The same delegation as a subagent type. |
| agent `skynet:git-summarizer` | Summarizes long git logs and diffs. Read-only, haiku. |
| agent `skynet:log-reader` | Returns only the relevant errors from a long log. Read-only, haiku. |
| agent `skynet:web-lookup` | Answers one factual question from the web, with sources. Haiku. |

Configuration and routing rules: [docs/reference/configuration.md](docs/reference/configuration.md).

## License

MIT. Parts of `scripts/lib/` derive from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see [NOTICE](NOTICE).

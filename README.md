# skynet

A Claude Code plugin that delegates work to Codex, Antigravity (`agy`) or local Ollama. It picks the backend from live usage (codexbar) and the machine's billing setup, so Claude and Codex quota lasts longer. Workers edit the tree directly; the lead reviews the diff.

## Needs

- `node` 22+, `python3`, `git`
- [`codexbar`](https://github.com/steipete/CodexBar) for usage
- one or more of `codex`, `agy`, `ollama`. Ollama runs through `codex exec --oss`, so it needs `codex` too.

## Install (local)

```bash
claude plugin marketplace add /path/to/SkyNET-agents
claude plugin install skynet@skynet-local
```

Then run `/skynet:setup`.

## Use

| Command | Does |
|---------|------|
| `/skynet:setup` | Detect backends, save which may be used and how each is paid. |
| `/skynet:delegate <task>` | Route, brief and start one or more jobs. |
| `/skynet:status [job]` | List jobs. A running job whose worker died shows as failed. |
| `/skynet:result [job]` | Show a finished job's output. |
| `/skynet:cancel [job]` | Stop a running job. |
| skill `skynet:usage` | Usage lines from codexbar. |
| agent `skynet:delegate` | The same delegation as a subagent type. |

Configuration and routing rules: [docs/reference/configuration.md](docs/reference/configuration.md).

## License

MIT. Parts of `scripts/lib/` derive from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see [NOTICE](NOTICE).

# Delegation: workers are offline

Status: reviewed against the code 2026-11-10.

## Problem

A task that had to change a card in a remote service was handed to an external worker. The router picked the local Ollama worker. Its shell has no network and it has no connector for the service, so the job failed and the lead redid the work with a Claude subagent.

The router picks a backend from usage alone, and that is correct: which task leaves the session is the lead's decision. The texts that guide that decision did not stop it. `/skynet:workflow` keeps tasks that need an MCP server, a connector or the browser, but says nothing about network. `/skynet:delegate` and the `delegate` agent description keep nothing.

## Rule

A worker is offline. It gets the files and the shell inside the repo, and nothing else.

A piece stays with Claude (the lead, or a Claude subagent) when it needs any of these:

- a remote host or service: ssh, HTTP, a package install, a git fetch or push;
- an MCP server or a connector;
- the browser;
- credentials that the session holds.

This rule beats the request, the hand-off level and a backend the user named.

A piece with a small remote part and a large local part is split. The lead fetches the remote input into a file before the job and names the file in the brief. The worker works on files. The lead applies the remote change after the job.

## Why no network routing

A `--network` flag that routes to a backend with network was considered and dropped:

- OpenRouter is the only backend whose worker has network, and setup keeps it off by default. On a default setup the flag always answers `no backend:`.
- That worker has no sandbox, runs on a free model whose provider can log prompts, and inherits the session environment. Its remote changes are not in the diff the lead reads.
- The failed task needed a connector, which no worker has. The rule above fixes it without the flag.

## Requirements

1. `/skynet:delegate` applies the rule when it decides what to hand off. When the request itself is such a piece, it says so in one line and the lead does the work.
2. `/skynet:workflow` adds network to its external-worker condition and states that the condition beats a named backend.
3. The descriptions of `/skynet:delegate` and of the `delegate` agent say that workers are offline, because the description is the only text the caller reads before it delegates.
4. The two command texts state the rule once each, without a per-backend list. The per-backend facts stay in `docs/reference/configuration.md`.
5. `docs/reference/configuration.md` states the rule and no longer sends installs to codex, whose shell has no network.

## Out of scope

- Code changes. The router and the CLI do not change.
- Detecting the kind of a task from the brief text.

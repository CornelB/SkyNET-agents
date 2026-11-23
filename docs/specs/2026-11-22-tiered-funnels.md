# Tiered funnels for delegation

Applies to SkyNET-agents:

- code: `scripts/skynet.mjs`, `scripts/lib/router.mjs`, `scripts/lib/backends.mjs`, `scripts/lib/args.mjs`, `scripts/lib/config.mjs`, `scripts/lib/state.mjs`, a new `scripts/lib/tiers.mjs`;
- commands and skills: `commands/workflow.md`, `commands/delegate.md`, `commands/setup.md`, `agents/delegate.md`, `skills/usage/SKILL.md`, `skills/skynet/SKILL.md`;
- docs: `docs/reference/configuration.md`, `README.md`;
- tests: `tests/router.test.mjs`, `tests/cli.test.mjs`, `tests/backends.test.mjs`, a new `tests/tiers.test.mjs`, `tests/fixtures/bin`.

## Problem

1. Routing picks a backend, never a model. Every codex and agy job runs the one model of that CLI's own config. `modelFor` reads `backends.<name>.model`, and `buildInvocation` drops it for codex and agy.
2. `workflow.md` picks a Claude tier for subagents and has no rule for which external model equals which tier. A piece that needs Opus-level work can land on a small local model.
3. A subscription backend with free quota stays unused: the hand-off level reads Claude's week only, and below 70% only named pieces are handed off.
4. The `delegate` templates in the commands do not show `--backend`, so a vendor the user names has no documented path.
5. Nothing limits how many jobs one backend runs at once. Eight parallel codex jobs can use a whole 5h window in minutes.

## Goal

The caller states a role and a tier. skynet answers with the first step of that role's funnel that has a model of that tier or better, has quota and has a free slot. The plugin ships the rules only. Which model serves which tier on which backend is the user's configuration; the code and the reference docs name no model, version or machine fact.

## Terms

- **Tier**: `haiku`, `sonnet`, `opus`, `fable`, in rising order: the level of work, after the Claude families.
- **Role**: `write` (changes files), `read` (reviews, investigates, explains), `advisor` (a second opinion on a hard decision).
- **Step**: one executor in a funnel: a backend (`ollama`, `codex`, `agy`, `openrouter`) or the calling session.
- **Calling session**: printed as `claude` when `CLAUDECODE` is set in the environment, else as `self`.
- **Family**: a model name without a version number.

## Tier map

1. codex and agy ship a built-in map of families, one list per tier (`DEFAULT_TIERS` in `scripts/lib/tiers.mjs`): codex `luna`, `terra`, `sol`, `astra@high`; agy `flash@medium`, `hydrogen@high`, `neon@xhigh`, then `neon@xhigh` and `carbon@high`. A new install needs no map. `backends.<name>.tiers` in `~/.config/skynet/config.json` replaces single tiers of it: for each tier, an ordered list of entries. An entry is `<family>` or `<family>@<effort>`. `/skynet:setup` writes it from flags.
2. A backend serves a job when its map has an entry for the job's tier or for a higher tier; the lowest such tier is used. A built-in family the backend does not list runs the CLI's own model, with `model unmapped` in its status. A saved family the backend does not list: `<backend> no <tier> model`. A backend with no built-in map and no `tiers` key serves every tier on its CLI's own model.
3. Ollama has no map. Its tier is `OLLAMA_CODING_MODEL_TIER` in the environment. Unset or not a tier name: `ollama skipped, no tier declared`. It serves jobs of that tier and of every tier below it; above it: `ollama no <tier> model`.
4. OpenRouter joins a funnel only with a `tiers` key. Its entries are exact model ids, run as written: no version resolution, no effort. The rate-limit retry on `models.fallback` stays. Without `tiers` it runs only by `--backend openrouter`, on `models.coding` or `models.reasoning` as today.

### Version

1. codex and agy entries resolve at run time to the newest version the backend lists.
   - codex: `models[]` of `$CODEX_HOME/models_cache.json` (default `~/.codex`), field `slug`; a model with `visibility` `hide` is left out.
   - agy: `agy models`, one `<slug><TAB><name>` per line, capped at 10 seconds.
2. Match: a slug is split on `-`. One token is the version when it matches `^\d+(\.\d+)*$`. The entry's family, split on `-`, must appear as consecutive tokens of the slug, compared without case. Versions compare number by number (`6.2` > `6.1` > `6` > `5.6`). A slug with no version token is left out.
3. Effort:
   - codex: the slug carries no effort. The entry's effort is passed as `-c model_reasoning_effort=<effort>`; with no effort in the entry nothing is passed.
   - agy: the slug's last token is the effort. An agy entry must name its effort; `setup` refuses one that does not. A slug matches only when its last token equals the entry's effort.
4. Entries of a tier are tried in order; the first that resolves is used. No entry resolves: `<backend> no <tier> model`.
5. The list cannot be read (file missing or unparsable, `agy models` fails or times out): the last slug this entry resolved to is used. skynet keeps those in `<state root>/resolved-models.json`. No saved slug: the CLI's own model runs. Both cases add `model list unreadable` to the status.
6. The resolved model reaches the CLI: `-m <slug>` for codex, `--model <slug>` for agy. The job record stores `tier`, `model` and `effort`; the worker updates `model` when a retry runs another one.

## Funnels

| Role | Order |
|------|-------|
| `write` | local, free, subscription (most room first), calling session, per-token |
| `read` | free, subscription (most room first), calling session, per-token |
| `advisor` | calling session at `fable`, calling session at `opus`, subscription (most room first), per-token |

1. The kind of a backend is its `billing`: `local`, `free`, `subscription`, `per-token`.
2. A local backend is in the `write` funnel only. `--backend ollama --mode read` stays allowed.
3. `advisor` always asks for tier `fable` and takes no `--tier`. Its second step is the one place where a lower tier is accepted. Outside Claude Code its two calling-session steps are left out.
4. A backend with usage data sorts before one without; among those with data, the one with the most room first.
5. The walk takes the first step that is enabled, not excluded by `--not`, serves the tier, and is not skipped.
6. When every step of `write` or `read` is skipped, the answer is the calling session with the reason it was skipped. `advisor`, or a walk whose calling session is excluded by `--not`: `no backend: <statuses>`.

## Skip rules

Checked in this order; the first that fires gives the status.

| # | Applies to | Skipped when | Status |
|---|-----------|--------------|--------|
| 1 | a backend | named in `--not` | `<backend> excluded` |
| 2 | ollama | `OLLAMA_CODING_MODEL` unset | `ollama skipped, no model set` |
| 3 | a backend | it does not serve the tier | see Tier map |
| 4 | a backend | `--needs-shell`, and its job shell cannot write (agy, which runs `--sandbox`) | `<backend> shell read-only` |
| 5 | a backend | it has `maxParallel` jobs running | `<backend> at limit (<n> running)` |
| 6 | subscription | a counted window is over its threshold | `<backend> <window> <n>% full until <reset>` (as today) |
| 7 | ollama, selector set | the selector refuses | `ollama skipped, <reason>` (as today) |
| 8 | ollama, no selector | a GPU reading exists and is not idle | `ollama local, <gpu>, busy` |
| 9 | calling session | Claude's `week` or `5h` window is over its threshold | `claude <window> <n>%` |
| 10 | calling session at tier T | a Claude window named `<T> only`, compared without case, is above 80% | `claude <window> <n>%` |

1. Thresholds: a window of 300 minutes or less is full at 90% or more; any other window is full above 80%. They replace `FULL_5H`, `FULL_WEEK`, `FULL_MODEL` and `NEAR`.
2. Counted windows: `5h` and `week` for codex; for another backend the window `backends.<name>.window` names, else all its windows.
3. No usage entry or no counted window: the step is not skipped; status `<backend> usage unknown`. The same holds for the calling session.
4. A per-token backend is never skipped on quota; status `<backend> per-token`.
5. Ollama without a selector and without a GPU reading (no amdgpu card) is available; status `ollama local`. An idle reading: `ollama local, <gpu>, idle`.
6. The selector runs only after rules 1 to 5 pass for ollama. The contract of `docs/specs/2026-11-20-ollama-selector.md` is unchanged.
7. Rules 9 and 10 apply only in Claude Code. The `self` step is never skipped.
8. `--backend <name>` forces one backend: it skips the enabled flag and rules 1, 6 and 8, and keeps rules 2, 3, 4, 5 and 7. A refusal exits 1 with the status on stderr and creates no job.

## Parallel limit

1. `backends.<name>.maxParallel`: default 1 for `local`, 2 for every other kind.
2. Counted: jobs of that backend in status `queued` or `running` whose worker process is alive, in every workspace under the state root. A job whose worker is gone is settled as failed before counting.
3. There is no queue. A backend at its limit is skipped and the walk goes on.

## Hand-off level

Today's rule gives a level from Claude's week, raised from `named` to `independent` by an idle local backend. The level becomes the highest of that and:

1. `all`, when an enabled subscription backend that rule 6 does not skip has a weekly window with more than 30% left that resets within 2 days;
2. `independent`, when an enabled subscription backend that rule 6 does not skip has a weekly window at 80% or less.

A window without a reset time does not count for 1. The line keeps its form and names what raised the level: `claude week 15%, codex week 40% → hand off any part a worker can do alone`.

The level applies first: it says which pieces leave the session. The funnel then picks the step for each of those pieces.

## CLI

- `route`: prints the hand-off level, one line.
- `route --role <write|read|advisor> [--tier <tier>] [--needs-shell] [--not <step>,...]`: line 1 the pick, line 2 the hand-off level. It starts nothing. `--tier` is required for `write` and `read`.
- `delegate --mode <write|read> --tier <tier> [--needs-shell] [--not <step>,...] [--backend <name>]`: `--tier` is required; without it, usage error `delegate needs --tier haiku|sonnet|opus|fable`. `delegate` does its own walk.
  - a backend is picked: a job starts and the line is `<job id> → <backend> <model> (<statuses>)`; exit 0;
  - the calling session is picked: no job; the line is `→ claude <tier> (<statuses>)` (or `self`); exit 4;
  - nothing is picked: `no backend: <statuses>`; exit 1.
- `<model>` in a pick line is the resolved slug, or `own model` when the CLI's own model runs.
- `setup` merges into the saved config; keys it does not set are kept.
  - `--map <backend>:<tier>=<entry>[,<entry>...]`, repeatable; an empty list removes the tier.
  - `--max-parallel <backend>=<n>`, repeatable.
  - Without flags it prints, per backend, the map with each entry's resolved slug.
- `parseArgs` gains list options: a repeated option collects every value.

## Commands

- `workflow.md`:
  - step 3 reads the hand-off level with `route`;
  - step 5: the session picks a tier per piece (the existing tier rule), then which pieces leave the session (eligibility, then the hand-off level). The Fable limit becomes 80%;
  - step 6: the plan line shows the tier; an external piece is `skynet write <tier>` or `skynet read <tier>`;
  - step 7: the `delegate` template gains `--tier`, `--needs-shell`, `--not` and `--backend`. A vendor the user names becomes `--backend`: Antigravity or its vendor is `agy`; Codex or its vendor is `codex`. Exit 4 means the session runs that piece as a subagent of the tier the line names;
  - step 8: a job that failed is sent again at the same tier with `--not <step>`. A result that fails its check is sent again one tier up; at `fable` the session does the piece itself.
- `delegate.md`: step 1 runs `route` for the hand-off level; the tier rule and the new flags; exit 4 as above.
- `agents/delegate.md`: a brief that names no tier is refused in one line; on exit 4 it returns the pick line and stops.
- `setup.md`: shows the map in effect and does not ask about it; it passes `--map` only when the user asks to change a tier.
- `skills/usage/SKILL.md`: the thresholds above.
- `skills/skynet/SKILL.md`: external workers follow the funnels.

## Docs

`docs/reference/configuration.md`: `tiers`, `maxParallel`, `OLLAMA_CODING_MODEL_TIER`, the funnels, the skip rules with their statuses, the hand-off rules, and the agy paragraph ("model and project still come from that file" holds only without a map). `README.md` carries a suggested map by family as an example; it is the one place that names families.

## Not in scope

- SkyNET-review: the tribunal seats keep their own model rules. `OLLAMA_REVIEWER_MODEL_TIER` gets no rule here.
- A queue.
- A per-job `--model` flag.
- A caller for the `advisor` role in the skills of other repos.
- Measuring which model equals which tier. The user declares it.

## Acceptance

- `tests/tiers.test.mjs`: tier order; map lookup (exact tier, higher tier, none, no `tiers` key); slug matching and version compare; hidden and versionless slugs left out; effort for codex and agy; entry order; unreadable list with and without a saved slug.
- `tests/router.test.mjs`: every funnel's order; each skip rule with its status; the rule order; unknown usage; the all-skipped answers; `--not`; the hand-off rules with the lines they print. Tests that pin today's thresholds or order are rewritten to the new value in the same change, never deleted without a replacement.
- `tests/backends.test.mjs`: codex argv with `-m` and the effort override; agy argv with `--model`; argv unchanged without a model.
- `tests/cli.test.mjs`: `delegate` without `--tier` is refused; the three `delegate` outcomes with their exit codes; `--backend` refusals; the limit counts live jobs across workspaces; `setup` merges and keeps `tiers`; `--map` repeated. The fixtures add a codex model cache and an `agy` stub; the tests set `CODEX_HOME`, so no test reads the developer's home.
- Live: one `write` and one `read` job on each enabled backend, on the smallest model for ollama. Evidence: the job record's tier and model. Live evidence stays out of the repo.

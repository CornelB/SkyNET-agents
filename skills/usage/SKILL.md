---
name: usage
description: Use when you are about to send work to an AI provider (Claude, Codex, Antigravity or agy, Gemini, Grok, others), or the user asks how much AI usage is left. Triggers on "ai usage", "usage limits", "codexbar", "claude usage", "codex usage", "antigravity usage", "agy usage", "gemini usage", "how much usage is left", "which model has quota".
---

# Usage

Read the usage limits of AI providers from the CodexBar CLI, and decide which provider can take work now. Do the steps below in order.

Needs the `codexbar` CLI on `PATH` ([steipete/CodexBar](https://github.com/steipete/CodexBar)).

## What you may do

- Run `scripts/ai_usage.py` (in this skill's directory).
- Tell the user the usage lines.
- Stop a delegation, or send the delegation to a different provider, when the usage is too high.

Do not run `codexbar usage --provider all`. Do not use a reset credit. Do not read or change `~/.config/codexbar/config.json`. The file holds secrets.

## Words in this skill

- **provider**: one AI service that codexbar reads, for example `codex`, `claude`, `grok`.
- **5h window**: the usage limit that resets 5 hours after it starts.
- **week window**: the usage limit that resets 7 days after it starts.
- **model window**: a limit for one model or model family only, for example `Fable only` or `Gemini Models`. It applies only to work that uses that model.
- **delegation**: any task that you send to a provider, for example `/skynet:delegate`, a review-board seat, or a worker session.

## Step 1: Choose the command

1. Look for provider names in the user's message or the task: `claude`, `codex`, `antigravity`, `agy`, `gemini`, `grok`, `cursor`, `copilot`.
2. If you find `agy` or `gemini`, use the provider `antigravity`. Antigravity (`agy`) replaces the old Gemini CLI.
3. If you find exactly one provider, the command is `python3 scripts/ai_usage.py --provider <provider>`.
4. If you find zero providers, or two or more, the command is `python3 scripts/ai_usage.py`.

Example: "how much claude usage is left?" names one provider. The command is `python3 scripts/ai_usage.py --provider claude`.

## Step 2: Run the command

1. Run the command from Step 1.
2. If the exit code is 0, go to Step 3.
3. If the exit code is 2, tell the user the output line. Stop.

## Step 3: Read the lines

The script prints one line per provider. Each line is one of these 3 kinds:

1. A usage line, for example `claude 5h 12% (resets 14:00) · week 82% ...`. The percent is the part of the limit that is used.
2. An error line, for example `grok error: ...`. The usage is unknown. The provider itself can still work: `skynet route` ranks such a backend after ollama.
3. A `no usage data` line. The usage is unknown, same as an error line.

## Step 4: Decide

Do this step only before a delegation. If the user only asked for the usage, go to Output.

Check the usage line of the provider that gets the delegation. "90% or more" includes 90%. Example: `Fable only 95%` is 95% or more, so the Fable model is full.

1. If the 5h value is 90% or more, the provider is full until the 5h reset time.
2. If the week value is 95% or more, the provider is full until the week reset time.
3. If the delegation uses a model that has a model window, and that model window is 95% or more, the provider is full for that model.
4. If the provider is not full, continue with the delegation.
5. If the provider is full and another provider can do the same task and is not full, tell the user. Then send the delegation to the other provider.
6. If the provider is full and no other provider can do the task, do not delegate. Tell the user the reset time. Stop.

`runs out before reset` means the current pace uses the full limit before the reset. Tell the user. Do not stop the delegation for this reason only.

## Output

Show the script lines as they are. Example:

```
codex 5h 32% (resets 14:41) · week 5% (resets 30 Oct 08:41) · source oauth 11:31 · 2 reset credits
claude 5h 12% (resets 14:00) · week 82% (resets 24 Oct 05:00) · Fable only 95% (resets 24 Oct 05:00) · source oauth 11:31
grok error: Grok billing requires authentication. Run `grok login`.
```

The time after `source` is when codexbar last read the provider.

For machine use, run `python3 scripts/ai_usage.py --json`. The JSON is a list with one object per provider. Each object has `provider`, `source`, and `windows` (each with `name`, `used_percent`, `resets_at`, `lasts_to_reset`), or `error`.

To list the provider ids, run `codexbar usage --help`.

# Tell codex the local model's context window

Applies to two invocations of `codex exec --oss` against a local Ollama model:

- SkyNET-review: the `codex-oss` tribunal seat (`scripts/seats/codex-oss.sh`, `seat_invoke`), model `OLLAMA_REVIEWER_MODEL`.
- SkyNET-agents: the `ollama` delegation backend (`scripts/lib/backends.mjs`, `buildInvocation`), model `OLLAMA_CODING_MODEL`.

## Problem

Codex does not know the context window of a local model. For a slug that is not in its model catalog, codex 0.167.1 uses fallback metadata with a context window of 272,000 tokens (`codex-rs/models-manager/src/model_info.rs`, `model_info_from_slug`). Its auto-compaction threshold is 90% of that window, 244,800 tokens (`codex-rs/protocol/src/openai_models.rs`, `ModelInfo::auto_compact_token_limit`). Ollama serves the model with a much smaller window (`num_ctx`, often 32,768 or 65,536). The conversation grows past the served window long before codex compacts, and Ollama rejects the request.

Evidence, 2026-11-11:

- Review seat, `bonsai-2:27b` (num_ctx 65,536), simplicity lens, 253-line diff: `request (65879 tokens) exceeds the available context size (65536 tokens)` after 5 reconnects, empty report. Earlier recorded seat cells: 0 valid reports in 35.
- Delegation job the same day reached `n_tokens = 32709` of 32,768 (`journalctl -u ollama`).

## Requirements

1. When the served window W is known, both invocations pass `-c model_context_window=<W>` and `-c model_auto_compact_token_limit=<L>` with `L = floor(W * 3 / 4)`.
2. W is known only when it is stated: the model's `num_ctx` parameter from `ollama show`, else `OLLAMA_CONTEXT_LENGTH` when it is set in the caller's environment; never above the model's trained `context length`.
3. When W is not known (`ollama show` fails, or neither source states a number), both flags are left out and the run goes ahead as today. The seat gate keeps its 4096 fallback for the diff-size check; that guess is not passed to codex, because Ollama's real default depends on VRAM and a 4096 threshold sits below codex's own base prompt.
4. Delegation reads W once per job, in the worker, from the job's stored model (`job.model`). The preflight `buildInvocation` call does not read it, and `buildInvocation` does not throw without it.
5. Nothing changes for the cloud `codex` backend or any other seat.

## Why these values

- Once W is known, codex sets the threshold to `min(configured limit, W * 9 / 10)`. A configured limit can only lower it.
- 9/10 is not enough on a local window. Codex checks the threshold after a step's tool outputs are recorded. Each tool output can add about 3,000 tokens (10,000 bytes plus a 1.2 serialization allowance, `context_manager/history.rs`), and a step can call more than one tool. The local compaction request then carries the whole history plus the summary prompt, and the summary must fit in the same window. At W = 32,768 the 9/10 reserve is 3,277 tokens: a step ending just under L plus one large exec output overflows the compaction request itself. Codex trims history and retries a compaction only on the `context_length_exceeded` error code; Ollama's "exceeds the available context size" is a plain stream error, so the turn fails after 5 reconnects, the same symptom as today.
- 3/4 leaves 8,192 tokens at W = 32,768 and 16,384 at W = 65,536: room for a step's reasoning, two or three tool outputs and the summary. The explicit L is therefore the lever that matters; `model_context_window` keeps codex's own window figures true.
- Codex checks the threshold after every sampling step inside a turn (mid-turn compaction, `codex-rs/core/src/session/turn.rs`), so a single long `exec` turn compacts too. For the ollama provider codex runs local compaction (remote compaction is OpenAI and Azure only).

## Shape

- Seat: `seat_invoke` reads W with the existing `ollama_ctx` minus the 4096 fallback, and appends the two `-c` pairs when it returns a number.
- Delegation: a function next to `buildInvocation` reads W from `ollama show` (same rules), taking `{ run = runCommand }` like `detectBackends`; a spawn error or non-zero exit means "no window". `buildInvocation` takes the window as an optional input and appends the two `-c` pairs for `ollama`; it stays free of side effects.

## Known limits

- After a compaction codex keeps its prefix (base prompt and tool schemas, about 7,000 to 8,000 tokens) and up to 20,000 tokens of user messages, plus the summary. With a large brief at W = 32,768 that can land above L again, so codex compacts after every step. A served window under about 32,768 is not a supported configuration for these roles.
- The seat gate's diff-size check stays as it is.

## Acceptance

- Bats: the `codex-oss` seat's codex argv carries both flags with W from `num_ctx` and L = 3/4 of W; it carries neither when `ollama show` fails or reports no `num_ctx`.
- Node: `buildInvocation("ollama", …)` with a window carries both flags; without a window, neither, and the existing argv is unchanged. The window reader is tested for num_ctx, the environment value, no stated value, the trained-length cap and a failing `ollama show`.
- Live: one run with the smallest installed model, served with a small window through a temporary tag, where the conversation outgrows L. Evidence: codex's own compaction event in its output (or a drop in prompt tokens between requests in `journalctl -u ollama`) and no context-size error. `ollama stop` right after, temporary tag removed. No model load while `systemctl --user is-active ollama-role-bench` reports `active`.

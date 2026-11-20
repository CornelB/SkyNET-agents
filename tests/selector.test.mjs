import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ollamaHostEnv, parseSelectorAnswer, sanitizeReason, selectOllamaServer } from "../scripts/lib/selector.mjs";

const answer = (fields) => parseSelectorAnswer({ status: 0, signal: null, timedOut: false, stdout: "", stderr: "", ...fields });

test("an empty answer means the default server", () => {
  assert.deepEqual(answer({ stdout: "" }), { host: null });
  assert.deepEqual(answer({ stdout: "  \nignored\n" }), { host: null });
});

test("a host:port answer gets http:// and loses a trailing slash; later lines are ignored", () => {
  assert.deepEqual(answer({ stdout: "  127.0.0.1:11435  \nignored\n" }), { host: "http://127.0.0.1:11435" });
  assert.deepEqual(answer({ stdout: "http://h:1/\n" }), { host: "http://h:1" });
});

test("any other answer is refused with the line it printed", () => {
  assert.deepEqual(answer({ stdout: "https://h:1\n" }), { refused: "selector printed https://h:1" });
  assert.deepEqual(answer({ stdout: "h\n" }), { refused: "selector printed h" });
});

test("a non-zero exit is refused with the last stderr line, else the exit code", () => {
  assert.deepEqual(answer({ status: 3, stderr: "a\nbusy\n\n" }), { refused: "busy" });
  assert.deepEqual(answer({ status: 3, stderr: "" }), { refused: "selector exit 3" });
});

test("a timeout and a signal are refusals, never the default server", () => {
  assert.deepEqual(answer({ status: null, signal: "SIGKILL", timedOut: true }), { refused: "selector timed out" });
  assert.deepEqual(answer({ status: null, signal: "SIGTERM" }), { refused: "selector killed by SIGTERM" });
});

test("reasons lose control characters and stop at 300 characters", () => {
  assert.equal(sanitizeReason("\x1b[31mred\r"), "[31mred");
  assert.equal(sanitizeReason("x".repeat(400)).length, 300);
  assert.deepEqual(answer({ status: 1, stderr: "\x1b[31mbusy\r\n" }), { refused: "[31mbusy" });
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skynet-selector-"));
function script(body) {
  const dir = tmp();
  const file = path.join(dir, "select");
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return { dir, file };
}
const served = (calls, status = 0) => (cmd, args, options) => {
  calls.push({ cmd, args, options });
  return { status, stdout: "", stderr: "", error: null };
};

test("no selector configured: nothing runs", () => {
  const spawn = () => assert.fail("spawned");
  assert.equal(selectOllamaServer("coding", "m", { env: {}, spawn }), undefined);
  assert.equal(selectOllamaServer("coding", "m", { env: { OLLAMA_SELECTOR: "" }, spawn }), undefined);
});

test("a relative, missing or non-executable selector is refused before any call", () => {
  const spawn = () => assert.fail("spawned");
  const plain = path.join(tmp(), "select");
  fs.writeFileSync(plain, "echo x\n", { mode: 0o644 });
  for (const OLLAMA_SELECTOR of ["rel/path", path.join(tmp(), "missing"), plain]) {
    assert.deepEqual(selectOllamaServer("coding", "m", { env: { OLLAMA_SELECTOR }, spawn }), { refused: "OLLAMA_SELECTOR not executable" });
  }
});

test("a selected server is checked with ollama show on that server", () => {
  const { dir, file } = script(`echo "$@" > "${"$(dirname \"$0\")"}/argv"; echo 127.0.0.1:11435`);
  const calls = [];
  const env = { PATH: process.env.PATH, OLLAMA_SELECTOR: file };
  assert.deepEqual(selectOllamaServer("coding", "m", { env, run: served(calls) }), { host: "http://127.0.0.1:11435" });
  assert.equal(fs.readFileSync(path.join(dir, "argv"), "utf8"), "coding m\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "ollama");
  assert.deepEqual(calls[0].args, ["show", "m"]);
  assert.equal(calls[0].options.env.OLLAMA_HOST, "http://127.0.0.1:11435");
});

test("a server that does not serve the model is refused", () => {
  const { file } = script("echo 127.0.0.1:11435");
  const env = { PATH: process.env.PATH, OLLAMA_SELECTOR: file };
  assert.deepEqual(selectOllamaServer("coding", "m", { env, run: served([], 1) }), { refused: "m not served by http://127.0.0.1:11435" });
});

test("the default server answer runs no ollama show", () => {
  const { file } = script("exit 0");
  const calls = [];
  assert.deepEqual(selectOllamaServer("review", "m", { env: { PATH: process.env.PATH, OLLAMA_SELECTOR: file }, run: served(calls) }), { host: null });
  assert.equal(calls.length, 0);
});

test("a selector over the cap is killed and refused", () => {
  const { file } = script("sleep 5");
  const started = Date.now();
  assert.deepEqual(selectOllamaServer("coding", "m", { env: { PATH: process.env.PATH, OLLAMA_SELECTOR: file }, timeoutMs: 300 }), { refused: "selector timed out" });
  assert.ok(Date.now() - started < 3000);
});

test("a background child holding stdout does not hold the call", () => {
  const { file } = script("sleep 5 & echo 127.0.0.1:1");
  const started = Date.now();
  assert.deepEqual(selectOllamaServer("coding", "m", { env: { PATH: process.env.PATH, OLLAMA_SELECTOR: file }, run: served([]) }), { host: "http://127.0.0.1:1" });
  assert.ok(Date.now() - started < 3000);
});

test("ollamaHostEnv points the ollama CLI and codex at the server", () => {
  assert.deepEqual(ollamaHostEnv(null), {});
  assert.deepEqual(ollamaHostEnv("http://h:1"), { OLLAMA_HOST: "http://h:1", CODEX_OSS_BASE_URL: "http://h:1/v1" });
});

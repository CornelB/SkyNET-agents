import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readUsage } from "../scripts/lib/usage.mjs";

const fixtureBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "bin");
const nodeDir = path.dirname(process.execPath);
const python = fs.realpathSync("/usr/bin/python3");

test("readUsage returns normalised entries from codexbar", async () => {
  const usage = await readUsage({ python, env: { ...process.env, PATH: `${fixtureBin}:${nodeDir}` } });
  assert.equal(usage.length, 3);
  const codex = usage.find((entry) => entry.provider === "codex");
  assert.equal(codex.windows.find((w) => w.name === "5h").used_percent, 38);
});

test("readUsage returns [] when codexbar is missing", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-nobin-"));
  assert.deepEqual(await readUsage({ python, env: { PATH: empty } }), []);
});

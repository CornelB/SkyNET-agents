import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gpuIdle, readGpu } from "../scripts/lib/gpu.mjs";

const GB = 1e9;

function drm(cards) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-drm-"));
  for (const [name, values] of Object.entries(cards)) {
    const dev = path.join(root, name, "device");
    fs.mkdirSync(dev, { recursive: true });
    for (const [file, value] of Object.entries(values)) {
      fs.writeFileSync(path.join(dev, file), `${value}\n`);
    }
  }
  return root;
}

const amd = (busy, used, total) => ({ gpu_busy_percent: busy, mem_info_vram_used: used, mem_info_vram_total: total });
const ps = (...models) => () => ({ status: 0, stdout: ["NAME    ID    SIZE", ...models.map((m) => `${m}    abc    20 GB`)].join("\n") });

test("the card with the most VRAM is read", () => {
  const root = drm({ card0: amd(90, 1 * GB, 2 * GB), card1: amd(5, 3 * GB, 16 * GB), card2: {} });
  assert.deepEqual(readGpu({ drmRoot: root, model: "m", run: ps() }), { busy: 5, used: 3 * GB, total: 16 * GB, loaded: false });
});

test("no amdgpu card means no reading", () => {
  assert.equal(readGpu({ drmRoot: drm({ card1: {} }), run: ps() }), null);
  assert.equal(readGpu({ drmRoot: "/nonexistent", run: ps() }), null);
});

test("the configured model in ollama ps counts as loaded", () => {
  const root = drm({ card0: amd(60, 14 * GB, 16 * GB) });
  assert.equal(readGpu({ drmRoot: root, model: "m:1", run: ps("other", "m:1") }).loaded, true);
  assert.equal(readGpu({ drmRoot: root, model: "m:1", run: ps("other") }).loaded, false);
});

test("idle needs low load and free VRAM, or the model loaded", () => {
  assert.equal(gpuIdle({ busy: 5, used: 3 * GB, total: 16 * GB, loaded: false }), true);
  assert.equal(gpuIdle({ busy: 20, used: 3 * GB, total: 16 * GB, loaded: false }), false);
  assert.equal(gpuIdle({ busy: 5, used: 8 * GB, total: 16 * GB, loaded: false }), false);
  assert.equal(gpuIdle({ busy: 60, used: 14 * GB, total: 16 * GB, loaded: true }), true);
  assert.equal(gpuIdle(null), false);
});

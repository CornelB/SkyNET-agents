import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

// An idle GPU makes ollama the first pick. Idle: under 20% busy and under half the VRAM in use,
// or the ollama model already loaded (its own weights fill VRAM, so the VRAM test would fail).
const IDLE_BUSY = 20;
const IDLE_VRAM = 0.5;

function readNumber(file) {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// amdgpu sysfs only. With several cards, the one with the most VRAM is the one ollama uses.
// -> {busy, used, total, loaded} or null when no card reports all three.
export function readGpu({ drmRoot = "/sys/class/drm", run = runCommand, model } = {}) {
  let cards;
  try {
    cards = fs.readdirSync(drmRoot).filter((name) => /^card\d+$/.test(name));
  } catch {
    cards = [];
  }
  const gpus = cards
    .map((card) => {
      const dev = path.join(drmRoot, card, "device");
      return {
        busy: readNumber(path.join(dev, "gpu_busy_percent")),
        used: readNumber(path.join(dev, "mem_info_vram_used")),
        total: readNumber(path.join(dev, "mem_info_vram_total"))
      };
    })
    .filter((g) => g.busy !== null && g.used !== null && g.total);
  if (!gpus.length) {
    return null;
  }
  const gpu = gpus.reduce((a, b) => (b.total > a.total ? b : a));
  const ps = model ? run("ollama", ["ps"]) : null;
  const loaded = Boolean(ps && !ps.error && ps.status === 0 && (ps.stdout ?? "").split("\n").slice(1).some((line) => line.split(/\s+/)[0] === model));
  return { ...gpu, loaded };
}

export function gpuIdle(gpu) {
  return Boolean(gpu) && (gpu.loaded || (gpu.busy < IDLE_BUSY && gpu.used / gpu.total < IDLE_VRAM));
}

export function describeGpu(gpu) {
  if (!gpu) {
    return "GPU unknown";
  }
  const gb = (bytes) => (bytes / 1e9).toFixed(1);
  return `GPU ${Math.round(gpu.busy)}% busy, VRAM ${gb(gpu.used)}/${gb(gpu.total)} GB${gpu.loaded ? ", model loaded" : ""}`;
}

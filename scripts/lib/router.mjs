// Picks a delegation backend from codexbar usage and the machine config.
// Thresholds come from the usage skill (full) and the spec (near full).
import { describeGpu, gpuIdle } from "./gpu.mjs";

const FULL_5H = 90;
const FULL_WEEK = 95;
const FULL_MODEL = 95;
const NEAR = 75;

const CLOUD = { codex: "codex", agy: "antigravity" };

function resetTime(iso) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) {
    return "?";
  }
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? time : `${date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${time}`;
}

function relevantWindows(backend, entry, cfg) {
  const windows = (entry.windows ?? []).filter((w) => typeof w.used_percent === "number");
  if (backend === "codex") {
    return windows.filter((w) => w.name === "5h" || w.name === "week");
  }
  return cfg.window ? windows.filter((w) => w.name === cfg.window) : windows;
}

function isFull(backend, w) {
  if (backend === "codex") {
    return w.used_percent >= (w.name === "5h" ? FULL_5H : FULL_WEEK);
  }
  return w.used_percent >= FULL_MODEL;
}

// -> {backend, available, tier, room, status}
// gpu: readGpu() output, or undefined when not read. An idle GPU puts ollama ahead of every cloud backend.
function assess(backend, usage, cfg, gpu) {
  if (backend === "ollama") {
    if (gpu === undefined) {
      return { backend, available: true, tier: 2, room: 0, status: "ollama local" };
    }
    const idle = gpuIdle(gpu);
    return { backend, available: true, tier: idle ? 0 : 2, room: 0, status: `ollama local, ${describeGpu(gpu)}${idle ? ", idle" : ""}` };
  }
  // OpenRouter has no plan windows. Free models share ollama's tier and win the tie by list order.
  if (backend === "openrouter") {
    return cfg.billing === "per-token"
      ? { backend, available: true, tier: 4, room: 0, status: "openrouter per-token" }
      : { backend, available: true, tier: 2, room: 0, status: "openrouter free" };
  }
  const entry = usage.find((e) => e.provider === CLOUD[backend]);
  if (entry?.error) {
    return { backend, available: false, status: `${backend} error` };
  }
  const windows = entry ? relevantWindows(backend, entry, cfg) : [];
  if (!windows.length) {
    // An API-key backend has no plan windows to read; it stays the last resort.
    return cfg.billing === "per-token"
      ? { backend, available: true, tier: 4, room: 0, status: `${backend} per-token, no usage data` }
      : { backend, available: false, status: `${backend} no usage data` };
  }
  const full = windows.find((w) => isFull(backend, w));
  if (full) {
    return { backend, available: false, status: `${backend} ${full.name} ${Math.round(full.used_percent)}% full until ${resetTime(full.resets_at)}` };
  }
  const top = windows.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
  const near = windows.some((w) => w.used_percent >= NEAR);
  const tier = cfg.billing === "per-token" ? 4 : near ? 3 : 1;
  const label = tier === 4 ? " per-token" : near ? " near full" : "";
  return { backend, available: true, tier, room: 100 - top.used_percent, status: `${backend} ${top.name} ${Math.round(top.used_percent)}%${label}` };
}

export function route(usage, config, gpu) {
  const backends = config.backends ?? {};
  const assessed = ["codex", "agy", "openrouter", "ollama"].map((backend) =>
    backends[backend]?.enabled ? assess(backend, usage, backends[backend], gpu) : { backend, available: false, disabled: true, status: `${backend} disabled` }
  );
  const pick = assessed
    .filter((a) => a.available)
    .sort((a, b) => a.tier - b.tier || b.room - a.room)[0];
  if (!pick) {
    return { backend: null, line: `no backend: ${assessed.map((a) => a.status).join(", ")}` };
  }
  const others = assessed.filter((a) => a !== pick && !a.disabled).map((a) => a.status);
  return { backend: pick.backend, line: `→ ${pick.backend} (${[pick.status, ...others].join(", ")})` };
}

const HANDOFF = {
  named: "hand off what was named",
  independent: "hand off any part a worker can do alone",
  all: "hand off everything but orchestration and diff review"
};

// ollamaIdle: ollama is enabled and the GPU is idle. Free local compute raises "named" to "independent".
export function handoffLevel(usage, { ollamaIdle = false } = {}) {
  const week = usage.find((e) => e.provider === "claude")?.windows?.find((w) => w.name === "week");
  const used = typeof week?.used_percent === "number" ? week.used_percent : null;
  let level = used === null ? "named" : used >= 90 ? "all" : used >= 70 ? "independent" : "named";
  const source = used === null ? "claude no usage data" : `claude week ${Math.round(used)}%`;
  if (ollamaIdle && level === "named") {
    level = "independent";
    return { level, line: `${source}, GPU idle → ${HANDOFF[level]}` };
  }
  return { level, line: `${source} → ${HANDOFF[level]}` };
}

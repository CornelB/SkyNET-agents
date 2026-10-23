// Picks a delegation backend from codexbar usage and the machine config.
// Thresholds come from the usage skill (full) and the spec (near full).
const FULL_5H = 90;
const FULL_WEEK = 95;
const FULL_MODEL = 95;
const NEAR = 75;

const CLOUD = { codex: "codex", agy: "antigravity" };

function hhmm(iso) {
  const date = new Date(iso ?? "");
  return Number.isNaN(date.getTime()) ? "?" : date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
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
function assess(backend, usage, cfg) {
  if (backend === "ollama") {
    return { backend, available: true, tier: 2, room: 0, status: "ollama local" };
  }
  const entry = usage.find((e) => e.provider === CLOUD[backend]);
  if (!entry) {
    return { backend, available: false, status: `${backend} no usage data` };
  }
  if (entry.error) {
    return { backend, available: false, status: `${backend} error` };
  }
  const windows = relevantWindows(backend, entry, cfg);
  if (!windows.length) {
    return { backend, available: false, status: `${backend} no usage data` };
  }
  const full = windows.find((w) => isFull(backend, w));
  if (full) {
    return { backend, available: false, status: `${backend} ${full.name} ${Math.round(full.used_percent)}% full until ${hhmm(full.resets_at)}` };
  }
  const top = windows.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
  const near = windows.some((w) => w.used_percent >= NEAR);
  const tier = cfg.billing === "per-token" ? 4 : near ? 3 : 1;
  const label = tier === 4 ? " per-token" : near ? " near full" : "";
  return { backend, available: true, tier, room: 100 - top.used_percent, status: `${backend} ${top.name} ${Math.round(top.used_percent)}%${label}` };
}

export function route(usage, config) {
  const backends = config.backends ?? {};
  const assessed = ["codex", "agy", "ollama"].map((backend) =>
    backends[backend]?.enabled ? assess(backend, usage, backends[backend]) : { backend, available: false, disabled: true, status: `${backend} disabled` }
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

export function handoffLevel(usage) {
  const week = usage.find((e) => e.provider === "claude")?.windows?.find((w) => w.name === "week");
  if (typeof week?.used_percent !== "number") {
    return { level: "named", line: `claude no usage data → ${HANDOFF.named}` };
  }
  const used = week.used_percent;
  const level = used >= 90 ? "all" : used >= 70 ? "independent" : "named";
  return { level, line: `claude week ${Math.round(used)}% → ${HANDOFF[level]}` };
}

import { describeGpu, gpuIdle } from "./gpu.mjs";

const BACKENDS = ["codex", "agy", "openrouter", "ollama"];
const TIERS = ["haiku", "sonnet", "opus", "fable"];
const PROVIDERS = { agy: "antigravity" };

function windowsFor(usage, backend) {
  const entry = usage.find((item) => item.provider === (PROVIDERS[backend] ?? backend));
  return entry && !entry.error
    ? (entry.windows ?? []).filter((w) => Number.isFinite(w.used_percent))
    : [];
}

function countedWindows(usage, backend, cfg) {
  const windows = windowsFor(usage, backend);
  if (backend === "codex" || backend === "claude") {
    return windows.filter((w) => w.name === "5h" || w.name === "week");
  }
  return cfg.window ? windows.filter((w) => w.name === cfg.window) : windows;
}

function full(w) {
  return w.window_minutes <= 300 ? w.used_percent >= 90 : w.used_percent > 80;
}

function fullest(windows) {
  return windows.reduce((top, w) => !top || w.used_percent > top.used_percent ? w : top, null);
}

function windowStatus(backend, w) {
  return `${backend} ${w.name} ${Math.round(w.used_percent)}%`;
}

// Always include the date in UTC: routing has no implicit clock or local timezone.
function resetTime(iso) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "?";
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  return `${day} ${date.toISOString().slice(11, 16)}`;
}

function funnel(role, tier, usage, backends, inClaude) {
  const eligible = BACKENDS.filter((name) => backends[name]?.enabled &&
    (name !== "openrouter" || Object.hasOwn(backends[name], "tiers")));
  const group = (billing) => eligible.filter((name) => backends[name].billing === billing)
    .map((name) => ({ step: name, tier }));
  // Sorting needs quota data only; resolving models belongs to the walk.
  const subscriptions = group("subscription").map((step) => ({
    ...step, top: fullest(countedWindows(usage, step.step, backends[step.step]))
  })).sort((a, b) => Number(Boolean(b.top)) - Number(Boolean(a.top)) ||
    (a.top && b.top ? a.top.used_percent - b.top.used_percent : 0));
  const session = { step: inClaude ? "claude" : "self", tier };
  if (role === "advisor") {
    return [
      ...(inClaude ? [session, { step: "claude", tier: "opus" }] : []),
      ...subscriptions, ...group("per-token")
    ];
  }
  return [
    ...(role === "write" ? group("local") : []),
    ...group("free"), ...subscriptions, session, ...group("per-token")
  ];
}

function assessBackend(name, tier, input) {
  const { usage, config, needsShell, not, forced, running, ollama, resolve } = input;
  const cfg = config.backends?.[name] ?? {};
  let modelInfo = {};
  const answer = (available, status, extra = {}) => ({
    step: name, tier, available, ...modelInfo, ...extra,
    status: `${status}${modelInfo.note ? `, ${modelInfo.note}` : ""}`
  });
  if (!forced && not.includes(name)) return answer(false, `${name} excluded`);
  if (name === "ollama" && !ollama.model) return answer(false, "ollama skipped, no model set");

  if (name === "ollama") {
    const declared = TIERS.indexOf(ollama.tier);
    if (declared < 0) return answer(false, "ollama skipped, no tier declared");
    if (TIERS.indexOf(tier) > declared) return answer(false, `ollama no ${tier} model`);
    modelInfo = { model: ollama.model };
  } else {
    modelInfo = resolve(name, tier);
    if (!modelInfo.serves) return answer(false, `${name} no ${tier} model`);
  }
  if (needsShell && name === "agy") return answer(false, "agy shell read-only");
  const count = running[name] ?? 0;
  const limit = cfg.maxParallel ?? (cfg.billing === "local" ? 1 : 2);
  if (count >= limit) return answer(false, `${name} at limit (${count} running)`);

  const windows = cfg.billing === "subscription" ? countedWindows(usage, name, cfg) : [];
  const blocked = !forced && windows.find(full);
  if (blocked) return answer(false, `${windowStatus(name, blocked)} full until ${resetTime(blocked.resets_at)}`);

  if (name === "ollama") {
    const selection = ollama.select?.();
    if (selection) {
      if (selection.refused) return answer(false, `ollama skipped, ${selection.refused}`);
      return answer(true, `ollama ${selection.host ?? "default server"}, selected`, { ollamaHost: selection.host ?? null });
    }
    const gpu = ollama.readGpu?.();
    if (!gpu) return answer(true, "ollama local");
    const idle = gpuIdle(gpu);
    return answer(Boolean(forced) || idle, `ollama local, ${describeGpu(gpu)}, ${idle ? "idle" : "busy"}`);
  }
  if (cfg.billing === "per-token" || cfg.billing === "free" || cfg.billing === "local") {
    return answer(true, `${name} ${cfg.billing}`);
  }
  const top = fullest(windows);
  return answer(true, top ? windowStatus(name, top) : `${name} usage unknown`);
}

function assessSession(step, tier, usage, not) {
  const answer = (available, status) => ({ step, tier, available, status });
  if (not.includes(step)) return answer(false, `${step} excluded`);
  if (step === "self") return answer(true, "self");
  const windows = windowsFor(usage, "claude");
  const blocked = windows.find((w) => (w.name === "week" || w.name === "5h") && full(w)) ??
    windows.find((w) => w.name.toLowerCase() === `${tier} only` && w.used_percent > 80);
  if (blocked) return answer(false, windowStatus("claude", blocked));
  const week = windows.find((w) => w.name === "week");
  return answer(true, week ? windowStatus("claude", week) : "claude usage unknown");
}

export function route({
  role, tier, usage, config, inClaude, needsShell = false, not = [], forced = null,
  running = {}, ollama = {}, resolve
}) {
  const requestedTier = role === "advisor" ? "fable" : tier;
  const input = { usage, config, needsShell, not, forced, running, ollama, resolve };
  const steps = forced ? [{ step: forced, tier: requestedTier }] :
    funnel(role, requestedTier, usage, config.backends ?? {}, inClaude);
  const visited = [];
  const result = (pick, statuses, overLimit = false) => {
    const backend = pick && BACKENDS.includes(pick.step) ? pick.step : null;
    const label = backend ? `${backend} ${pick.model ?? "own model"}` : `${pick?.step} ${pick?.tier}`;
    return {
      step: pick?.step ?? null, backend, tier: pick?.tier ?? requestedTier,
      model: backend ? pick.model ?? null : null, effort: backend ? pick.effort ?? null : null,
      key: backend ? pick.key ?? null : null, ollamaHost: backend ? pick.ollamaHost ?? null : null,
      overLimit, line: pick ? `→ ${label} (${statuses.join(", ")})` : `no backend: ${statuses.join(", ")}`
    };
  };
  for (const { step, tier: stepTier } of steps) {
    const assessed = BACKENDS.includes(step) ? assessBackend(step, stepTier, input) :
      assessSession(step, stepTier, usage, not);
    if (assessed.available) return result(assessed, [assessed.status, ...visited.map((s) => s.status)]);
    visited.push(assessed);
  }
  const session = inClaude ? "claude" : "self";
  if (!forced && role !== "advisor" && !not.includes(session)) {
    const pick = visited.find((s) => s.step === session);
    return result(pick, [pick.status, ...visited.filter((s) => s !== pick).map((s) => s.status)], true);
  }
  return result(null, visited.map((s) => s.status));
}

const HANDOFF = {
  named: "hand off what was named",
  independent: "hand off any part a worker can do alone",
  all: "hand off everything but orchestration and diff review"
};
const LEVELS = ["named", "independent", "all"];

export function handoffLevel(usage, { ollamaIdle = false, config, now = new Date() } = {}) {
  const week = windowsFor(usage, "claude").find((w) => w.name === "week");
  const used = week?.used_percent ?? null;
  let level = used === null ? "named" : used >= 90 ? "all" : used >= 70 ? "independent" : "named";
  let source = used === null ? "claude no usage data" : windowStatus("claude", week);
  if (ollamaIdle && level === "named") {
    level = "independent";
    source += ", GPU idle";
  }
  let raisedBy = null;
  for (const name of BACKENDS) {
    const cfg = config?.backends?.[name];
    if (!cfg?.enabled || cfg.billing !== "subscription") continue;
    const windows = countedWindows(usage, name, cfg);
    if (windows.some(full)) continue;
    for (const w of windows) {
      if (w.name !== "week" && w.window_minutes !== 10080) continue;
      if (w.used_percent > 80) continue;
      const untilReset = new Date(w.resets_at ?? "").getTime() - now.getTime();
      const candidate = w.used_percent < 70 && untilReset >= 0 && untilReset <= 2 * 86400_000 ? "all" : "independent";
      if (LEVELS.indexOf(candidate) > LEVELS.indexOf(level)) {
        level = candidate;
        raisedBy = windowStatus(name, w);
      }
    }
  }
  return { level, line: `${source}${raisedBy ? `, ${raisedBy}` : ""} → ${HANDOFF[level]}` };
}

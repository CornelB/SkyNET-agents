import assert from "node:assert/strict";
import test from "node:test";
import { handoffLevel, route } from "../scripts/lib/router.mjs";

const reset = "2030-01-03T11:41:00Z";
const window = (name, used_percent, window_minutes = 10080, resets_at = reset) =>
  ({ name, used_percent, window_minutes, resets_at });
const usageFor = (provider, ...windows) => ({ provider, windows });
const codex = (h5, week) => usageFor("codex", window("5h", h5, 300), window("week", week));
const agy = (...used) => usageFor("antigravity", ...used.map((n, i) => window(`pool ${i + 1}`, n)));
const claude = (week, h5 = 0, ...windows) =>
  usageFor("claude", window("5h", h5, 300), window("week", week), ...windows);
const backend = (billing = "subscription", extra = {}) => ({ enabled: true, billing, ...extra });
const config = (backends = {}) => ({ backends });
const mapped = (billing = "per-token") => backend(billing, { tiers: { sonnet: ["paper-2"] } });
const resolved = (name, tier) => ({ serves: true, model: `${name}-paper-2`, effort: "high", key: `${name}:${tier}` });
const ask = (overrides = {}) => route({
  role: "write", tier: "sonnet", usage: [], config: config(), inClaude: true,
  resolve: resolved, ...overrides
});
const local = { model: "paper-local", tier: "sonnet" };
const idleGpu = { busy: 5, used: 3e9, total: 16e9, loaded: false };
const busyGpu = { busy: 95, used: 12e9, total: 16e9, loaded: false };
const unexpected = () => assert.fail("this step must not be evaluated");

test("write walks local, free, subscriptions by room, calling session, per-token", () => {
  const input = {
    config: config({ codex: backend(), agy: backend(), openrouter: mapped("free"), ollama: backend("local") }),
    usage: [codex(40, 6), agy(10)], ollama: local
  };
  assert.equal(ask(input).step, "ollama");
  assert.equal(ask({ ...input, not: ["ollama"] }).step, "openrouter");
  assert.equal(ask({ ...input, not: ["ollama", "openrouter"] }).step, "agy");
  assert.equal(ask({ ...input, not: ["ollama", "openrouter", "agy"] }).step, "codex");
  assert.equal(ask({ ...input, not: ["ollama", "openrouter", "agy", "codex"] }).step, "claude");
  const paid = config({ codex: backend("per-token") });
  assert.equal(ask({ config: paid }).step, "claude");
  assert.equal(ask({ config: paid, usage: [claude(81)] }).step, "codex");
});

test("read omits local and walks free, subscriptions, calling session, per-token", () => {
  const input = {
    role: "read", usage: [codex(20, 6), agy(40)],
    config: config({ codex: backend(), agy: backend(), openrouter: mapped("free"), ollama: backend("local") }),
    ollama: { ...local, select: unexpected, readGpu: unexpected }
  };
  assert.equal(ask(input).step, "openrouter");
  assert.equal(ask({ ...input, not: ["openrouter"] }).step, "codex");
  assert.equal(ask({ ...input, not: ["openrouter", "codex"] }).step, "agy");
  assert.equal(ask({ ...input, not: ["openrouter", "codex", "agy"] }).step, "claude");
  const paid = { ...input, config: config({ openrouter: mapped() }) };
  assert.equal(ask(paid).step, "claude");
  assert.equal(ask({ ...paid, usage: [claude(81)] }).step, "openrouter");
});

test("advisor walks fable, opus, subscriptions, per-token and ignores the input tier", () => {
  const input = {
    role: "advisor", tier: "haiku", usage: [claude(20)],
    config: config({ codex: backend(), agy: backend("free"), ollama: backend("local"), openrouter: mapped() }),
    ollama: { ...local, select: unexpected },
    resolve(name, tier) { assert.equal(tier, "fable"); return resolved(name, tier); }
  };
  assert.equal(ask(input).tier, "fable");
  const second = ask({ ...input, usage: [claude(20, 0, window("FABLE ONLY", 81))] });
  assert.equal(second.step, "claude");
  assert.equal(second.tier, "opus");
  assert.equal(second.line, "→ claude opus (claude week 20%, claude FABLE ONLY 81%)");
  assert.equal(ask({ ...input, usage: [claude(81)] }).step, "codex");
  assert.equal(ask({ ...input, usage: [claude(81)], not: ["codex"] }).step, "openrouter");
});

test("advisor outside Claude omits both session steps, free and local backends", () => {
  const r = ask({
    role: "advisor", inClaude: false,
    config: config({ codex: backend(), agy: backend("free"), ollama: backend("local") }),
    resolve(name, tier) { assert.equal(tier, "fable"); return resolved(name, tier); }
  });
  assert.equal(r.line, "→ codex codex-paper-2 (codex usage unknown)");
  assert.equal(r.tier, "fable");
  assert.equal(ask({ role: "advisor", inClaude: false }).line, "no backend: ");
});

test("a backend pick returns resolved fields and evaluates nothing after the pick", () => {
  const calls = [];
  const r = ask({
    config: config({ codex: backend(), agy: backend() }), usage: [codex(20, 6), agy(40)],
    resolve(name, tier) { calls.push([name, tier]); return resolved(name, tier); }
  });
  assert.deepEqual(r, {
    step: "codex", backend: "codex", tier: "sonnet", model: "codex-paper-2", effort: "high",
    key: "codex:sonnet", ollamaHost: null, overLimit: false,
    line: "→ codex codex-paper-2 (codex 5h 20%)"
  });
  assert.deepEqual(calls, [["codex", "sonnet"]]);
});

test("the pick's status comes first, followed only by visited skips and resolver notes", () => {
  const r = ask({
    config: config({ codex: backend(), agy: backend() }), usage: [codex(95, 6), agy(99)],
    resolve(name, tier) { return { ...resolved(name, tier), note: "model list unreadable" }; }
  });
  assert.equal(r.step, "claude");
  assert.equal(r.line, "→ claude sonnet (claude usage unknown, codex 5h 95% full until 03 Jan 11:41, model list unreadable, agy pool 1 99% full until 03 Jan 11:41, model list unreadable)");
});

test("CLI own models and resolver notes print without inventing a model", () => {
  const r = ask({ config: config({ codex: backend() }), resolve: () => ({ serves: true, note: "model unmapped" }) });
  assert.equal(r.model, null);
  assert.equal(r.effort, null);
  assert.equal(r.key, null);
  assert.equal(r.line, "→ codex own model (codex usage unknown, model unmapped)");
});

test("known room sorts before unknown usage, even near the threshold", () => {
  const cfg = config({ codex: backend(), agy: backend() });
  assert.equal(ask({ config: cfg, usage: [codex(80, 6), { provider: "antigravity", error: "unreadable" }] }).backend, "codex");
  assert.equal(ask({ config: cfg, usage: [{ provider: "codex", error: "unreadable" }, agy(10)] }).backend, "agy");
  assert.equal(ask({ config: cfg, usage: [codex(99, 99)] }).backend, "agy");
});

test("room and subscription status use the fullest counted window", () => {
  const r = ask({ config: config({ codex: backend(), agy: backend() }), usage: [codex(1, 70), agy(20, 30)] });
  assert.equal(r.line, "→ agy agy-paper-2 (agy pool 2 30%)");
});

test("unknown, errored and absent counted windows remain routable", () => {
  for (const usage of [[], [{ provider: "codex", error: "unreadable" }], [usageFor("codex", window("unrelated", 100))]]) {
    assert.equal(ask({ usage, config: config({ codex: backend() }) }).line, "→ codex codex-paper-2 (codex usage unknown)");
  }
  assert.equal(ask({ config: config({ agy: backend() }), usage: [{ provider: "antigravity", error: "unreadable" }] }).backend, "agy");
});

test("codex counts only 5h and week; other subscriptions count all or a configured window", () => {
  assert.equal(ask({ config: config({ codex: backend() }), usage: [usageFor("codex", window("other", 100), window("week", 20))] }).backend, "codex");
  const input = { config: config({ agy: backend() }), usage: [agy(96, 0)] };
  assert.equal(ask(input).step, "claude");
  assert.equal(ask({ ...input, config: config({ agy: backend("subscription", { window: "pool 2" }) }) }).line, "→ agy agy-paper-2 (agy pool 2 0%)");
  assert.equal(ask({ ...input, config: config({ agy: backend("subscription", { window: "missing" }) }) }).line, "→ agy agy-paper-2 (agy usage unknown)");
});

for (const [minutes, used, full] of [[1, 89, false], [1, 90, true], [300, 89.9, false], [300, 90, true], [301, 80, false], [301, 80.1, true], [10080, 80, false], [10080, 81, true]]) {
  test(`subscription threshold: ${minutes} minutes at ${used}% is ${full ? "full" : "available"}`, () => {
    const r = ask({ config: config({ agy: backend() }), usage: [usageFor("antigravity", window("pool", used, minutes))] });
    assert.equal(r.step, full ? "claude" : "agy");
    assert.ok(r.line.includes(`agy pool ${Math.round(used)}%${full ? " full until 03 Jan 11:41" : ""}`));
  });
}

test("codex week above 80 is full; a missing reset prints a question mark", () => {
  assert.equal(ask({ config: config({ codex: backend() }), usage: [codex(10, 81)] }).step, "claude");
  const r = ask({ config: config({ codex: backend() }), usage: [usageFor("codex", { name: "week", used_percent: 99 })] });
  assert.match(r.line, /codex week 99% full until \?/);
});

test("free and per-token backends never skip for quota", () => {
  for (const billing of ["free", "per-token"]) {
    const r = ask({ config: config({ codex: backend(billing) }), usage: [codex(100, 100)], not: ["claude"] });
    assert.equal(r.line, `→ codex codex-paper-2 (codex ${billing}${billing === "per-token" ? ", claude excluded" : ""})`);
  }
});

test("unmapped openrouter is absent from every funnel but can be forced", () => {
  const cfg = config({ openrouter: backend("free") });
  for (const role of ["write", "read", "advisor"]) assert.equal(ask({ role, config: cfg, resolve: unexpected }).step, "claude");
  assert.equal(ask({ config: cfg, forced: "openrouter" }).backend, "openrouter");
});

test("disabled and unsupported backends are omitted", () => {
  const r = ask({ config: config({ codex: backend("subscription", { enabled: false }), unlisted: backend("free") }), resolve: unexpected });
  assert.equal(r.line, "→ claude sonnet (claude usage unknown)");
});

test("rule 1: excluded backends do not resolve models", () => {
  const r = ask({ config: config({ agy: backend() }), not: ["agy"], needsShell: true, running: { agy: 9 }, resolve: unexpected });
  assert.equal(r.line, "→ claude sonnet (claude usage unknown, agy excluded)");
});

test("rule 3: a missing tier model wins over shell, parallel and quota skips", () => {
  const r = ask({ config: config({ agy: backend() }), needsShell: true, running: { agy: 9 }, usage: [agy(100)], resolve: () => ({ serves: false }) });
  assert.equal(r.line, "→ claude sonnet (claude usage unknown, agy no sonnet model)");
});

test("rule 4: only agy is shell read-only, before parallel and quota checks", () => {
  const r = ask({ config: config({ agy: backend() }), needsShell: true, running: { agy: 9 }, usage: [agy(100)] });
  assert.equal(r.line, "→ claude sonnet (claude usage unknown, agy shell read-only)");
  assert.equal(ask({ config: config({ codex: backend() }), needsShell: true }).backend, "codex");
  assert.equal(ask({ config: config({ agy: backend() }) }).backend, "agy");
});

test("rule 5: limits default to one local job or two other jobs, with no queue", () => {
  const cfg = config({ ollama: backend("local"), codex: backend() });
  assert.equal(ask({ config: cfg, ollama: local, running: { ollama: 0, codex: 2 } }).step, "ollama");
  const r = ask({ config: cfg, ollama: { ...local, select: unexpected, readGpu: unexpected }, running: { ollama: 1, codex: 1 } });
  assert.equal(r.line, "→ codex codex-paper-2 (codex usage unknown, ollama at limit (1 running))");
  assert.equal(ask({ config: config({ codex: backend() }), running: { codex: 2 }, usage: [codex(100, 100)] }).line, "→ claude sonnet (claude usage unknown, codex at limit (2 running))");
  for (const billing of ["free", "per-token"]) assert.match(ask({ config: config({ codex: backend(billing) }), running: { codex: 2 }, not: ["claude"] }).line, /codex at limit \(2 running\)/);
});

test("configured parallel limits override defaults", () => {
  const cfg = config({ codex: backend("subscription", { maxParallel: 3 }) });
  assert.equal(ask({ config: cfg, running: { codex: 2 } }).backend, "codex");
  for (const count of [3, 4]) assert.ok(ask({ config: cfg, running: { codex: count } }).line.includes(`codex at limit (${count} running)`));
});

test("ollama rules 1, 2, 3 and 5 precede selector and GPU access, without resolving", () => {
  for (const [options, status] of [
    [{ not: ["ollama"], ollama: {} }, "ollama excluded"],
    [{ ollama: {} }, "ollama skipped, no model set"],
    [{ ollama: { model: "paper-local", tier: null } }, "ollama skipped, no tier declared"],
    [{ ollama: { model: "paper-local", tier: "invalid" } }, "ollama skipped, no tier declared"],
    [{ tier: "opus", ollama: local }, "ollama no opus model"],
    [{ ollama: local, running: { ollama: 1 } }, "ollama at limit (1 running)"]
  ]) {
    const r = ask({ ...options, config: config({ ollama: backend("local") }), resolve: unexpected, ollama: { ...options.ollama, select: unexpected, readGpu: unexpected } });
    assert.ok(r.line.endsWith(`, ${status})`), r.line);
  }
});

test("ollama serves every tier up to its declared tier", () => {
  for (const tier of ["haiku", "sonnet", "opus", "fable"]) {
    const r = ask({ tier, config: config({ ollama: backend("local") }), ollama: { ...local, tier: "fable" }, resolve: unexpected });
    assert.equal(r.step, "ollama");
    assert.equal(r.tier, tier);
    assert.equal(r.model, "paper-local");
    assert.equal(r.effort, null);
    assert.equal(r.key, null);
  }
});

test("a selector runs once and bypasses GPU access, including on refusal", () => {
  for (const selection of [{ host: "http://127.0.0.1:11435" }, { host: null }, { refused: "busy" }]) {
    let calls = 0;
    const r = ask({ config: config({ ollama: backend("local") }), ollama: { ...local, select() { calls++; return selection; }, readGpu: unexpected } });
    assert.equal(calls, 1);
    if (selection.refused) {
      assert.equal(r.line, "→ claude sonnet (claude usage unknown, ollama skipped, busy)");
      assert.equal(r.ollamaHost, null);
    } else {
      assert.equal(r.line, `→ ollama paper-local (ollama ${selection.host ?? "default server"}, selected)`);
      assert.equal(r.ollamaHost, selection.host);
    }
  }
});

test("without a selector ollama accepts absent or idle GPU readings and skips busy ones", () => {
  for (const [gpu, status, step] of [
    [null, "ollama local", "ollama"],
    [idleGpu, "ollama local, GPU 5% busy, VRAM 3.0/16.0 GB, idle", "ollama"],
    [busyGpu, "ollama local, GPU 95% busy, VRAM 12.0/16.0 GB, busy", "claude"],
    [{ ...busyGpu, loaded: true }, "ollama local, GPU 95% busy, VRAM 12.0/16.0 GB, model loaded, idle", "ollama"]
  ]) {
    let selects = 0;
    let reads = 0;
    const r = ask({ config: config({ ollama: backend("local") }), ollama: {
      ...local, select() { selects++; return undefined; }, readGpu() { reads++; return gpu; }
    } });
    assert.equal(selects, 1);
    assert.equal(reads, 1);
    assert.equal(r.step, step);
    assert.ok(r.line.includes(status));
  }
});

test("forced backend ignores enabled, exclusions, quota and busy GPU, evaluating only itself", () => {
  const r = ask({
    config: config({ codex: backend("subscription", { enabled: false }), agy: backend() }),
    forced: "codex", not: ["codex"], usage: [codex(100, 100)],
    resolve(name, tier) { assert.equal(name, "codex"); return resolved(name, tier); }
  });
  assert.equal(r.line, "→ codex codex-paper-2 (codex 5h 100%)");
  const gpu = ask({ role: "read", forced: "ollama", not: ["ollama"],
    config: config({ ollama: backend("local", { enabled: false }) }), ollama: { ...local, readGpu: () => busyGpu }, resolve: unexpected });
  assert.equal(gpu.step, "ollama");
  assert.equal(gpu.line, "→ ollama paper-local (ollama local, GPU 95% busy, VRAM 12.0/16.0 GB, busy)");
});

test("forced refusals keep model, tier, shell, parallel and selector rules without fallback", () => {
  for (const [overrides, status] of [
    [{ forced: "ollama" }, "ollama skipped, no model set"],
    [{ forced: "ollama", ollama: { model: "paper-local" } }, "ollama skipped, no tier declared"],
    [{ forced: "codex", resolve: () => ({ serves: false }) }, "codex no sonnet model"],
    [{ forced: "agy", needsShell: true }, "agy shell read-only"],
    [{ forced: "codex", running: { codex: 2 } }, "codex at limit (2 running)"],
    [{ forced: "ollama", ollama: { ...local, select: () => ({ refused: "reserved" }), readGpu: unexpected } }, "ollama skipped, reserved"]
  ]) {
    const r = ask({ config: config({ codex: backend(), agy: backend(), ollama: backend("local") }), ...overrides });
    assert.equal(r.line, `no backend: ${status}`);
    assert.equal(r.step, null);
    assert.equal(r.backend, null);
    assert.equal(r.overLimit, false);
  }
});

test("calling session checks general quota before its case-insensitive tier window", () => {
  const r = ask({ usage: [claude(81, 90, window("SONNET ONLY", 99))] });
  assert.equal(r.overLimit, true);
  assert.equal(r.line, "→ claude sonnet (claude 5h 90%)");
  assert.equal(ask({ usage: [claude(81)] }).line, "→ claude sonnet (claude week 81%)");
  assert.equal(ask({ usage: [claude(80, 89)] }).overLimit, false);
  assert.equal(ask({ usage: [claude(10, 0, window("SONNET ONLY", 81, 300))] }).line, "→ claude sonnet (claude SONNET ONLY 81%)");
  assert.equal(ask({ usage: [claude(10, 0, window("SONNET ONLY", 80))] }).overLimit, false);
  assert.equal(ask({ usage: [claude(10, 0, window("OPUS ONLY", 100))] }).overLimit, false);
});

test("calling session reports week or unknown usage and ignores unrelated windows", () => {
  assert.equal(ask().line, "→ claude sonnet (claude usage unknown)");
  assert.equal(ask({ usage: [usageFor("claude", window("other", 100))] }).line, "→ claude sonnet (claude usage unknown)");
  assert.equal(ask({ usage: [claude(12)] }).line, "→ claude sonnet (claude week 12%)");
  assert.equal(ask({ usage: [usageFor("claude", window("sonnet only", 81))] }).overLimit, true);
});

test("self never skips on Claude quota and has no backend fields", () => {
  assert.deepEqual(ask({ inClaude: false, usage: [claude(100, 100, window("sonnet only", 100))] }), {
    step: "self", backend: null, tier: "sonnet", model: null, effort: null, key: null,
    ollamaHost: null, overLimit: false, line: "→ self sonnet (self)"
  });
});

test("all-skipped write/read returns the session's skip reason with overLimit true", () => {
  for (const role of ["write", "read"]) {
    const r = ask({ role, config: config({ codex: backend() }), usage: [codex(100, 100), claude(81)] });
    assert.equal(r.step, "claude");
    assert.equal(r.backend, null);
    assert.equal(r.overLimit, true);
    assert.equal(r.line, "→ claude sonnet (claude week 81%, codex 5h 100% full until 03 Jan 11:41)");
  }
});

test("excluded session and exhausted advisor return no backend with every visited status", () => {
  const r = ask({ config: config({ codex: backend() }), not: ["claude", "codex"] });
  assert.equal(r.line, "no backend: codex excluded, claude excluded");
  assert.equal(r.step, null);
  assert.equal(r.backend, null);
  assert.equal(r.overLimit, false);
  assert.equal(ask({ inClaude: false, not: ["self"] }).line, "no backend: self excluded");
  const advisor = ask({ role: "advisor", usage: [claude(81)] });
  assert.equal(advisor.line, "no backend: claude week 81%, claude week 81%");
  assert.equal(advisor.overLimit, false);
  assert.equal(ask({ role: "advisor", not: ["claude"] }).line, "no backend: claude excluded, claude excluded");
});

const phrases = {
  named: "hand off what was named", independent: "hand off any part a worker can do alone",
  all: "hand off everything but orchestration and diff review"
};
const now = new Date("2030-01-01T00:00:00Z");
const soon = "2030-01-03T00:00:00Z";
const handoff = (usage, options = {}) => handoffLevel(usage, { now, ...options });

test("today's hand-off thresholds and exact lines remain without a new raise", () => {
  for (const [used, level] of [[12, "named"], [69, "named"], [70, "independent"], [84, "independent"], [89, "independent"], [90, "all"], [95, "all"]]) {
    assert.deepEqual(handoff([claude(used)]), { level, line: `claude week ${used}% → ${phrases[level]}` });
  }
  assert.deepEqual(handoff([]), { level: "named", line: `claude no usage data → ${phrases.named}` });
  assert.equal(handoffLevel([claude(12)]).line, `claude week 12% → ${phrases.named}`);
});

test("GPU idle raises only named, preserving today's lines", () => {
  assert.deepEqual(handoff([claude(12)], { ollamaIdle: true }), { level: "independent", line: `claude week 12%, GPU idle → ${phrases.independent}` });
  assert.equal(handoff([claude(95)], { ollamaIdle: true }).line, `claude week 95% → ${phrases.all}`);
  assert.equal(handoff([claude(70)], { ollamaIdle: true }).line, `claude week 70% → ${phrases.independent}`);
  assert.equal(handoff([], { ollamaIdle: true }).line, `claude no usage data, GPU idle → ${phrases.independent}`);
});

test("an available subscription week raises named to independent and names the window", () => {
  const cfg = config({ codex: backend() });
  for (const used of [0, 40, 70, 80]) assert.deepEqual(handoff([claude(12), codex(10, used)], { config: cfg }), {
    level: "independent", line: `claude week 12%, codex week ${used}% → ${phrases.independent}`
  });
  assert.equal(handoff([claude(70), codex(10, 40)], { config: cfg }).line, `claude week 70% → ${phrases.independent}`);
  assert.equal(handoff([claude(12), codex(10, 40)], { config: cfg, ollamaIdle: true }).line, `claude week 12%, GPU idle → ${phrases.independent}`);
});

test("more than 30 percent left and a reset within two days raises to all", () => {
  const cfg = config({ codex: backend() });
  for (const used of [0, 40, 69.9]) assert.deepEqual(handoff([claude(12), usageFor("codex", window("week", used, 10080, soon))], { config: cfg }), {
    level: "all", line: `claude week 12%, codex week ${Math.round(used)}% → ${phrases.all}`
  });
  assert.equal(handoff([claude(12), usageFor("codex", window("week", 70, 10080, soon))], { config: cfg }).level, "independent");
  assert.equal(handoff([claude(95), usageFor("codex", window("week", 40, 10080, soon))], { config: cfg }).line, `claude week 95% → ${phrases.all}`);
});

test("missing, invalid, past or distant reset times cannot raise to all", () => {
  for (const resets_at of [undefined, null, "invalid", "2029-12-31T23:59:59Z", "2030-01-03T00:00:00.001Z"]) {
    const usage = [claude(12), usageFor("codex", { name: "week", used_percent: 40, window_minutes: 10080, resets_at })];
    assert.equal(handoff(usage, { config: config({ codex: backend() }) }).level, "independent");
  }
});

test("full, disabled, free, local, per-token and unknown quota cannot raise hand-off", () => {
  const blocked = [
    { config: config({ codex: backend() }), usage: [codex(90, 40)] },
    { config: config({ codex: backend() }), usage: [codex(10, 81)] },
    { config: config({ codex: backend("subscription", { enabled: false }) }), usage: [codex(10, 40)] },
    ...["free", "local", "per-token"].map((billing) => ({ config: config({ codex: backend(billing) }), usage: [codex(10, 40)] })),
    { config: config({ codex: backend() }), usage: [] },
    { config: config({ codex: backend() }), usage: [{ provider: "codex", error: "unreadable" }] },
    { config: config({ agy: backend() }), usage: [usageFor("antigravity", window("5h", 40, 300))] }
  ];
  for (const item of blocked) assert.equal(handoff([claude(12), ...item.usage], { config: item.config }).line, `claude week 12% → ${phrases.named}`);
});

test("hand-off uses agy's provider and configured window, recognizing weekly duration", () => {
  const usage = [claude(12), usageFor("antigravity", window("unused", 100), window("weekly pool", 40, 10080, soon))];
  const cfg = config({ agy: backend("subscription", { window: "weekly pool" }) });
  assert.equal(handoff(usage, { config: cfg }).line, `claude week 12%, agy weekly pool 40% → ${phrases.all}`);
  assert.equal(handoff(usage, { config: config({ agy: backend() }) }).level, "named");
});

test("hand-off takes the highest level and names the backend that raises it there", () => {
  const usage = [claude(12), codex(10, 40), usageFor("antigravity", window("week", 40, 10080, soon))];
  const cfg = config({ codex: backend(), agy: backend() });
  assert.equal(handoff(usage, { config: cfg }).line, `claude week 12%, agy week 40% → ${phrases.all}`);
  assert.equal(handoff(usage, { config: cfg, ollamaIdle: true }).line, `claude week 12%, GPU idle, agy week 40% → ${phrases.all}`);
  assert.equal(handoff(usage.slice(1), { config: cfg }).line, `claude no usage data, agy week 40% → ${phrases.all}`);
});

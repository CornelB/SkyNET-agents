import assert from "node:assert/strict";
import test from "node:test";

import { handoffLevel, route } from "../scripts/lib/router.mjs";

const reset = "2026-10-23T11:41:00Z";
const codex = (h5, week) => ({ provider: "codex", windows: [{ name: "5h", used_percent: h5, resets_at: reset }, { name: "week", used_percent: week, resets_at: reset }] });
const agy = (...used) => ({ provider: "antigravity", windows: used.map((u, i) => ({ name: i ? "Claude and GPT" : "Gemini Models", used_percent: u, resets_at: reset })) });
const claude = (week) => ({ provider: "claude", windows: [{ name: "5h", used_percent: 0 }, { name: "week", used_percent: week }] });
const cfg = (overrides = {}) => ({
  backends: {
    codex: { enabled: true, billing: "subscription" },
    agy: { enabled: true, billing: "subscription" },
    ollama: { enabled: true, billing: "local", model: "m" },
    ...overrides
  }
});
const off = { enabled: false };

test("most room wins among subscriptions", () => {
  assert.equal(route([codex(38, 6), agy(1)], cfg()).backend, "agy");
});

test("codex 5h at 90 is full", () => {
  const r = route([codex(90, 6), agy(50)], cfg());
  assert.equal(r.backend, "agy");
  assert.match(r.line, /^→ agy \(.*codex 5h 90% full/);
});

test("codex week at 95 is full", () => {
  assert.equal(route([codex(10, 95), agy(50)], cfg({ agy: off, ollama: off })).backend, null);
});

test("near full on both goes to ollama", () => {
  assert.equal(route([codex(80, 6), agy(80)], cfg()).backend, "ollama");
});

test("near full beats nothing", () => {
  assert.equal(route([codex(80, 6)], cfg({ agy: off, ollama: off })).backend, "codex");
});

test("per-token ranks after ollama", () => {
  assert.equal(route([codex(10, 6)], cfg({ codex: { enabled: true, billing: "per-token" }, agy: off })).backend, "ollama");
  assert.equal(route([codex(10, 6)], cfg({ codex: { enabled: true, billing: "per-token" }, agy: off, ollama: off })).backend, "codex");
});

test("no usage data falls to ollama", () => {
  const r = route([], cfg());
  assert.equal(r.backend, "ollama");
  assert.match(r.line, /no usage data/);
});

test("errored provider is skipped", () => {
  const r = route([{ provider: "codex", error: "boom" }, agy(10)], cfg());
  assert.equal(r.backend, "agy");
  assert.match(r.line, /codex error/);
});

test("agy highest model window counts without config", () => {
  assert.equal(route([agy(96, 0)], cfg({ codex: off, ollama: off })).backend, null);
});

test("agy configured window counts", () => {
  assert.equal(route([agy(96, 0)], cfg({ codex: off, ollama: off, agy: { enabled: true, billing: "subscription", window: "Claude and GPT" } })).backend, "agy");
});

test("grok is never routed", () => {
  assert.equal(route([{ provider: "grok", windows: [{ name: "5h", used_percent: 0 }] }], cfg({ codex: off, agy: off, ollama: off, grok: { enabled: true } })).backend, null);
});

test("all full names the reset", () => {
  const r = route([codex(95, 6), agy(99)], cfg({ ollama: off }));
  assert.equal(r.backend, null);
  assert.match(r.line, /^no backend: codex 5h 95% full until [^,]+, agy Gemini Models 99% full until [^,]+, openrouter disabled, ollama disabled$/);
});

test("handoff levels follow claude week", () => {
  assert.equal(handoffLevel([claude(69)]).level, "named");
  assert.equal(handoffLevel([claude(70)]).level, "independent");
  assert.equal(handoffLevel([claude(90)]).level, "all");
  assert.equal(handoffLevel([]).level, "named");
  assert.match(handoffLevel([claude(84)]).line, /^claude week 84% → /);
});

test("per-token backend without usage windows is still a last resort", () => {
  const r = route([], cfg({ codex: { enabled: true, billing: "per-token" }, agy: off, ollama: off }));
  assert.equal(r.backend, "codex");
});

test("a reset on another day carries its date", () => {
  const later = new Date(Date.now() + 3 * 86400_000).toISOString();
  const r = route([{ provider: "codex", windows: [{ name: "week", used_percent: 99, resets_at: later }] }], cfg({ agy: off, ollama: off }));
  assert.match(r.line, /full until \d\d [A-Z][a-z]{2} \d\d:\d\d/);
});

test("free openrouter wins the free tier over ollama", () => {
  const r = route([codex(80, 6)], cfg({ agy: off, openrouter: { enabled: true, billing: "free", model: "m" } }));
  assert.equal(r.backend, "openrouter");
  assert.match(r.line, /^→ openrouter \(openrouter free, codex 5h 80% near full, ollama local\)$/);
});

test("subscription with room beats free openrouter", () => {
  assert.equal(route([codex(10, 6)], cfg({ agy: off, openrouter: { enabled: true, billing: "free", model: "m" } })).backend, "codex");
});

test("per-token openrouter ranks last", () => {
  const openrouter = { enabled: true, billing: "per-token", model: "m" };
  assert.equal(route([codex(80, 6)], cfg({ agy: off, ollama: off, openrouter })).backend, "codex");
  assert.equal(route([], cfg({ codex: off, agy: off, ollama: off, openrouter })).backend, "openrouter");
});

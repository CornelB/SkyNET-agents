import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TIERS, tierIndex, parseEntry, entriesFor, compareVersions, resolveSlug, readCodexSlugs, readAgySlugs, ollamaTier, resolveTier } from "../scripts/lib/tiers.mjs";

const noList = () => assert.fail("model list should not be read");
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-tiers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("tiers are ordered from haiku to fable and names are normalized", () => {
  assert.deepEqual(TIERS, ["haiku", "sonnet", "opus", "fable"]);
  for (const [name, index] of [["haiku", 0], [" SONNET ", 1], ["OpUs", 2], ["fable", 3], ["other", -1], ["", -1]]) {
    assert.equal(tierIndex(name), index);
  }
});

test("entries normalize families and retain their original spelling", () => {
  const entry = parseEntry("Acme/Big@high");
  assert.deepEqual(entry, { family: "acme/big", effort: "high" });
  assert.equal(entry.originalFamily, "Acme/Big");
  assert.deepEqual(parseEntry("Acme-Big"), { family: "acme-big", effort: null });
});

test("map lookup uses the exact tier before any higher tier", () => {
  const tiers = { haiku: ["small"], sonnet: ["Acme@high", "other"], opus: ["big"] };
  assert.deepEqual(entriesFor(tiers, " SONNET "), {
    tier: "sonnet", entries: [{ family: "acme", effort: "high" }, { family: "other", effort: null }]
  });
  assert.deepEqual(tiers.sonnet, ["Acme@high", "other"]);
});

test("map lookup skips missing and empty tiers and picks the lowest higher tier", () => {
  assert.deepEqual(entriesFor({ haiku: [], opus: ["big@high"], fable: ["largest"] }, "haiku"), {
    tier: "opus", entries: [{ family: "big", effort: "high" }]
  });
});

test("map lookup never falls to a lower tier", () => {
  assert.equal(entriesFor({ sonnet: ["small"], opus: [] }, "opus"), null);
  assert.equal(entriesFor({}, "haiku"), null);
  assert.equal(entriesFor({ fable: ["big"] }, "unknown"), null);
});

test("versions compare numeric components rather than text or decimal numbers", () => {
  for (const [newer, older] of [["6.2", "6.1"], ["6.1", "6"], ["6", "5.6"], ["6.10", "6.9"], ["6.2.10", "6.2.9"]]) {
    assert.ok(compareVersions(newer, older) > 0);
    assert.ok(compareVersions(older, newer) < 0);
  }
  assert.equal(compareVersions("6.2", "6.2"), 0);
  assert.equal(compareVersions("6.2.0", "6.2"), 0);
});

test("slug resolution picks the newest version without changing the list", () => {
  const slugs = Object.freeze(["acme-6.1-big", "acme-6.10-big", "acme-6.2-big", "acme-5.6-big"]);
  assert.equal(resolveSlug(slugs, parseEntry("big@high"), { effortInSlug: false }), "acme-6.10-big");
  assert.equal(resolveSlug(["acme-6-big", "acme-6.1-big"], parseEntry("big"), { effortInSlug: false }), "acme-6.1-big");
});

test("family matching is case-insensitive and requires consecutive whole tokens", () => {
  const entry = parseEntry("Acme-Big");
  const options = { effortInSlug: false };
  assert.equal(resolveSlug(["prefix-ACME-BIG-2.1-tail"], entry, options), "prefix-ACME-BIG-2.1-tail");
  assert.equal(resolveSlug(["acme-3-big", "acme-bigger-4", "x acme-big-5", "xacme-big-6"], entry, options), null);
  assert.equal(resolveSlug(["acme-big-2", "acme-big-2.1", "other-big-99"], entry, options), "acme-big-2.1");
});

test("versionless slugs and partially numeric tokens are left out", () => {
  const slugs = ["acme-big", "acme-latest-big", "acme-v9-big", "acme-9beta-big", "acme-9.1x-big", "acme-9..1-big"];
  assert.equal(resolveSlug(slugs, parseEntry("big"), { effortInSlug: false }), null);
  assert.equal(resolveSlug([...slugs, "acme-2.1-big"], parseEntry("big"), { effortInSlug: false }), "acme-2.1-big");
});

test("codex effort does not have to appear in the slug", () => {
  assert.equal(resolveSlug(["acme-3-big"], parseEntry("big@high"), { effortInSlug: false }), "acme-3-big");
  assert.equal(resolveSlug(["acme-3-big"], parseEntry("big"), { effortInSlug: false }), "acme-3-big");
});

test("agy requires an entry effort matching the slug's last token", () => {
  const slugs = ["acme-3-big-high", "acme-4-big-low", "acme-5-big-high-preview", "acme-6-big"];
  assert.equal(resolveSlug(slugs, parseEntry("big@high"), { effortInSlug: true }), "acme-3-big-high");
  assert.equal(resolveSlug(slugs, parseEntry("big"), { effortInSlug: true }), null);
  assert.equal(resolveSlug(slugs, parseEntry("big@medium"), { effortInSlug: true }), null);
});

test("codex cache uses CODEX_HOME and excludes hidden models", (t) => {
  const home = tmp(t);
  const codexHome = path.join(home, "cache");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [
    { slug: "acme-2.1-big", visibility: "list" },
    { slug: "acme-99-big", visibility: "hide" },
    { slug: "acme-3-small" },
    { slug: "acme-latest-big" }
  ] }));
  const slugs = readCodexSlugs({ env: { CODEX_HOME: codexHome, HOME: home } });
  assert.deepEqual(slugs, ["acme-2.1-big", "acme-3-small", "acme-latest-big"]);
  assert.equal(resolveSlug(slugs, parseEntry("big"), { effortInSlug: false }), "acme-2.1-big");
});

test("codex cache defaults to HOME/.codex", (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "acme-2-big" }] }));
  assert.deepEqual(readCodexSlugs({ env: { HOME: home } }), ["acme-2-big"]);
});

test("missing and unparsable codex caches return null", (t) => {
  const home = tmp(t);
  assert.equal(readCodexSlugs({ env: { CODEX_HOME: home } }), null);
  fs.writeFileSync(path.join(home, "models_cache.json"), "{bad json");
  assert.equal(readCodexSlugs({ env: { CODEX_HOME: home } }), null);
});

test("a readable empty codex cache returns an empty list", (t) => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [] }));
  assert.deepEqual(readCodexSlugs({ env: { CODEX_HOME: home } }), []);
});

test("agy models takes only the first column of tab-separated lines", () => {
  const spawn = (command, args, options) => {
    assert.equal(command, "agy");
    assert.deepEqual(args, ["models"]);
    assert.equal(options.timeout, 10000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.encoding, "utf8");
    return { status: 0, signal: null, stdout: "Available models\nacme-2-big-high\tBig\nignored\nacme-3-small-low\tSmall\textra\r\n", stderr: "" };
  };
  assert.deepEqual(readAgySlugs({ spawn }), ["acme-2-big-high", "acme-3-small-low"]);
  assert.deepEqual(readAgySlugs({ spawn: () => ({ status: 0, stdout: "no models\n" }) }), []);
});

test("agy failures, non-zero exits and timeouts discard partial output", () => {
  for (const fields of [
    { status: 1 },
    { status: null, error: Object.assign(new Error("not found"), { code: "ENOENT" }) },
    { status: null, signal: "SIGKILL", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    { status: null, signal: "SIGTERM" }
  ]) {
    assert.equal(readAgySlugs({ spawn: () => ({ stdout: "acme-2-big-high\tBig\n", stderr: "", ...fields }) }), null);
  }
  assert.equal(readAgySlugs({ spawn: () => { throw new Error("spawn failed"); } }), null);
});

test("ollama tier is normalized and invalid or unset declarations are null", () => {
  assert.equal(ollamaTier({ OLLAMA_CODING_MODEL_TIER: " OPUS " }), "opus");
  assert.equal(ollamaTier({ OLLAMA_CODING_MODEL_TIER: "haiku" }), "haiku");
  assert.equal(ollamaTier({}), null);
  assert.equal(ollamaTier({ OLLAMA_CODING_MODEL_TIER: "" }), null);
  assert.equal(ollamaTier({ OLLAMA_CODING_MODEL_TIER: "other" }), null);
});

test("an unmapped backend serves every tier without reading a model list", () => {
  for (const tier of TIERS) {
    assert.deepEqual(resolveTier("codex", { model: "own" }, tier, { listSlugs: noList }), {
      serves: true, model: null, effort: null, note: "model unmapped"
    });
  }
});

test("an empty or lower-only map cannot serve the job and reads no list", () => {
  for (const tiers of [{}, { haiku: ["small"] }, { opus: [] }]) {
    assert.deepEqual(resolveTier("codex", { tiers }, "opus", { listSlugs: noList }), { serves: false });
  }
});

test("openrouter uses the first exact id with its original spelling and no effort", () => {
  assert.deepEqual(resolveTier("openrouter", { tiers: { opus: ["Acme/Big-3@high", "other/id"] } }, "sonnet", { listSlugs: noList }), {
    serves: true, tier: "opus", model: "Acme/Big-3", effort: null
  });
  assert.deepEqual(resolveTier("openrouter", { tiers: { haiku: ["Acme/NoVersion"] } }, "haiku", { listSlugs: noList }), {
    serves: true, tier: "haiku", model: "Acme/NoVersion", effort: null
  });
});

test("readable lists resolve the first matching entry before later newer families", () => {
  const cfg = Object.freeze({ tiers: Object.freeze({ sonnet: Object.freeze(["missing@high", "Big@high", "small@low"]) }) });
  const listSlugs = (backend) => {
    assert.equal(backend, "codex");
    return ["acme-2.1-big", "acme-3-big", "acme-99-small"];
  };
  assert.deepEqual(resolveTier("codex", cfg, "sonnet", { listSlugs }), {
    serves: true, tier: "sonnet", model: "acme-3-big", effort: "high", key: "codex:big@high"
  });
});

test("resolved results name the served higher tier and preserve absent effort", () => {
  assert.deepEqual(resolveTier("codex", { tiers: { opus: ["Big"] } }, "sonnet", { listSlugs: () => ["acme-3-big"] }), {
    serves: true, tier: "opus", model: "acme-3-big", effort: null, key: "codex:big@"
  });
});

test("agy tier resolution requires matching effort and can try a later entry", () => {
  assert.deepEqual(resolveTier("agy", { tiers: { opus: ["big", "big@high", "small@low"] } }, "opus", {
    listSlugs: (backend) => {
      assert.equal(backend, "agy");
      return ["acme-3-big-high", "acme-4-big-low", "acme-99-small-low"];
    }
  }), { serves: true, tier: "opus", model: "acme-3-big-high", effort: "high", key: "agy:big@high" });
});

test("a readable list with no matching entry refuses even with a saved slug", () => {
  for (const slugs of [[], ["acme-latest-big"], ["acme-3-small"]]) {
    assert.deepEqual(resolveTier("codex", { tiers: { opus: ["big@high"] } }, "opus", {
      listSlugs: () => slugs, saved: { "codex:big@high": "acme-2-big" }
    }), { serves: false });
  }
});

test("an unreadable list uses the first entry's saved slug and served tier", () => {
  const saved = Object.freeze({ "codex:big@high": "acme-2-big", "codex:small@low": "acme-3-small" });
  assert.deepEqual(resolveTier("codex", { tiers: { opus: ["Big@high", "small@low"] } }, "sonnet", {
    listSlugs: () => null, saved
  }), { serves: true, tier: "opus", model: "acme-2-big", effort: "high", key: "codex:big@high", note: "model list unreadable" });
});

test("an unreadable list without a saved slug falls back to the CLI's own model", () => {
  assert.deepEqual(resolveTier("codex", { tiers: { opus: ["big", "small@low"] } }, "opus", {
    listSlugs: () => null, saved: { "codex:small@low": "acme-3-small" }
  }), { serves: true, tier: "opus", model: null, effort: null, key: "codex:big@", note: "model list unreadable" });
  assert.deepEqual(resolveTier("agy", { tiers: { opus: ["big@high"] } }, "opus", { listSlugs: () => null }), {
    serves: true, tier: "opus", model: null, effort: "high", key: "agy:big@high", note: "model list unreadable"
  });
});

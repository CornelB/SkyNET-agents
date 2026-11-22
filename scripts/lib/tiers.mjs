import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TIERS = Object.freeze(["haiku", "sonnet", "opus", "fable"]);

export function tierIndex(name) {
  return typeof name === "string" ? TIERS.indexOf(name.trim().toLowerCase()) : -1;
}

export function parseEntry(value) {
  const [family, effort = null] = value.split("@");
  const entry = { family: family.toLowerCase(), effort };
  // Exact ids retain their spelling without changing the public parsed shape.
  Object.defineProperty(entry, "originalFamily", { value: family });
  return entry;
}

export function entriesFor(tiersMap, tier) {
  const start = tierIndex(tier);
  if (start < 0) return null;
  for (let i = start; i < TIERS.length; i++) {
    const entries = tiersMap?.[TIERS[i]];
    if (Array.isArray(entries) && entries.length) {
      return { tier: TIERS[i], entries: entries.map(parseEntry) };
    }
  }
  return null;
}

export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function resolveSlug(slugs, entry, { effortInSlug }) {
  if (effortInSlug && !entry.effort) return null;
  const family = entry.family.toLowerCase().split("-");
  let newest = null;
  let newestVersion = null;
  for (const slug of slugs) {
    const tokens = slug.split("-");
    const version = tokens.find((token) => /^\d+(\.\d+)*$/.test(token));
    if (!version || (effortInSlug && tokens.at(-1) !== entry.effort)) continue;
    const lower = tokens.map((token) => token.toLowerCase());
    const matches = lower.some((_, i) => family.every((token, j) => lower[i + j] === token));
    if (matches && (newest === null || compareVersions(version, newestVersion) > 0)) {
      newest = slug;
      newestVersion = version;
    }
  }
  return newest;
}

export function readCodexSlugs({ env = process.env } = {}) {
  try {
    const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
    const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8"));
    if (!Array.isArray(cache?.models)) return null;
    return cache.models.filter((model) => model?.visibility !== "hide" && typeof model?.slug === "string").map((model) => model.slug);
  } catch {
    return null;
  }
}

export function readAgySlugs({ spawn = spawnSync } = {}) {
  try {
    const result = spawn("agy", ["models"], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
    if (result.error || result.status !== 0 || result.signal) return null;
    return (result.stdout ?? "").split(/\r?\n/).filter((line) => line.includes("\t")).map((line) => line.split("\t")[0]);
  } catch {
    return null;
  }
}

export function ollamaTier(env = process.env) {
  return TIERS[tierIndex(env.OLLAMA_CODING_MODEL_TIER)] ?? null;
}

export function resolveTier(backend, cfg, tier, { listSlugs, saved = {} }) {
  if (!Object.hasOwn(cfg, "tiers")) {
    return { serves: true, model: null, effort: null, note: "model unmapped" };
  }
  const served = entriesFor(cfg.tiers, tier);
  if (!served) return { serves: false };
  if (backend === "openrouter") {
    return { serves: true, tier: served.tier, model: served.entries[0].originalFamily, effort: null };
  }
  const slugs = listSlugs(backend);
  for (const entry of served.entries) {
    const key = `${backend}:${entry.family}@${entry.effort ?? ""}`;
    if (slugs === null) {
      return { serves: true, tier: served.tier, model: saved[key] ?? null, effort: entry.effort, key, note: "model list unreadable" };
    }
    const model = resolveSlug(slugs, entry, { effortInSlug: backend === "agy" });
    if (model !== null) {
      return { serves: true, tier: served.tier, model, effort: entry.effort, key };
    }
  }
  return { serves: false };
}

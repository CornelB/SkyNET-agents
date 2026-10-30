import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-data-"));
const { generateJobId, listJobs, upsertJob } = await import("../scripts/lib/state.mjs");
const { resolveCancelableJob, resolveResultJob } = await import("../scripts/lib/job-control.mjs");

test("upsertJob then listJobs returns the job", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-cwd-"));
  upsertJob(cwd, { id: "dlg-1", status: "running" });
  assert.deepEqual(listJobs(cwd).map((job) => [job.id, job.status]), [["dlg-1", "running"]]);
});

test("generateJobId uses the prefix", () => {
  assert.match(generateJobId("dlg"), /^dlg-/);
});

test("result and cancel resolve jobs by status", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-cwd-"));
  upsertJob(cwd, { id: "dlg-a", status: "completed" });
  upsertJob(cwd, { id: "dlg-b", status: "running" });
  assert.equal(resolveResultJob(cwd).job.id, "dlg-a");
  assert.equal(resolveCancelableJob(cwd).job.id, "dlg-b");
  assert.throws(() => resolveResultJob(cwd, "dlg-b"), /still running/);
});

test("concurrent writers lose no jobs", async () => {
  const { spawn } = await import("node:child_process");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-cwd-"));
  const stateUrl = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const writer = (n) =>
    new Promise((resolve) => {
      const code = `const { upsertJob } = await import(${JSON.stringify(stateUrl)}); for (let i = 0; i < 10; i++) upsertJob(${JSON.stringify(cwd)}, { id: "w${n}-" + i, status: "queued" });`;
      spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: "ignore" }).on("exit", resolve);
    });
  await Promise.all([0, 1, 2, 3].map(writer));
  assert.equal(listJobs(cwd).length, 40);
});

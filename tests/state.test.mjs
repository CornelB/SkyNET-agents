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

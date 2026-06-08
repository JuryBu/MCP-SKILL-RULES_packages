import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SUBAGENT_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "wsf-subagent-stage-f-"));
process.env.SUBAGENT_CLEANUP_INTERVAL_SEC = "0";

const { getDataDir, mutateRegistry, readRegistry, upsertJob } = await import("../src/registry.js");
const { subagentCleanup } = await import("../src/tools.js");

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function fakeJob(overrides = {}) {
  const id = overrides.job_id || `stage_f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.created_at || hoursAgo(30);
  return {
    job_id: id,
    sub_cid: overrides.sub_cid || `missing-${id}`,
    main_id: overrides.main_id || "stage-f-main",
    owner_conversation_id: overrides.owner_conversation_id || "stage-f-main",
    root_job_id: overrides.root_job_id || id,
    parent_job_id: overrides.parent_job_id ?? null,
    depth: overrides.depth ?? 0,
    state: overrides.state || "done",
    label: overrides.label || id,
    mode: "ask",
    model: "claude-opus-4-8-xhigh",
    collect_mode: "queue",
    allow_subagent: false,
    max_depth: 1,
    max_concurrent: 4,
    collect_nonce: `collect_${id}`,
    created_at: createdAt,
    updated_at: overrides.updated_at || createdAt,
    completed_at: overrides.completed_at,
    deadline_at: overrides.deadline_at,
    result_step_count: 0,
  };
}

const oldDone = fakeJob({ job_id: `old_done_${Date.now()}`, state: "done", completed_at: hoursAgo(30), updated_at: hoursAgo(30) });
const oldTimeout = fakeJob({ job_id: `old_timeout_${Date.now()}`, state: "timeout", deadline_at: hoursAgo(30), updated_at: hoursAgo(30) });
const oldRunning = fakeJob({ job_id: `old_running_${Date.now()}`, state: "running", updated_at: hoursAgo(30) });
const recentDone = fakeJob({ job_id: `recent_done_${Date.now()}`, state: "done", completed_at: hoursAgo(1), updated_at: hoursAgo(1) });

await upsertJob(oldDone);
await upsertJob(oldTimeout);
await upsertJob(oldRunning);
await upsertJob(recentDone);

const dryRun = parseResult(await subagentCleanup({ idle_ttl_sec: 24 * 60 * 60, dry_run: true, retain_archives: 999 }));
console.log(`dry-run archived=${dryRun.archived.map((item) => item.job_id).join(",")}`);
if (dryRun.archived.length !== 2 || !dryRun.archived.every((item) => item.dry_run)) {
  throw new Error(`dry-run did not select exactly old done/timeout jobs: ${JSON.stringify(dryRun)}`);
}

const live = parseResult(await subagentCleanup({ idle_ttl_sec: 24 * 60 * 60, retain_archives: 999 }));
console.log(`live archived=${live.archived.map((item) => item.job_id).join(",")}`);
if (live.archived.length !== 2) {
  throw new Error(`cleanup did not archive exactly 2 old jobs: ${JSON.stringify(live)}`);
}

let registry = await readRegistry();
for (const jobId of [oldDone.job_id, oldTimeout.job_id]) {
  const job = registry.jobs[jobId];
  if (job.state !== "archived" || !job.archive_path) {
    throw new Error(`old job was not archived with archive_path: ${jobId}`);
  }
  const archiveText = await fs.readFile(job.archive_path, "utf8");
  if (!archiveText.includes(jobId)) {
    throw new Error(`archive is not readable for ${jobId}`);
  }
}
if (registry.jobs[oldRunning.job_id].state !== "running") {
  throw new Error("cleanup touched a running job");
}
if (registry.jobs[recentDone.job_id].state !== "done") {
  throw new Error("cleanup touched a recent done job");
}

const oldArchivePath = path.join(getDataDir(), "archive", `old-archive-${Date.now()}.json`);
await fs.writeFile(oldArchivePath, JSON.stringify({ job_id: "old_archive", retained_for: "stage-f" }, null, 2), "utf8");
await mutateRegistry("stageFSeedArchive", async (currentRegistry) => {
  currentRegistry.archives.old_archive = {
    job_id: "old_archive",
    archive_path: oldArchivePath,
    archived_at: hoursAgo(100),
    delete_after_archive: false,
  };
});

const retentionDryRun = parseResult(await subagentCleanup({ idle_ttl_sec: 24 * 60 * 60, dry_run: true, retain_archives: 1 }));
console.log(`retention prunable=${retentionDryRun.retention.prunable.map((item) => item.job_id).join(",")}`);
if (!retentionDryRun.retention.prunable.some((item) => item.job_id === "old_archive")) {
  throw new Error("retention dry-run did not report old archive as prunable");
}

const retentionLive = parseResult(await subagentCleanup({
  idle_ttl_sec: 24 * 60 * 60,
  retain_archives: 1,
  hard_delete_archives: true,
}));
console.log(`retention deleted=${retentionLive.retention.deleted.map((item) => item.job_id).join(",")} export=${retentionLive.retention.export_path}`);
if (!retentionLive.retention.deleted.some((item) => item.job_id === "old_archive") || !retentionLive.retention.export_path) {
  throw new Error(`retention live did not export+delete old archive: ${JSON.stringify(retentionLive.retention)}`);
}
try {
  await fs.access(oldArchivePath);
  throw new Error("old archive file still exists after hard-delete retention");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.access(retentionLive.retention.export_path);
registry = await readRegistry();
if (!registry.archives.old_archive.file_deleted_at || !registry.archives.old_archive.export_path) {
  throw new Error("retention metadata was not recorded");
}

console.log(`stage-f smoke ok data_dir=${getDataDir()}`);

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsf-subagent-plan4-registry-"));
process.env.SUBAGENT_DATA_DIR = dataDir;

const { mutateRegistry, readRegistry, upsertJob } = await import("../src/registry.js");
const { subagentCleanup, subagentListSubcids } = await import("../src/tools.js");

function daysAgo(days) {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function fakeJob(jobId, state, updatedAt, mainId = "main-a") {
  return {
    job_id: jobId,
    sub_cid: `sub-${jobId}`,
    main_id: mainId,
    owner_conversation_id: mainId,
    root_job_id: jobId,
    parent_job_id: null,
    depth: 0,
    state,
    label: jobId,
    title_best_effort: `[subagent] ${jobId}`,
    mode: "code",
    model: "test-model",
    collect_mode: "interrupt",
    auto_collect: false,
    allow_subagent: false,
    max_depth: 2,
    max_concurrent: 4,
    collect_nonce: `collect_${jobId}`,
    turn: 1,
    collect_results: {},
    turn_results: {},
    created_at: updatedAt,
    updated_at: updatedAt,
    archived_at: ["archived", "deleted"].includes(state) ? updatedAt : undefined,
  };
}

try {
  await upsertJob(fakeJob("active-1", "running", daysAgo(1)));
  await upsertJob(fakeJob("archived-1", "archived", daysAgo(2)));
  await upsertJob(fakeJob("deleted-old", "deleted", daysAgo(10)));
  await upsertJob(fakeJob("deleted-new", "deleted", daysAgo(1)));
  const oldArchivePath = path.join(dataDir, "archive", "deleted-old.json");
  await fs.mkdir(path.dirname(oldArchivePath), { recursive: true });
  await fs.writeFile(oldArchivePath, JSON.stringify({ ok: true }), "utf8");
  await mutateRegistry("seedArchiveRefs", async (registry) => {
    registry.archives["deleted-old"] = {
      job_id: "deleted-old",
      archive_path: oldArchivePath,
      archived_at: daysAgo(10),
      delete_after_archive: true,
    };
  });

  const listed = parseResult(await subagentListSubcids({ main_id: "main-a" }));
  if (listed.sub_cids.includes("sub-deleted-old") || listed.sub_cids.includes("sub-deleted-new")) {
    throw new Error(`subagent_list_subcids should omit deleted jobs: ${JSON.stringify(listed)}`);
  }
  if (!listed.sub_cids.includes("sub-active-1") || !listed.sub_cids.includes("sub-archived-1")) {
    throw new Error(`subagent_list_subcids should include active and archived jobs: ${JSON.stringify(listed)}`);
  }

  const dryRun = parseResult(await subagentCleanup({
    dry_run: true,
    prune_deleted: true,
    deleted_ttl_sec: 7 * 86400,
    retain_deleted: 1,
  }));
  if (!dryRun.deleted_prune?.result?.pruned?.some((job) => job.job_id === "deleted-old")) {
    throw new Error(`dry-run did not identify deleted-old: ${JSON.stringify(dryRun.deleted_prune)}`);
  }
  let registry = await readRegistry();
  if (!registry.jobs["deleted-old"]) {
    throw new Error("dry-run pruned deleted-old unexpectedly");
  }

  const pruned = parseResult(await subagentCleanup({
    prune_deleted: true,
    deleted_ttl_sec: 7 * 86400,
    retain_deleted: 1,
    hard_delete_deleted_archives: true,
  }));
  if (!pruned.deleted_prune?.result?.pruned?.some((job) => job.job_id === "deleted-old")) {
    throw new Error(`prune did not remove deleted-old: ${JSON.stringify(pruned.deleted_prune)}`);
  }
  registry = await readRegistry();
  if (registry.jobs["deleted-old"]) {
    throw new Error("deleted-old remains after prune");
  }
  if (!registry.jobs["deleted-new"]) {
    throw new Error("deleted-new should be retained");
  }
  try {
    await fs.access(oldArchivePath);
    throw new Error("deleted-old archive file should have been hard-deleted after export");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  console.log(`plan4 registry ok subcids=${listed.sub_cids.length} pruned=${pruned.deleted_prune.result.pruned.length}`);
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}

import { cancelCascade, deleteCascade, getSummary, startCascade } from "../src/cascadeOps.js";
import { getJob } from "../src/registry.js";
import { subagentDispose, subagentSpawn, subagentWait } from "../src/tools.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-plan4-archive.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const main = await startCascade(resolverMainId);
let jobId = null;
try {
  const spawned = parseResult(await subagentSpawn({
    prompt: "Plan_4 U1 archive smoke: 只回复 STAGE_U1_ARCHIVE_CHILD_DONE，不要调用工具。",
    main_id: main.cascadeId,
    label: `stage-u1-archive-${Date.now()}`,
    mode: "ask",
    model_profile: "explore",
    auto_collect: false,
    timeout_sec: 180,
  }));
  if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
  jobId = spawned.job_id;
  const waited = parseResult(await subagentWait({ job_id: jobId, wait_ms: 45000, poll_ms: 2000 }));
  if (!waited.ok || !waited.done) {
    throw new Error(`wait did not observe done: ${JSON.stringify(waited)}`);
  }

  const archived = parseResult(await subagentDispose({ job_id: jobId, mode: "archive" }));
  if (!archived.ok || archived.processed?.[0]?.action !== "archive") {
    throw new Error(`archive dispose failed: ${JSON.stringify(archived)}`);
  }
  if (archived.processed[0].ls_archive === null || archived.processed[0].ls_archive === undefined) {
    throw new Error(`archive dispose did not call ArchiveCascadeTrajectory: ${JSON.stringify(archived)}`);
  }
  const job = await getJob(jobId);
  if (job?.state !== "archived" || job.ls_archived !== true) {
    throw new Error(`job was not marked ls_archived: ${JSON.stringify(job)}`);
  }
  const summary = await getSummary(main.cascadeId, job.sub_cid);
  if (!summary) {
    throw new Error("archived subagent disappeared from LS summary unexpectedly");
  }
  console.log(`plan4 archive ok job=${jobId} sub_cid=${job.sub_cid}`);
} finally {
  if (jobId) {
    try {
      await subagentDispose({ job_id: jobId, mode: "delete" });
    } catch {}
  }
  try {
    await cancelCascade(resolverMainId, main.cascadeId);
  } catch {}
  try {
    await deleteCascade(resolverMainId, main.cascadeId);
  } catch {}
}

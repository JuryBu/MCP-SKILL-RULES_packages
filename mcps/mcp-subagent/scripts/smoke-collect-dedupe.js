import { cancelCascade, deleteCascade, startCascade } from "../src/cascadeOps.js";
import { getJob } from "../src/registry.js";
import { subagentCollect, subagentDispose, subagentSpawn, subagentWait } from "../src/tools.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-collect-dedupe.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const main = await startCascade(resolverMainId);
let jobId = null;
try {
  const spawned = parseResult(await subagentSpawn({
    prompt: "Stage K collect dedupe smoke: 只回复 STAGE_K_DEDUPE_CHILD_DONE，不要调用工具。",
    main_id: main.cascadeId,
    label: `stage-k-dedupe-${Date.now()}`,
    mode: "ask",
    model_profile: "explore",
    auto_collect: false,
    timeout_sec: 180,
  }));
  if (!spawned.ok) {
    throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
  }
  jobId = spawned.job_id;
  const waited = parseResult(await subagentWait({ job_id: jobId, wait_ms: 45000, poll_ms: 2000 }));
  if (!waited.ok || !waited.done) {
    throw new Error(`wait did not observe done: ${JSON.stringify(waited)}`);
  }

  const results = await Promise.all([
    subagentCollect({ job_id: jobId, mode: "queue" }),
    subagentCollect({ job_id: jobId, mode: "queue" }),
    subagentCollect({ job_id: jobId, mode: "queue" }),
  ]);
  const parsed = results.map(parseResult);
  if (!parsed.every((item) => item.ok)) {
    throw new Error(`collect calls failed: ${JSON.stringify(parsed)}`);
  }
  const job = await getJob(jobId);
  const queueIds = new Set([
    ...parsed.map((item) => item.queue_id).filter(Boolean),
    ...(job.queue_history || []).map((item) => item.queue_id).filter(Boolean),
  ]);
  if (queueIds.size !== 1) {
    throw new Error(`expected one queue id, got ${JSON.stringify({ parsed, queue: job.queue, queue_history: job.queue_history })}`);
  }
  if ((job.queue_history || []).length !== 1) {
    throw new Error(`expected one queue history entry: ${JSON.stringify(job.queue_history)}`);
  }
  console.log(`collect dedupe ok job=${jobId} queue_id=${[...queueIds][0]} calls=${parsed.map((item) => item.idempotent ? "idempotent" : item.in_progress ? "in_progress" : item.when).join(",")}`);
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


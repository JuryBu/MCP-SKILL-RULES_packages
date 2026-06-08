import { cancelCascade, deleteCascade, queueMessage, sendMessage, startCascade, waitForStatus } from "../src/cascadeOps.js";
import { createMetadata } from "../src/metadata.js";
import {
  subagentCollect,
  subagentDispose,
  subagentMoveQueuedMessage,
  subagentPoll,
  subagentReconcile,
  subagentSpawn,
  waitForJobDone,
} from "../src/tools.js";
import { updateJob, upsertJob } from "../src/registry.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-stage-e.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function fakeJob(overrides = {}) {
  const now = new Date().toISOString();
  const id = overrides.job_id || `fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    job_id: id,
    sub_cid: overrides.sub_cid || `missing-${id}`,
    main_id: overrides.main_id || resolverMainId,
    owner_conversation_id: overrides.owner_conversation_id || resolverMainId,
    root_job_id: overrides.root_job_id || id,
    parent_job_id: overrides.parent_job_id ?? null,
    depth: overrides.depth ?? 0,
    state: overrides.state || "running",
    label: overrides.label || id,
    mode: "ask",
    model: "claude-opus-4-8-xhigh",
    collect_mode: "queue",
    allow_subagent: overrides.allow_subagent ?? false,
    max_depth: overrides.max_depth ?? 1,
    max_concurrent: overrides.max_concurrent ?? 4,
    collect_nonce: `collect_${id}`,
    created_at: now,
    updated_at: now,
    deadline_at: overrides.deadline_at || new Date(Date.now() - 1000).toISOString(),
    result_step_count: 0,
  };
}

async function cleanupMain(cascadeId) {
  try {
    await cancelCascade(resolverMainId, cascadeId);
  } catch {}
  try {
    await deleteCascade(resolverMainId, cascadeId);
    console.log(`cleanup main deleted ${cascadeId}`);
  } catch (error) {
    console.log(`cleanup main failed ${cascadeId}: ${error.message}`);
  }
}

const maxConcurrent = parseResult(await subagentSpawn({
  prompt: "should not spawn",
  main_id: resolverMainId,
  max_concurrent: 0,
}));
console.log(`max-concurrent ok=${maxConcurrent.ok} error=${maxConcurrent.error}`);
if (maxConcurrent.ok !== false || !String(maxConcurrent.error).includes("max_concurrent")) {
  throw new Error("max_concurrent guard did not refuse");
}

const parent = fakeJob({ job_id: `parent_${Date.now()}`, allow_subagent: false });
await upsertJob(parent);
const recursion = parseResult(await subagentSpawn({
  prompt: "should not recurse",
  main_id: resolverMainId,
  parent_job_id: parent.job_id,
}));
console.log(`recursion ok=${recursion.ok} error=${recursion.error}`);
if (recursion.ok !== false || !String(recursion.error).includes("allow")) {
  throw new Error("recursion guard did not refuse");
}

const move = parseResult(await subagentMoveQueuedMessage({ job_id: parent.job_id, to_index: 0 }));
console.log(`move-without-queue ok=${move.ok} error=${move.error}`);
if (move.ok !== false || !String(move.error).includes("queue")) {
  throw new Error("move queued guard did not refuse");
}

const missing = fakeJob({ job_id: `missing_${Date.now()}` });
await upsertJob(missing);
const reconcile = parseResult(await subagentReconcile());
console.log(`reconcile changes=${JSON.stringify(reconcile.changes)}`);
if (!reconcile.changes.some((change) => change.job_id === missing.job_id && change.state === "missing")) {
  throw new Error("reconcile did not mark missing job");
}

await updateJob(parent.job_id, (job) => {
  job.state = "deleted";
});
await updateJob(missing.job_id, (job) => {
  job.state = "deleted";
});

const recursiveParent = parseResult(await subagentSpawn({
  prompt: "请只回复 STAGE_E_PARENT_OK，不要调用工具。",
  main_id: resolverMainId,
  label: `stage-e-parent-${Date.now()}`,
  mode: "ask",
  auto_collect: false,
  allow_subagent: true,
  max_depth: 2,
}));
if (!recursiveParent.ok) throw new Error(`recursive parent spawn failed: ${JSON.stringify(recursiveParent)}`);
await waitForJobDone(recursiveParent.job_id, 120000);
await subagentPoll({ job_id: recursiveParent.job_id });
const recursiveChild = parseResult(await subagentSpawn({
  prompt: "请只回复 STAGE_E_CHILD_OK，不要调用工具。",
  main_id: resolverMainId,
  label: `stage-e-child-${Date.now()}`,
  mode: "ask",
  auto_collect: false,
  parent_job_id: recursiveParent.job_id,
}));
if (!recursiveChild.ok) throw new Error(`recursive child spawn failed: ${JSON.stringify(recursiveChild)}`);
await waitForJobDone(recursiveChild.job_id, 120000);
await subagentPoll({ job_id: recursiveChild.job_id });
const treeDisposed = parseResult(await subagentDispose({
  job_id: recursiveParent.job_id,
  mode: "delete",
  cascade_tree: true,
}));
console.log(`cascade-tree processed=${treeDisposed.processed.length}`);
if (!treeDisposed.ok || treeDisposed.processed.length < 2) {
  throw new Error(`cascade_tree dispose did not process parent+child: ${JSON.stringify(treeDisposed)}`);
}

const oldLimit = process.env.SUBAGENT_MAX_DAILY_INJECTIONS;
process.env.SUBAGENT_MAX_DAILY_INJECTIONS = "0";
const injectionLimited = parseResult(await subagentCollect({
  job_id: recursiveParent.job_id,
  main_id: resolverMainId,
  mode: "queue",
}));
console.log(`injection-limit ok=${injectionLimited.ok} error=${injectionLimited.error}`);
if (injectionLimited.ok !== false || !String(injectionLimited.error).includes("injection limit")) {
  throw new Error("injection limit did not refuse collect");
}
if (oldLimit === undefined) {
  delete process.env.SUBAGENT_MAX_DAILY_INJECTIONS;
} else {
  process.env.SUBAGENT_MAX_DAILY_INJECTIONS = oldLimit;
}

const queueMain = await startCascade(resolverMainId);
try {
  await sendMessage(resolverMainId, queueMain.cascadeId, queueMain.metadata, "Stage E queue order temp main: 请慢慢写 8 小节短文。", {
    model: "claude-opus-4-8-xhigh",
  });
  const running = await waitForStatus(
    resolverMainId,
    queueMain.cascadeId,
    (summary) => String(summary?.status || "").includes("RUNNING"),
    { timeoutMs: 30000, intervalMs: 1000 },
  );
  if (!String(running?.status || "").includes("RUNNING")) throw new Error("queue order main not running");
  const metadata = await createMetadata();
  const q1 = await queueMessage(resolverMainId, queueMain.cascadeId, metadata, "stage-e queue one");
  const q2 = await queueMessage(resolverMainId, queueMain.cascadeId, metadata, "stage-e queue two");
  const moveJob = fakeJob({
    job_id: `move_${Date.now()}`,
    sub_cid: queueMain.cascadeId,
    main_id: queueMain.cascadeId,
    state: "collecting",
    allow_subagent: false,
  });
  moveJob.queue = {
    queue_id: q2.queueId,
    main_id: queueMain.cascadeId,
    state: "queued",
    created_at: new Date().toISOString(),
  };
  await upsertJob(moveJob);
  const moved = parseResult(await subagentMoveQueuedMessage({ job_id: moveJob.job_id, to_index: 0 }));
  console.log(`move-queued ok=${moved.ok} queue=${moved.queue_id}`);
  if (!moved.ok || moved.queue_id !== q2.queueId) throw new Error("MoveQueuedMessage success path failed");
  await updateJob(moveJob.job_id, (job) => {
    job.state = "deleted";
  });
  console.log(`queued order q1=${q1.queueId} q2=${q2.queueId}`);
} finally {
  await cleanupMain(queueMain.cascadeId);
}

console.log("stage-e smoke ok");

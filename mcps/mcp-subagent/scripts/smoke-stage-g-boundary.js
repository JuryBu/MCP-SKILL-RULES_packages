import { cancelCascade, deleteCascade, sendMessage, startCascade, waitForStatus } from "../src/cascadeOps.js";
import { subagentCollect, subagentDispose, subagentPoll, subagentSpawn, waitForJobDone } from "../src/tools.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-stage-g-boundary.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
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

const main = await startCascade(resolverMainId);
let jobId = null;
try {
  await sendMessage(resolverMainId, main.cascadeId, main.metadata, [
    "Stage G boundary temp main.",
    "请慢慢写一篇 8 小节短文，每节至少 120 字。",
    "不要调用工具，只写正文。",
  ].join("\n"), {
    model: "claude-opus-4-8-xhigh",
  });
  const running = await waitForStatus(
    resolverMainId,
    main.cascadeId,
    (summary) => String(summary?.status || "").includes("RUNNING"),
    { timeoutMs: 30000, intervalMs: 1000 },
  );
  console.log(`temp-main cid=${main.cascadeId} status=${running?.status || "unknown"}`);
  if (!String(running?.status || "").includes("RUNNING")) {
    throw new Error("temp main did not enter RUNNING");
  }

  const spawned = parseResult(await subagentSpawn({
    prompt: "请只回复 STAGE_G_BOUNDARY_CHILD_OK，不要调用工具，不要写其他内容。",
    main_id: main.cascadeId,
    label: `stage-g-boundary-${Date.now()}`,
    mode: "ask",
    timeout_sec: 180,
    collect_mode: "interrupt",
    auto_collect: false,
  }));
  console.log(`spawn ok=${spawned.ok} job=${spawned.job_id} sub_cid=${spawned.sub_cid}`);
  if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
  jobId = spawned.job_id;
  await waitForJobDone(jobId, 120000);
  const poll = parseResult(await subagentPoll({ job_id: jobId }));
  console.log(`poll done=${poll.done} result=${JSON.stringify(poll.result_text || poll.result_preview || "")}`);
  if (!poll.done) throw new Error(`child not done: ${JSON.stringify(poll)}`);

  const collect = parseResult(await subagentCollect({
    job_id: jobId,
    main_id: main.cascadeId,
    mode: "interrupt",
    timeout_ms: 60000,
    confirm_timeout_ms: 90000,
    fallback_to_queue: false,
  }));
  console.log(`collect ok=${collect.ok} delivered=${collect.delivered} when=${collect.when} queue=${collect.queue_id}`);
  if (!collect.ok || !collect.delivered || collect.when !== "interrupted") {
    throw new Error(`step-boundary interrupt failed: ${JSON.stringify(collect)}`);
  }
} finally {
  if (jobId) {
    const disposed = parseResult(await subagentDispose({ job_id: jobId, mode: "delete" }));
    console.log(`dispose ok=${disposed.ok} processed=${disposed.processed?.length || 0}`);
  }
  await cleanupMain(main.cascadeId);
}

console.log("stage-g boundary smoke ok");

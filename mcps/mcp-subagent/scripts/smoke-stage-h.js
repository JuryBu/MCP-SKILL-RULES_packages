import { subagentCollect, subagentDispose, subagentPoll, subagentReply, subagentSpawn, waitForJobDone } from "../src/tools.js";
import { cancelCascade, deleteCascade, getSteps, getSummary, sendMessage, startCascade, waitForStatus } from "../src/cascadeOps.js";
import { getJob } from "../src/registry.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-stage-h.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function stepArray(steps) {
  return steps.steps || steps.trajectorySteps || steps.cascadeSteps || [];
}

function allPlannerText(steps) {
  return stepArray(steps)
    .filter((step) => step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" || step.plannerResponse)
    .map((step) => step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || "")
    .join("\n\n---PLANNER_STEP---\n\n");
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

const tempMain = await startCascade(resolverMainId);
let spawned = null;
console.log(`temp main=${tempMain.cascadeId}`);

async function startMainTurn(label, doneMarker) {
  const summary = await getSummary(resolverMainId, tempMain.cascadeId);
  if (String(summary?.status || "").includes("RUNNING")) {
    console.log(`main already running for ${label}`);
    return;
  }
  await sendMessage(resolverMainId, tempMain.cascadeId, tempMain.metadata, [
    `Stage H ${label} 临时主对话。`,
    "请慢慢写一篇关于长期软件维护的长文，至少 8 小节，每小节 160 字以上。",
    `最后单独一行输出 ${doneMarker}。`,
    "不要调用工具，只写正文。",
  ].join("\n"), {
    model: "claude-opus-4-8-xhigh",
  });
  const running = await waitForStatus(
    resolverMainId,
    tempMain.cascadeId,
    (current) => String(current?.status || "").includes("RUNNING"),
    { timeoutMs: 30000, intervalMs: 1000 },
  );
  if (!String(running?.status || "").includes("RUNNING")) {
    throw new Error(`temp main did not enter RUNNING for ${label}`);
  }
}

async function waitMainIdleAndMarker(label, doneMarker) {
  const idle = await waitForStatus(
    resolverMainId,
    tempMain.cascadeId,
    (current) => String(current?.status || "").includes("IDLE"),
    { timeoutMs: 120000, intervalMs: 1000 },
  );
  console.log(`main idle for ${label}: ${idle?.status || "unknown"}`);
  if (!String(idle?.status || "").includes("IDLE")) {
    throw new Error(`temp main did not enter IDLE for ${label}`);
  }
  const text = allPlannerText(await getSteps(resolverMainId, tempMain.cascadeId, 0));
  if (!text.includes(doneMarker)) {
    throw new Error(`main turn ${label} ended without marker ${doneMarker}: ${text.slice(-500)}`);
  }
  console.log(`main marker for ${label}: ${doneMarker}`);
}

try {
  await startMainTurn("turn1-background", "STAGE_H_MAIN_TURN1_DONE");
  spawned = parseResult(await subagentSpawn({
    prompt: "Stage H turn 1：请只回复 STAGE_H_TURN1_READY，不要调用工具。",
    main_id: tempMain.cascadeId,
    label: `stage-h-reply-${Date.now()}`,
    mode: "ask",
    collect_mode: "queue",
    auto_collect: false,
    timeout_sec: 180,
  }));
  console.log(`spawn ok=${spawned.ok} job=${spawned.job_id} sub_cid=${spawned.sub_cid}`);
  if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);

  await waitForJobDone(spawned.job_id, 120000);
  const turn1 = parseResult(await subagentPoll({ job_id: spawned.job_id }));
  console.log(`turn1 done=${turn1.done} text=${JSON.stringify(turn1.result_text || "")}`);
  if (!turn1.done || !String(turn1.result_text || "").includes("STAGE_H_TURN1_READY")) {
    throw new Error(`turn1 failed: ${JSON.stringify(turn1)}`);
  }
  const collect1 = parseResult(await subagentCollect({
    job_id: spawned.job_id,
    main_id: tempMain.cascadeId,
    mode: "interrupt",
    fallback_to_queue: false,
    timeout_ms: 180000,
    confirm_timeout_ms: 120000,
  }));
  console.log(`collect1 ok=${collect1.ok} turn=${collect1.turn} when=${collect1.when} boundary=${collect1.boundary_reason} delivered_by=${collect1.delivered_by} queue=${collect1.queue_id}`);
  if (!collect1.ok || collect1.turn !== 1 || collect1.when !== "interrupted" || collect1.boundary_reason !== "watched_step_done") {
    throw new Error(`collect1 did not interrupt at step boundary: ${JSON.stringify(collect1)}`);
  }
  await waitMainIdleAndMarker("after-turn1-collect", "STAGE_H_MAIN_TURN1_DONE");

  const replied = parseResult(await subagentReply({
    job_id: spawned.job_id,
    message: [
      "Stage H turn 2：你刚才已经回复过 STAGE_H_TURN1_READY。",
      "请基于同一个子代理上下文继续，只回复 STAGE_H_TURN2_CONTEXT_OK，不要调用工具。",
    ].join("\n"),
    mode: "ask",
  }));
  console.log(`reply ok=${replied.ok} turn=${replied.turn} sub_cid=${replied.sub_cid}`);
  if (!replied.ok || replied.turn !== 2 || replied.sub_cid !== spawned.sub_cid) {
    throw new Error(`reply failed: ${JSON.stringify(replied)}`);
  }

  await waitForJobDone(spawned.job_id, 120000);
  const turn2 = parseResult(await subagentPoll({ job_id: spawned.job_id }));
  console.log(`turn2 done=${turn2.done} text=${JSON.stringify(turn2.result_text || "")}`);
  if (!turn2.done || !String(turn2.result_text || "").includes("STAGE_H_TURN2_CONTEXT_OK")) {
    throw new Error(`turn2 failed: ${JSON.stringify(turn2)}`);
  }
  await startMainTurn("turn2-background", "STAGE_H_MAIN_TURN2_DONE");
  const collect2 = parseResult(await subagentCollect({
    job_id: spawned.job_id,
    main_id: tempMain.cascadeId,
    mode: "interrupt",
    fallback_to_queue: false,
    timeout_ms: 180000,
    confirm_timeout_ms: 120000,
  }));
  console.log(`collect2 ok=${collect2.ok} turn=${collect2.turn} when=${collect2.when} boundary=${collect2.boundary_reason} delivered_by=${collect2.delivered_by} queue=${collect2.queue_id}`);
  if (!collect2.ok || collect2.turn !== 2 || collect2.when !== "interrupted" || collect2.boundary_reason !== "watched_step_done" || collect2.queue_id === collect1.queue_id) {
    throw new Error(`collect2 failed, did not interrupt, or reused turn1 idempotence: ${JSON.stringify(collect2)}`);
  }
  await waitMainIdleAndMarker("after-turn2-collect", "STAGE_H_MAIN_TURN2_DONE");

  const job = await getJob(spawned.job_id);
  if (job.sub_cid !== spawned.sub_cid || job.turn !== 2 || !job.collect_results?.["1"] || !job.collect_results?.["2"] || !job.turn_results?.["1"] || !job.turn_results?.["2"]) {
    throw new Error(`registry did not preserve per-turn state: ${JSON.stringify(job)}`);
  }
} finally {
  if (spawned?.job_id) {
    const disposed = parseResult(await subagentDispose({
      job_id: spawned.job_id,
      mode: "delete",
    }));
    console.log(`dispose ok=${disposed.ok} processed=${disposed.processed?.length || 0}`);
    if (!disposed.ok) throw new Error(`dispose failed: ${JSON.stringify(disposed)}`);
  }
  await cleanupMain(tempMain.cascadeId);
}

console.log("stage-h smoke ok");

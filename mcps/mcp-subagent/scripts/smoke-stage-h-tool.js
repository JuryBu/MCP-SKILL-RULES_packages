import { cancelCascade, deleteCascade, getSteps, getSummary, sendMessage, startCascade, waitForStatus } from "../src/cascadeOps.js";
import { subagentCollect, subagentDispose, subagentPoll, subagentReply, subagentSpawn, waitForJobDone } from "../src/tools.js";
import { getJob } from "../src/registry.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-stage-h-tool.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function stepArray(steps) {
  return steps.steps || steps.trajectorySteps || steps.cascadeSteps || [];
}

function stepStatus(step) {
  return String(step?.status || step?.step?.status || step?.state || "").toUpperCase();
}

function isActive(step) {
  return /GENERATING|RUNNING|PENDING|IN_PROGRESS/.test(stepStatus(step));
}

function isToolLike(step) {
  const type = String(step?.type || step?.step?.type || "");
  return isActive(step)
    && ![
      "CORTEX_STEP_TYPE_RETRIEVE_MEMORY",
      "CORTEX_STEP_TYPE_MEMORY",
      "CORTEX_STEP_TYPE_USER_INPUT",
      "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      "CORTEX_STEP_TYPE_CHECKPOINT",
    ].includes(type);
}

function stepDescriptor(step, index) {
  return {
    index,
    type: step?.type || step?.step?.type || "unknown",
    status: stepStatus(step),
    keys: Object.keys(step || {}).slice(0, 8),
  };
}

function stepsText(steps) {
  return JSON.stringify(steps);
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

async function waitForToolLikeStep(cascadeId, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 90000) {
    const summary = await getSummary(resolverMainId, cascadeId);
    const body = await getSteps(resolverMainId, cascadeId, 0);
    const steps = stepArray(body);
    const toolStep = steps.map((step, index) => ({ step, index })).find(({ step }) => isToolLike(step));
    const compact = {
      status: summary?.status || "missing",
      stepCount: summary?.stepCount || steps.length,
      active: steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => isActive(step))
        .map(({ step, index }) => stepDescriptor(step, index)),
    };
    const encoded = JSON.stringify(compact);
    if (encoded !== last) console.log(`${label} ${encoded}`);
    last = encoded;
    if (toolStep) return stepDescriptor(toolStep.step, toolStep.index);
    if (!String(summary?.status || "").includes("RUNNING")) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no active tool-like step observed for ${label}`);
}

async function runToolMainTurn(cascadeId, label, doneMarker) {
  await sendMessage(resolverMainId, cascadeId, main.metadata, [
    `Stage H ${label} tool-step 临时主对话。`,
    "必须真实调用终端/命令工具执行下面的 PowerShell 命令，不要自己模拟输出：",
    `powershell -NoProfile -Command "Start-Sleep -Seconds 20; Write-Output ${doneMarker}"`,
    `命令完成后输出一行总结，必须包含 ${doneMarker}。`,
  ].join("\n"), {
    model: "claude-opus-4-8-xhigh",
  });
  const running = await waitForStatus(
    resolverMainId,
    cascadeId,
    (summary) => String(summary?.status || "").includes("RUNNING"),
    { timeoutMs: 30000, intervalMs: 500 },
  );
  if (!String(running?.status || "").includes("RUNNING")) {
    throw new Error(`tool main did not enter RUNNING for ${label}`);
  }
  const toolStep = await waitForToolLikeStep(cascadeId, label);
  console.log(`${label} tool-step=${JSON.stringify(toolStep)}`);
  return toolStep;
}

async function waitForMarker(cascadeId, marker, label) {
  const idle = await waitForStatus(
    resolverMainId,
    cascadeId,
    (summary) => String(summary?.status || "").includes("IDLE"),
    { timeoutMs: 180000, intervalMs: 1000 },
  );
  if (!String(idle?.status || "").includes("IDLE")) {
    throw new Error(`main did not enter IDLE for ${label}`);
  }
  const body = await getSteps(resolverMainId, cascadeId, 0);
  if (!stepsText(body).includes(marker)) {
    throw new Error(`main steps did not include ${marker} for ${label}`);
  }
  console.log(`${label} marker=${marker}`);
}

const main = await startCascade(resolverMainId);
let spawned = null;
console.log(`temp main=${main.cascadeId}`);

try {
  spawned = parseResult(await subagentSpawn({
    prompt: "Stage H tool turn 1：请只回复 STAGE_H_TOOL_TURN1_READY，不要调用工具。",
    main_id: main.cascadeId,
    label: `stage-h-tool-${Date.now()}`,
    mode: "ask",
    collect_mode: "interrupt",
    auto_collect: false,
    timeout_sec: 180,
  }));
  console.log(`spawn ok=${spawned.ok} job=${spawned.job_id} sub_cid=${spawned.sub_cid}`);
  if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);

  await waitForJobDone(spawned.job_id, 120000);
  const turn1 = parseResult(await subagentPoll({ job_id: spawned.job_id }));
  if (!turn1.done || !String(turn1.result_text || "").includes("STAGE_H_TOOL_TURN1_READY")) {
    throw new Error(`tool turn1 failed: ${JSON.stringify(turn1)}`);
  }

  const tool1 = await runToolMainTurn(main.cascadeId, "tool-turn1", "STAGE_H_TOOL_MAIN_TURN1_DONE");
  const collect1 = parseResult(await subagentCollect({
    job_id: spawned.job_id,
    main_id: main.cascadeId,
    mode: "interrupt",
    fallback_to_queue: false,
    timeout_ms: 180000,
    confirm_timeout_ms: 120000,
  }));
  console.log(`collect1 ok=${collect1.ok} turn=${collect1.turn} boundary=${collect1.boundary_reason} delivered_by=${collect1.delivered_by} watched=${collect1.watched_step?.type}`);
  if (!collect1.ok || collect1.turn !== 1 || collect1.boundary_reason !== "watched_step_done" || collect1.watched_step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
    throw new Error(`tool collect1 did not anchor tool step: ${JSON.stringify({ collect1, tool1 })}`);
  }
  await waitForMarker(main.cascadeId, "STAGE_H_TOOL_MAIN_TURN1_DONE", "tool-turn1");

  const replied = parseResult(await subagentReply({
    job_id: spawned.job_id,
    message: "Stage H tool turn 2：请基于同一个子代理上下文，只回复 STAGE_H_TOOL_TURN2_CONTEXT_OK，不要调用工具。",
    mode: "ask",
  }));
  if (!replied.ok || replied.turn !== 2 || replied.sub_cid !== spawned.sub_cid) {
    throw new Error(`tool reply failed: ${JSON.stringify(replied)}`);
  }
  await waitForJobDone(spawned.job_id, 120000);
  const turn2 = parseResult(await subagentPoll({ job_id: spawned.job_id }));
  if (!turn2.done || !String(turn2.result_text || "").includes("STAGE_H_TOOL_TURN2_CONTEXT_OK")) {
    throw new Error(`tool turn2 failed: ${JSON.stringify(turn2)}`);
  }

  const tool2 = await runToolMainTurn(main.cascadeId, "tool-turn2", "STAGE_H_TOOL_MAIN_TURN2_DONE");
  const collect2 = parseResult(await subagentCollect({
    job_id: spawned.job_id,
    main_id: main.cascadeId,
    mode: "interrupt",
    fallback_to_queue: false,
    timeout_ms: 180000,
    confirm_timeout_ms: 120000,
  }));
  console.log(`collect2 ok=${collect2.ok} turn=${collect2.turn} boundary=${collect2.boundary_reason} delivered_by=${collect2.delivered_by} watched=${collect2.watched_step?.type}`);
  if (!collect2.ok || collect2.turn !== 2 || collect2.boundary_reason !== "watched_step_done" || collect2.watched_step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" || collect2.queue_id === collect1.queue_id) {
    throw new Error(`tool collect2 did not anchor tool step: ${JSON.stringify({ collect2, tool2 })}`);
  }
  await waitForMarker(main.cascadeId, "STAGE_H_TOOL_MAIN_TURN2_DONE", "tool-turn2");

  const job = await getJob(spawned.job_id);
  if (!job.collect_results?.["1"] || !job.collect_results?.["2"]) {
    throw new Error(`tool per-turn collect state missing: ${JSON.stringify(job)}`);
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
  await cleanupMain(main.cascadeId);
}

console.log("stage-h tool smoke ok");

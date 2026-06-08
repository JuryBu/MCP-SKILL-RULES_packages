import { cancelCascade, deleteCascade, getSteps, sendMessage, startCascade } from "../src/cascadeOps.js";
import { subagentDispose, subagentSpawn } from "../src/tools.js";
import { getJob } from "../src/registry.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-auto-collect.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function stepsInclude(steps, text) {
  return JSON.stringify(steps || "").includes(text);
}

const main = await startCascade(resolverMainId);
let jobId = null;
try {
  await sendMessage(
    resolverMainId,
    main.cascadeId,
    main.metadata,
    "Stage I auto-collect temp main: 请写一小段说明，最后单独一行输出 STAGE_I_AUTO_MAIN_DONE。",
    { blocking: false },
  );

  const spawned = parseResult(await subagentSpawn({
    prompt: "请只回复 STAGE_I_AUTO_CHILD_DONE，不要调用工具，不要写其他内容。",
    main_id: main.cascadeId,
    label: `stage-i-auto-${Date.now()}`,
    mode: "ask",
    collect_mode: "interrupt",
    timeout_sec: 180,
  }));
  if (!spawned.ok || spawned.auto_collect !== true) {
    throw new Error(`spawn auto_collect failed: ${JSON.stringify(spawned)}`);
  }
  jobId = spawned.job_id;
  const marker = `[subagent:${jobId}:turn:1]`;
  const deadline = Date.now() + 180000;
  let job = null;
  while (Date.now() < deadline) {
    job = await getJob(jobId);
    if (job?.state === "collected" && job.auto_collect_result?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (!job || job.state !== "collected" || !job.auto_collect_result?.ok) {
    throw new Error(`auto collect did not finish: ${JSON.stringify(job)}`);
  }
  const steps = await getSteps(main.cascadeId, main.cascadeId, 0);
  if (!stepsInclude(steps, marker)) {
    throw new Error(`auto collect marker not found in main steps: ${marker}`);
  }
  console.log(`auto collect ok job=${jobId} delivered_by=${job.auto_collect_result.delivered_by || ""} when=${job.auto_collect_result.when || ""}`);
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

import { cancelCascade, deleteCascade, getSteps, startCascade } from "../src/cascadeOps.js";
import { getJob } from "../src/registry.js";
import { startAutoCollectScheduler, subagentDispose, subagentSpawn } from "../src/tools.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-timeout-late-collect.js <resolver_main_id>");
  process.exit(2);
}

process.env.SUBAGENT_AUTO_COLLECT_SCAN_SEC = "1";
process.env.SUBAGENT_AUTO_COLLECT_POLL_MS = "1000";
process.env.SUBAGENT_TIMEOUT_RECHECK_BASE_MS = "2000";
process.env.SUBAGENT_TIMEOUT_RECHECK_MAX_MS = "4000";

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function stepsInclude(steps, text) {
  return JSON.stringify(steps || "").includes(text);
}

const scheduler = startAutoCollectScheduler();
const main = await startCascade(resolverMainId);
let jobId = null;
try {
  const spawned = parseResult(await subagentSpawn({
    prompt: [
      "Stage L timeout-late smoke 子代理。",
      "请真实调用终端/命令工具执行：powershell -NoProfile -Command \"Start-Sleep -Seconds 8; Write-Output STAGE_L_TIMEOUT_LATE_DONE\"",
      "命令完成后只总结一行，必须包含 STAGE_L_TIMEOUT_LATE_DONE。",
    ].join("\n"),
    main_id: main.cascadeId,
    label: `stage-l-timeout-late-${Date.now()}`,
    mode: "code",
    model_profile: "explore",
    collect_mode: "interrupt",
    timeout_sec: 2,
  }));
  if (!spawned.ok || spawned.auto_collect !== true) {
    throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
  }
  jobId = spawned.job_id;
  const marker = `[subagent:${jobId}:turn:1]`;
  const deadline = Date.now() + 180000;
  let sawTimeout = false;
  let job = null;
  while (Date.now() < deadline) {
    job = await getJob(jobId);
    if (job?.state === "timeout" || job?.timed_out_at) sawTimeout = true;
    if (job?.state === "collected" && job.auto_collect_result?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!sawTimeout) {
    throw new Error(`job never entered timeout before late completion: ${JSON.stringify(job)}`);
  }
  if (!job || job.state !== "collected" || !job.auto_collect_result?.ok || !job.late_completed_after_timeout) {
    throw new Error(`late timeout auto collect did not finish: ${JSON.stringify(job)}`);
  }
  const steps = await getSteps(main.cascadeId, main.cascadeId, 0);
  if (!stepsInclude(steps, marker)) {
    throw new Error(`late collect marker not found in main steps: ${marker}`);
  }
  console.log(`timeout late collect ok job=${jobId} timeout_at=${job.timed_out_at} delivered_by=${job.auto_collect_result.delivered_by || ""} when=${job.auto_collect_result.when || ""}`);
} finally {
  if (scheduler) clearInterval(scheduler);
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

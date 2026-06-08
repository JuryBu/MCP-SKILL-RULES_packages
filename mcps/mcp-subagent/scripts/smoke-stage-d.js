import { cancelCascade, deleteCascade, sendMessage, startCascade, waitForStatus } from "../src/cascadeOps.js";
import { subagentCollect, subagentDispose, subagentPoll, subagentSpawn, waitForJobDone } from "../src/tools.js";

const resolverMainId = process.argv[2];

if (!resolverMainId) {
  console.error("usage: node scripts/smoke-stage-d.js <resolver_main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

async function createRunningMain(label) {
  const main = await startCascade(resolverMainId);
  await sendMessage(resolverMainId, main.cascadeId, main.metadata, [
    `Stage D ${label} 临时主对话。`,
    "请慢慢写一篇关于木桶理论的长文，至少 8 小节，每小节 160 字以上。",
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
  if (!String(running?.status || "").includes("RUNNING")) {
    throw new Error(`temp main did not enter RUNNING for ${label}`);
  }
  return main;
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

async function runMode(mode) {
  const main = await createRunningMain(mode);
  let jobId = null;
  try {
    const spawn = parseResult(await subagentSpawn({
      prompt: `请只回复 STAGE_D_${mode.toUpperCase()}_CHILD_OK，不要调用工具，不要写其他内容。`,
      main_id: main.cascadeId,
      label: `stage-d-${mode}-${Date.now()}`,
      mode: "ask",
      timeout_sec: 180,
      collect_mode: mode,
      auto_collect: false,
    }));
    if (!spawn.ok) throw new Error(`spawn failed ${mode}: ${JSON.stringify(spawn)}`);
    jobId = spawn.job_id;
    await waitForJobDone(jobId, 120000);
    const poll = parseResult(await subagentPoll({ job_id: jobId }));
    if (!poll.done) throw new Error(`child not done for ${mode}`);
    const collect = parseResult(await subagentCollect({
      job_id: jobId,
      main_id: main.cascadeId,
      mode,
      timeout_ms: 30000,
      fallback_to_queue: mode === "interrupt" ? false : undefined,
    }));
    console.log(`collect mode=${mode} ok=${collect.ok} delivered=${collect.delivered} queue=${collect.queue_id} when=${collect.when}`);
    if (!collect.ok || !collect.delivered || !collect.queue_id) {
      throw new Error(`collect failed for ${mode}: ${JSON.stringify(collect)}`);
    }
    if (mode === "interrupt" && collect.when !== "interrupted") {
      throw new Error(`interrupt did not use step-boundary interrupt: ${JSON.stringify(collect)}`);
    }
    const again = parseResult(await subagentCollect({
      job_id: jobId,
      main_id: main.cascadeId,
      mode,
    }));
    console.log(`collect-idempotent mode=${mode} idempotent=${again.idempotent === true}`);
    if (again.idempotent !== true || again.queue_id !== collect.queue_id) {
      throw new Error(`collect not idempotent for ${mode}`);
    }
    const disposed = parseResult(await subagentDispose({ job_id: jobId, mode: "delete" }));
    if (!disposed.ok) throw new Error(`dispose failed for ${mode}`);
  } finally {
    await cleanupMain(main.cascadeId);
  }
}

for (const mode of ["queue", "interrupt", "force"]) {
  await runMode(mode);
}

console.log("stage-d smoke ok");

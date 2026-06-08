import { subagentCollect, subagentDispose, subagentPoll, subagentSpawn, waitForJobDone } from "../src/tools.js";

const mainId = process.argv[2];

if (!mainId) {
  console.error("usage: node scripts/smoke-stage-g.js <main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const spawned = parseResult(await subagentSpawn({
  prompt: [
    "Stage G smoke：请产出一段真实可读的测试结论，不要只回复 OK。",
    "要求：",
    "1. 第一行写 STAGE_G_RESULT_SUMMARY",
    "2. 用 3 个短 bullet 说明：spawn 已运行、result_text 应只包含最终产出、collect 回插不应包含 MEMORY/raw steps",
    "3. 不要调用工具。",
  ].join("\n"),
  main_id: mainId,
  label: `stage-g-${Date.now()}`,
  mode: "ask",
  collect_mode: "interrupt",
  auto_collect: false,
  timeout_sec: 180,
}));
console.log(`spawn ok=${spawned.ok} job=${spawned.job_id} sub_cid=${spawned.sub_cid}`);
if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);

try {
  await waitForJobDone(spawned.job_id, 120000);
  const polled = parseResult(await subagentPoll({ job_id: spawned.job_id }));
  console.log(`poll state=${polled.state} done=${polled.done} step_count=${polled.step_count}`);
  console.log(`result_text=${JSON.stringify((polled.result_text || "").slice(0, 500))}`);
  if (!polled.done) throw new Error(`subagent did not finish: ${JSON.stringify(polled)}`);
  if (!String(polled.result_text || "").includes("STAGE_G_RESULT_SUMMARY")) {
    throw new Error(`result_text did not include expected final output: ${JSON.stringify(polled)}`);
  }
  if (String(polled.result_preview || "").includes("user_global") || String(polled.result_preview || "").includes("CORTEX_STEP_TYPE_MEMORY")) {
    throw new Error("result_preview still contains raw MEMORY/steps content");
  }

  const collected = parseResult(await subagentCollect({
    job_id: spawned.job_id,
    main_id: mainId,
    mode: "interrupt",
    timeout_ms: 30000,
    confirm_timeout_ms: 90000,
  }));
  console.log(`collect ok=${collected.ok} when=${collected.when} queue=${collected.queue_id} confirmed=${collected.confirmed ?? true} fallback=${collected.fallback_from || ""}`);
  if (!collected.ok || !collected.delivered) throw new Error(`collect failed: ${JSON.stringify(collected)}`);
} finally {
  const disposed = parseResult(await subagentDispose({
    job_id: spawned.job_id,
    mode: "delete",
  }));
  console.log(`dispose ok=${disposed.ok} processed=${disposed.processed?.length || 0}`);
  if (!disposed.ok) throw new Error(`dispose failed: ${JSON.stringify(disposed)}`);
}

console.log("stage-g smoke ok");

import { subagentCollect, subagentDispose, subagentPoll, subagentSpawn, waitForJobDone } from "../src/tools.js";
import path from "node:path";

const mainId = process.argv[2];
const readmePath = path.resolve(import.meta.dirname, "..", "README.md");

if (!mainId) {
  console.error("usage: node scripts/smoke-stage-g-tool.js <main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const spawned = parseResult(await subagentSpawn({
  prompt: [
    "Stage G tool-output smoke：你必须真实读取当前仓库文件后再回答。",
    `请读取 \`${readmePath}\`，确认 README 里是否出现 \`subagent_cleanup\`。`,
    "",
    "最终回复必须满足：",
    "1. 第一行写 `STAGE_G_TOOL_RESULT`",
    "2. 写明你读取了哪个文件",
    "3. 写明 `subagent_cleanup` 是否存在",
    "4. 不要粘贴 README 全文，不要回显 raw steps/MEMORY/global rules",
  ].join("\n"),
  main_id: mainId,
  label: `stage-g-tool-${Date.now()}`,
  mode: "code",
  collect_mode: "interrupt",
  auto_collect: false,
  timeout_sec: 300,
}));
console.log(`spawn ok=${spawned.ok} job=${spawned.job_id} sub_cid=${spawned.sub_cid}`);
if (!spawned.ok) throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);

try {
  await waitForJobDone(spawned.job_id, 180000);
  const polled = parseResult(await subagentPoll({ job_id: spawned.job_id }));
  console.log(`poll state=${polled.state} done=${polled.done} step_count=${polled.step_count}`);
  console.log(`result_text=${JSON.stringify((polled.result_text || "").slice(0, 800))}`);
  if (!polled.done) throw new Error(`subagent did not finish: ${JSON.stringify(polled)}`);
  if (!String(polled.result_text || "").includes("STAGE_G_TOOL_RESULT")) {
    throw new Error(`result_text did not include expected marker: ${JSON.stringify(polled)}`);
  }
  if (!String(polled.result_text || "").includes("README.md") || !String(polled.result_text || "").includes("subagent_cleanup")) {
    throw new Error(`tool output did not mention subagent_cleanup: ${JSON.stringify(polled)}`);
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

console.log("stage-g tool smoke ok");

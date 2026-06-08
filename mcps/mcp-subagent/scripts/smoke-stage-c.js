import { subagentDispose, subagentList, subagentPoll, subagentSpawn, waitForJobDone } from "../src/tools.js";
import fs from "node:fs";

const mainId = process.argv[2];

if (!mainId) {
  console.error("usage: node scripts/smoke-stage-c.js <main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const spawn = parseResult(await subagentSpawn({
  prompt: "请只回复 STAGE_C_OK，不要调用工具，不要写其他内容。",
  main_id: mainId,
  label: `stage-c-${Date.now()}`,
  mode: "ask",
  timeout_sec: 180,
  collect_mode: "queue",
  auto_collect: false,
  max_concurrent: 4,
}));

if (!spawn.ok) throw new Error(`spawn failed: ${JSON.stringify(spawn)}`);
console.log(`spawn ok job=${spawn.job_id} sub_cid=${spawn.sub_cid}`);

await waitForJobDone(spawn.job_id, 120000);
const poll = parseResult(await subagentPoll({ job_id: spawn.job_id }));
console.log(`poll state=${poll.state} done=${poll.done} status=${poll.status} step_count=${poll.step_count}`);
if (!poll.done) throw new Error("subagent did not finish");

const listed = parseResult(await subagentList({ filter: "all" }));
console.log(`list count=${listed.jobs.length}`);
if (!listed.jobs.some((job) => job.job_id === spawn.job_id)) {
  throw new Error("spawned job missing from list");
}

const refused = parseResult(await subagentDispose({ job_id: "not-a-real-job", mode: "delete" }));
console.log(`dispose fake ok=${refused.ok} error=${refused.error}`);
if (refused.ok !== false) throw new Error("fake dispose was not refused");

const disposed = parseResult(await subagentDispose({ job_id: spawn.job_id, mode: "delete" }));
console.log(`dispose processed=${disposed.processed.length} action=${disposed.processed[0]?.action}`);
if (!disposed.ok || disposed.processed[0]?.action !== "delete") {
  throw new Error(`dispose failed: ${JSON.stringify(disposed)}`);
}
const archivePath = disposed.processed[0]?.archive_path;
if (!archivePath || !fs.existsSync(archivePath)) {
  throw new Error(`archive missing: ${archivePath}`);
}
const archived = parseResult(await subagentList({ filter: "archived" }));
console.log(`archived count=${archived.jobs.length} archiveExists=true`);
if (!archived.jobs.some((job) => job.job_id === spawn.job_id)) {
  throw new Error("disposed job missing from archived list");
}

console.log("stage-c smoke ok");

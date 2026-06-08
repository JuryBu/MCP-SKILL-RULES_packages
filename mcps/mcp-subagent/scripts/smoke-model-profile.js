import { subagentDispose, subagentPoll, subagentReply, subagentSpawn } from "../src/tools.js";
import { getJob } from "../src/registry.js";

const mainId = process.argv[2];

if (!mainId) {
  console.error("usage: node scripts/smoke-model-profile.js <main_id>");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

async function waitDone(jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = parseResult(await subagentPoll({ job_id: jobId }));
    if (latest.done) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`job did not finish: ${JSON.stringify(latest)}`);
}

const spawned = parseResult(await subagentSpawn({
  prompt: "Stage J model_profile smoke turn1: 只回复 STAGE_J_PROFILE_TURN1，不要调用工具。",
  main_id: mainId,
  label: `stage-j-profile-${Date.now()}`,
  mode: "ask",
  model_profile: "explore",
  auto_collect: false,
  timeout_sec: 180,
}));
if (!spawned.ok) {
  throw new Error(`spawn failed: ${JSON.stringify(spawned)}`);
}
if (spawned.model_profile !== "explore" || !spawned.model_resolved || !spawned.model_source || !Array.isArray(spawned.model_fallback_chain)) {
  throw new Error(`spawn did not return model resolution evidence: ${JSON.stringify(spawned)}`);
}

try {
  await waitDone(spawned.job_id);
  const jobAfterSpawn = await getJob(spawned.job_id);
  if (jobAfterSpawn.model_profile !== "explore" || !jobAfterSpawn.model_resolved || !jobAfterSpawn.model_catalog_updated_at) {
    throw new Error(`registry missing spawn model evidence: ${JSON.stringify(jobAfterSpawn)}`);
  }

  const reply = parseResult(await subagentReply({
    job_id: spawned.job_id,
    message: "Stage J model_profile smoke turn2: 只回复 STAGE_J_PROFILE_TURN2，不要调用工具。",
    model_profile: "fronted",
    mode: "ask",
  }));
  if (!reply.ok) {
    throw new Error(`reply failed: ${JSON.stringify(reply)}`);
  }
  if (reply.model_profile !== "frontend" || !reply.model_resolved || !reply.model_source || !Array.isArray(reply.model_fallback_chain)) {
    throw new Error(`reply did not return model resolution evidence: ${JSON.stringify(reply)}`);
  }
  await waitDone(spawned.job_id);
  const jobAfterReply = await getJob(spawned.job_id);
  const replyRecord = jobAfterReply.replies?.find((item) => item.turn === 2);
  if (!replyRecord || replyRecord.model_profile !== "frontend" || !replyRecord.model_resolved || !replyRecord.model_catalog_updated_at) {
    throw new Error(`registry missing reply model evidence: ${JSON.stringify(jobAfterReply.replies)}`);
  }
  console.log(`model profile ok job=${spawned.job_id} spawn=${spawned.model_resolved} reply=${reply.model_resolved}`);
} finally {
  try {
    await subagentDispose({ job_id: spawned.job_id, mode: "delete" });
  } catch {}
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callResolvedLanguageServer, resolveLanguageServer } from "../src/lsClient.js";

const execFileAsync = promisify(execFile);
const mainId = process.argv[2];
const maxWaitMs = Number(process.env.WSF_LS_RESTART_WAIT_MS || 60000);

if (!mainId) {
  console.error("usage: node scripts/smoke-ls-restart.js <main_id>");
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(pid) {
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Stop-Process -Id ${Number(pid)} -Force`,
  ]);
}

async function waitForRecovery(oldPid) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < maxWaitMs) {
    try {
      const result = await callResolvedLanguageServer({
        mainId,
        method: "GetAllCascadeTrajectories",
        retries: 1,
        timeoutMs: 7000,
      });
      if (result.resolved.pid !== oldPid) {
        return result;
      }
      lastError = new Error(`old pid ${oldPid} is still serving`);
    } catch (error) {
      lastError = error;
    }
    await sleep(2000);
  }
  throw new Error(`LS did not recover within ${maxWaitMs}ms: ${lastError?.message || "unknown error"}`);
}

const before = await resolveLanguageServer({ mainId });
console.log(`before pid=${before.pid} port=${before.port} status=${before.matchedMain?.status || "unknown"}`);

await stopProcess(before.pid);
console.log(`stopped pid=${before.pid}`);

const recovered = await waitForRecovery(before.pid);
const summaries = recovered.body.trajectorySummaries || {};
const matched = summaries[mainId];

console.log(
  `recovered pid=${recovered.resolved.pid} port=${recovered.resolved.port} attempts=${recovered.attempts} status=${matched?.status || "unknown"}`,
);
console.log(`trajectories=${Object.keys(summaries).length}`);

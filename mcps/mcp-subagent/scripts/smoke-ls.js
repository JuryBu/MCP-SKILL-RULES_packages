#!/usr/bin/env node
import { getAccessToken, redactToken } from "../src/auth.js";
import { callResolvedLanguageServer } from "../src/lsClient.js";

const mainId = process.argv[2] || process.env.SUBAGENT_MAIN_ID || undefined;

try {
  const tokenInfo = await getAccessToken();
  console.log(`token=${redactToken(tokenInfo.accessToken)} account=${tokenInfo.accountLabel || "unknown"}`);
  const result = await callResolvedLanguageServer({
    mainId,
    method: "GetAllCascadeTrajectories",
    payload: {},
    retries: 1,
  });
  const summaries = result.body.trajectorySummaries || {};
  const entries = Object.entries(summaries);
  console.log(`ls=pid:${result.resolved.pid} port:${result.resolved.port} attempts=${result.attempts} trajectories=${entries.length}`);
  if (mainId) {
    console.log(`main_id=${mainId} status=${result.resolved.matchedMain?.status || "missing"}`);
  }
  for (const [id, summary] of entries.slice(0, 5)) {
    console.log(`${id} | ${summary.status || "?"} | ${summary.stepCount ?? "?"} | ${summary.summary || ""}`);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

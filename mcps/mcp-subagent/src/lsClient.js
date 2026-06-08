import { discoverLanguageServerCandidates } from "./auth.js";

const SERVICE = "exa.language_server_pb.LanguageServerService";

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

export async function callLanguageServer({ port, csrf, method, payload = {}, timeoutMs = 10000 }) {
  const { controller, timer } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${SERVICE}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeium-csrf-token": csrf,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const error = new Error(`LS ${method} failed: HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body ?? {};
  } finally {
    clearTimeout(timer);
  }
}

function isRecoverableLsError(error) {
  if (error.name === "AbortError") return true;
  if (error.status === 401 || error.status === 403) return true;
  if (error.cause) return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|terminated|aborted/i.test(error.message || "");
}

async function readSummaries(candidate, port, timeoutMs) {
  const body = await callLanguageServer({
    port,
    csrf: candidate.csrf,
    method: "GetAllCascadeTrajectories",
    payload: {},
    timeoutMs,
  });
  return body.trajectorySummaries || {};
}

function scoreCandidate({ summaries, mainId }) {
  if (!mainId) return 1;
  const summary = summaries[mainId];
  if (!summary) return -1;
  let score = 100;
  if (String(summary.status || "").includes("RUNNING")) score += 10;
  if (summary.lastModifiedTime) score += 1;
  return score;
}

export async function resolveLanguageServer({ mainId, timeoutMs = 7000 } = {}) {
  const candidates = await discoverLanguageServerCandidates({ timeoutMs });
  const matches = [];
  const failures = [];
  let usableSummaryCount = 0;
  let totalSummaryCount = 0;

  for (const candidate of candidates) {
    if (!candidate.csrf || !Array.isArray(candidate.ports)) continue;
    for (const port of candidate.ports) {
      try {
        const summaries = await readSummaries(candidate, port, timeoutMs);
        usableSummaryCount += 1;
        totalSummaryCount += Object.keys(summaries || {}).length;
        const score = scoreCandidate({ summaries, mainId });
        if (score >= 0) {
          matches.push({ candidate, port, summaries, score });
        }
      } catch (error) {
        failures.push({ pid: candidate.pid, port, error: error.message });
      }
    }
  }

  if (matches.length === 0) {
    const suffix = failures.length ? `; failures=${JSON.stringify(failures).slice(0, 500)}` : "";
    const mainIdHint = mainId
      ? "; hint: main_id must be a real current Windsurf/Devin Cascade conversation ID, not a job label or arbitrary test string. Call subagent_current first or use conversation_read_original(action=\"list\", dataChain=\"windsurf\") to locate the current Cascade ID."
      : "";
    if (mainId && usableSummaryCount > 0) {
      throw new Error(`No Windsurf/Devin LS contains main_id=${mainId}; usable_ls=${usableSummaryCount}; known_trajectories=${totalSummaryCount}${mainIdHint}${suffix}`);
    }
    throw new Error(`No usable Windsurf/Devin LS found${mainId ? ` for main_id=${mainId}` : ""}${mainIdHint}${suffix}`);
  }

  matches.sort((left, right) => right.score - left.score);
  const best = matches[0];
  const tied = matches.filter((item) => item.score === best.score);
  if (mainId && tied.length > 1) {
    const details = tied.map((item) => ({
      pid: item.candidate.pid,
      port: item.port,
      status: item.summaries[mainId]?.status,
      lastModifiedTime: item.summaries[mainId]?.lastModifiedTime,
      workspaces: item.summaries[mainId]?.workspaces,
    }));
    throw new Error(`Multiple LS candidates contain main_id=${mainId}; details=${JSON.stringify(details)}`);
  }

  return {
    pid: best.candidate.pid,
    port: best.port,
    csrf: best.candidate.csrf,
    summaries: best.summaries,
    matchedMain: mainId ? best.summaries[mainId] : null,
  };
}

export async function callResolvedLanguageServer({
  mainId,
  method,
  payload = {},
  timeoutMs = 10000,
  retries = 1,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const resolved = await resolveLanguageServer({ mainId, timeoutMs });
    try {
      const body = await callLanguageServer({
        port: resolved.port,
        csrf: resolved.csrf,
        method,
        payload,
        timeoutMs,
      });
      return {
        body,
        resolved: {
          pid: resolved.pid,
          port: resolved.port,
          matchedMain: resolved.matchedMain,
        },
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      if (!isRecoverableLsError(error) || attempt >= retries) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function getAllCascadeTrajectories(options = {}) {
  const resolved = await resolveLanguageServer(options);
  return {
    pid: resolved.pid,
    port: resolved.port,
    trajectorySummaries: resolved.summaries,
    matchedMain: resolved.matchedMain,
  };
}

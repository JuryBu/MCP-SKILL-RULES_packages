import fs from "node:fs/promises";
import path from "node:path";
import { writeAudit } from "./audit.js";
import {
  cancelCascade,
  deleteCascade,
  getSteps,
  getSummary,
  getTrajectory,
  interruptWithQueuedMessage,
  moveQueuedMessage,
  queueMessage,
  removeFromQueue,
  renameCascade,
  sendMessage,
  startCascade,
  waitForStatus,
} from "./cascadeOps.js";
import { getAllCascadeTrajectories } from "./lsClient.js";
import { createCascadeConfig, createMetadata } from "./metadata.js";
import { getModelProfiles, resolveModelSelection } from "./modelCatalog.js";
import {
  createJobId,
  getDataDir,
  getJob,
  readRegistry,
  listJobs,
  mutateRegistry,
  updateJob,
  upsertJob,
} from "./registry.js";

const MODE_MAP = {
  code: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
  plan: "CONVERSATIONAL_PLANNER_MODE_PLANNING",
  ask: "CONVERSATIONAL_PLANNER_MODE_READ_ONLY",
  no_tool: "CONVERSATIONAL_PLANNER_MODE_NO_TOOL",
  explore: "CONVERSATIONAL_PLANNER_MODE_EXPLORE",
  auto: "CONVERSATIONAL_PLANNER_MODE_AUTO",
};

const autoCollectTimers = new Map();
const autoCollectRuns = new Set();
const collectRuns = new Set();

function nowIso() {
  return new Date().toISOString();
}

function deadlineIso(timeoutSec) {
  return new Date(Date.now() + timeoutSec * 1000).toISOString();
}

function jobTurn(job) {
  return Number(job.turn || 1);
}

function collectResultForTurn(job) {
  const turn = jobTurn(job);
  return job.collect_results?.[String(turn)] || (turn === 1 ? job.collect_result : null);
}

function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function failResult(message, extra = {}) {
  return textResult({ ok: false, error: message, ...extra });
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isOlderThan(isoString, ttlMs, now = Date.now()) {
  const time = Date.parse(isoString || "");
  if (!Number.isFinite(time)) return false;
  return now - time >= ttlMs;
}

function cleanupAgeAnchor(job) {
  if (job.state === "timeout") return job.deadline_at || job.updated_at;
  return job.completed_at || job.updated_at;
}

function stepArray(steps) {
  return steps.steps || steps.trajectorySteps || steps.cascadeSteps || [];
}

function extractResultText(steps) {
  const plannerSteps = stepArray(steps)
    .filter((step) => step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" || step.plannerResponse)
    .reverse();
  for (const step of plannerSteps) {
    const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  const checkpointSteps = stepArray(steps)
    .filter((step) => step.checkpoint?.userIntent)
    .reverse();
  for (const step of checkpointSteps) {
    const text = step.checkpoint?.userIntent;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function compactStepsPreview(steps, resultText = "") {
  if (resultText) return resultText.length > 2000 ? `${resultText.slice(0, 2000)}...` : resultText;
  const preview = stepArray(steps)
    .map((step, index) => `${index}:${step.type || "unknown"}:${step.status || step.state || "unknown"}`)
    .join("\n");
  return preview || "No step preview captured.";
}

async function normalizeImages(images = []) {
  const normalized = [];
  for (const image of images) {
    if (typeof image === "string") {
      const buffer = await fs.readFile(image);
      const ext = path.extname(image).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      normalized.push({
        base64Data: buffer.toString("base64"),
        mimeType,
        caption: path.basename(image),
      });
    } else if (image && typeof image === "object") {
      normalized.push(image);
    }
  }
  return normalized;
}

function modelErrorText(error) {
  return `${error?.message || ""} ${JSON.stringify(error?.body || "")}`;
}

function isLikelyModelSelectionError(error) {
  return /model|requestedModel|permission|allowed|tier|quota|unsupported|invalid/i.test(modelErrorText(error));
}

function retryCandidateModels(modelSelection) {
  const seen = new Set();
  const candidates = [];
  for (const candidate of [
    { uid: modelSelection.model_resolved, source: modelSelection.model_source, available: true },
    ...(modelSelection.model_fallback_chain || []),
  ]) {
    if (!candidate?.uid || candidate.available === false) continue;
    const key = String(candidate.uid).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

async function sendMessageWithModelFallback({ mainId, cascadeId, metadata, text, mode, images, blocking, modelSelection }) {
  const candidates = retryCandidateModels(modelSelection);
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const cascadeConfig = createCascadeConfig({
      model: candidate.uid,
      mode,
    });
    try {
      await sendMessage(mainId, cascadeId, metadata, text, {
        model: candidate.uid,
        mode,
        images,
        cascadeConfig,
        blocking,
      });
      if (candidate.uid !== modelSelection.model_resolved) {
        return {
          ...modelSelection,
          model_resolved: candidate.uid,
          model_source: candidate.source || modelSelection.model_source,
          model_note: `initial model failed at send time; fell back to ${candidate.uid}`,
          model_send_fallback_from: modelSelection.model_resolved,
          model_send_error: lastError?.message || null,
        };
      }
      return modelSelection;
    } catch (error) {
      lastError = error;
      if (index >= candidates.length - 1 || !isLikelyModelSelectionError(error)) {
        throw error;
      }
    }
  }
  throw lastError || new Error("no model candidate available");
}

function injectContext(prompt, options) {
  if (options.with_context === false) return prompt;
  const refs = Array.isArray(options.ref_ids) && options.ref_ids.length
    ? `\nref_ids=${options.ref_ids.join(",")}`
    : "";
  return [
    "[WSF MCP Subagent Context]",
    `main_id=${options.main_id}`,
    `job_label=${options.label || ""}${refs}`,
    "",
    prompt,
  ].join("\n");
}

function looksLikePlaceholderMainId(mainId) {
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mainId);
}

function summarizeTrajectory(id, summary) {
  return {
    main_id: id,
    status: summary?.status || null,
    step_count: summary?.stepCount ?? null,
    title: summary?.summary || null,
    last_modified_time: summary?.lastModifiedTime || null,
    created_time: summary?.createdTime || null,
    model: summary?.lastGeneratorModelUid || null,
    workspaces: summary?.workspaces || [],
  };
}

export async function subagentCurrent(args = {}) {
  const query = String(args.query || "").trim().toLowerCase();
  const limit = Number(args.limit || 8);
  const result = await getAllCascadeTrajectories();
  const candidates = Object.entries(result.trajectorySummaries || {})
    .map(([id, summary]) => summarizeTrajectory(id, summary))
    .filter((item) => {
      if (!query) return true;
      return JSON.stringify(item).toLowerCase().includes(query);
    })
    .sort((left, right) => {
      const leftRunning = String(left.status || "").includes("RUNNING") ? 1 : 0;
      const rightRunning = String(right.status || "").includes("RUNNING") ? 1 : 0;
      if (leftRunning !== rightRunning) return rightRunning - leftRunning;
      return Date.parse(right.last_modified_time || right.created_time || 0) - Date.parse(left.last_modified_time || left.created_time || 0);
    })
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 8);
  return textResult({
    ok: true,
    resolved_pid: result.pid,
    resolved_port: result.port,
    current_best_effort: candidates[0] || null,
    candidates,
    note: "Use current_best_effort.main_id or a candidate main_id as subagent_spawn.main_id. Do not invent main_id labels.",
  });
}

export async function subagentModels(args = {}) {
  const detail = args.detail || "summary";
  const includeAvailable = Boolean(args.include_available) || detail === "full";
  const candidateLimit = Number(args.candidate_limit ?? (args.purpose ? 6 : 3));
  const models = await getModelProfiles({
    purpose: args.purpose,
    refresh: Boolean(args.refresh),
    include_unverified: Boolean(args.include_unverified),
  });
  const profiles = Object.fromEntries(Object.entries(models.profiles || {}).map(([name, profile]) => {
    const candidates = profile.candidates || [];
    if (detail === "full" || detail === "detail" || args.purpose) {
      return [name, {
        ...profile,
        candidates: candidates.slice(0, Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : candidates.length),
        candidate_count: candidates.length,
      }];
    }
    return [name, {
      name: profile.name,
      description: profile.description,
      aliases: profile.aliases || [],
      first_available: profile.first_available,
      candidate_count: candidates.length,
      sample_candidates: candidates.slice(0, Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : 3).map((candidate) => ({
        uid: candidate.uid,
        label: candidate.label,
        source: candidate.source,
        available: candidate.available !== false,
        note: candidate.profile_note || candidate.note || null,
      })),
    }];
  }));
  return textResult({
    ok: true,
    detail,
    updated_at: models.updated_at,
    sources: models.sources,
    profiles,
    available_count: models.available.length,
    ...(includeAvailable ? { available: models.available } : {}),
    fallback_policy: models.fallback_policy,
    note: includeAvailable
      ? "cached source is the IDE's current cached Cascade model list, not a guaranteed server realtime full list."
      : "summary view omits the full model list; pass detail:'full' or include_available:true to inspect all available models.",
  });
}

export async function subagentSpawn(args) {
  const prompt = String(args.prompt || "").trim();
  const mainId = String(args.main_id || "").trim();
  if (!prompt) return failResult("prompt is required");
  if (!mainId) {
    return failResult("main_id is required; call subagent_current first and use current_best_effort.main_id", {
      hint_tool: "subagent_current",
    });
  }
  if (looksLikePlaceholderMainId(mainId)) {
    return failResult("main_id must be a real Windsurf/Devin Cascade conversation UUID, not a job label or arbitrary test string; call subagent_current first", {
      provided_main_id: mainId,
      hint_tool: "subagent_current",
    });
  }

  const mode = args.mode || "code";
  const modelSelection = await resolveModelSelection({
    model: args.model,
    model_profile: args.model_profile,
  });
  const label = args.label || prompt.slice(0, 48);
  const timeoutSec = Number(args.timeout_sec || 300);
  const maxDepth = Number(args.max_depth ?? 2);
  const maxConcurrent = Number(args.max_concurrent ?? 4);
  const allowSubagent = Boolean(args.allow_subagent);
  const collectMode = args.collect_mode || "interrupt";
  const autoCollect = args.auto_collect !== false;
  const jobId = createJobId();
  let parentJob = null;
  let depth = Number(args.depth || 0);
  let rootJobId = args.root_job_id || jobId;
  if (args.parent_job_id) {
    parentJob = await getJob(args.parent_job_id);
    if (!parentJob) return failResult(`Unknown parent_job_id=${args.parent_job_id}`);
    if (!parentJob.allow_subagent) return failResult("parent job does not allow subagent recursion");
    depth = parentJob.depth + 1;
    rootJobId = parentJob.root_job_id || parentJob.job_id;
    if (depth > (parentJob.max_depth ?? maxDepth)) {
      return failResult("max_depth exceeded", { depth, maxDepth: parentJob.max_depth ?? maxDepth });
    }
  }
  const activeCount = (await listJobs("active")).filter((job) => ["creating", "running", "done", "collecting"].includes(job.state)).length;
  if (activeCount >= maxConcurrent) {
    return failResult("max_concurrent exceeded", { activeCount, maxConcurrent });
  }

  let cascadeId = null;
  try {
    const started = await startCascade(mainId);
    cascadeId = started.cascadeId;
    const title = `[subagent] ${label}`.slice(0, 120);
    try {
      await renameCascade(mainId, cascadeId, title);
    } catch {}
    const images = await normalizeImages(args.images || []);
    const resolvedSelection = await sendMessageWithModelFallback({
      mainId,
      cascadeId,
      metadata: started.metadata,
      text: injectContext(prompt, {
      ...args,
      main_id: mainId,
      label,
      }),
      mode: MODE_MAP[mode] || mode,
      images,
      blocking: false,
      modelSelection,
    });
    const model = resolvedSelection.model_resolved;
    const job = {
      job_id: jobId,
      sub_cid: cascadeId,
      main_id: mainId,
      owner_conversation_id: args.owner_conversation_id || mainId,
      root_job_id: rootJobId,
      parent_job_id: args.parent_job_id || null,
      depth,
      state: "running",
      label,
      title_best_effort: title,
      mode,
      model,
      model_profile: resolvedSelection.model_profile || null,
      model_requested: resolvedSelection.model_requested || null,
      model_resolved: resolvedSelection.model_resolved || model,
      model_source: resolvedSelection.model_source || null,
      model_note: resolvedSelection.model_note || null,
      model_fallback_chain: resolvedSelection.model_fallback_chain || [],
      model_catalog_updated_at: resolvedSelection.catalog?.updated_at || null,
      model_send_fallback_from: resolvedSelection.model_send_fallback_from || null,
      model_send_error: resolvedSelection.model_send_error || null,
      collect_mode: collectMode,
      auto_collect: autoCollect,
      auto_collect_state: autoCollect ? "scheduled" : "disabled",
      allow_subagent: allowSubagent,
      max_depth: maxDepth,
      max_concurrent: maxConcurrent,
      collect_nonce: `collect_${jobId}`,
      turn: 1,
      collect_results: {},
      turn_results: {},
      created_at: nowIso(),
      updated_at: nowIso(),
      deadline_at: deadlineIso(timeoutSec),
      result_step_count: 0,
      ls_binding: {
        resolved_by_main_id: true,
        resolved_at: nowIso(),
      },
    };
    await upsertJob(job);
    if (job.auto_collect) {
      scheduleAutoCollect(job.job_id);
    }
    return textResult({
      ok: true,
      job_id: jobId,
      sub_cid: cascadeId,
      state: job.state,
      title_best_effort: title,
      auto_collect: job.auto_collect,
      model_requested: resolvedSelection.model_requested,
      model_profile: resolvedSelection.model_profile,
      model_resolved: resolvedSelection.model_resolved,
      model_source: resolvedSelection.model_source,
      model_note: resolvedSelection.model_note,
      model_fallback_chain: resolvedSelection.model_fallback_chain,
      model_catalog_updated_at: resolvedSelection.catalog?.updated_at || null,
      model_send_fallback_from: resolvedSelection.model_send_fallback_from || null,
      model_send_error: resolvedSelection.model_send_error || null,
    });
  } catch (error) {
    if (cascadeId) {
      try {
        await cancelCascade(mainId, cascadeId);
      } catch {}
      try {
        await deleteCascade(mainId, cascadeId);
      } catch {}
    }
    return failResult(error.message, { job_id: jobId, sub_cid: cascadeId });
  }
}

export async function subagentPoll(args) {
  const job = await getJob(args.job_id);
  if (!job) return failResult(`Unknown job_id=${args.job_id}`);
  const steps = await getCompleteSteps(job.main_id, job.sub_cid);
  const summary = steps.summary;
  const status = summary?.status || "missing";
  const done = String(status).includes("IDLE");
  const stepCount = summary?.stepCount || stepArray(steps).length || 0;
  const resultText = extractResultText(steps);
  const resultPreview = compactStepsPreview(steps, resultText);
  await updateJob(job.job_id, (current) => {
    if (done && ["creating", "running", "timeout"].includes(current.state)) {
      if (current.state === "timeout") {
        current.auto_collect_state = "late_done";
        current.late_completed_after_timeout = true;
        delete current.timeout_recheck_after;
      }
      current.state = "done";
    }
    current.result_step_count = stepCount;
    current.result_text = resultText;
    current.result_preview = resultPreview;
    current.turn_results = current.turn_results || {};
    current.turn_results[String(jobTurn(current))] = {
      turn: jobTurn(current),
      state: done ? "done" : current.state,
      status,
      step_count: stepCount,
      result_text: resultText,
      result_preview: resultPreview,
      updated_at: nowIso(),
    };
    if (done && !current.completed_at) current.completed_at = nowIso();
  });
  return textResult({
    ok: true,
    job_id: job.job_id,
    sub_cid: job.sub_cid,
    status,
    done,
    state: done && ["creating", "running", "timeout"].includes(job.state) ? "done" : job.state,
    step_count: stepCount,
    result_text: resultText,
    result_preview: resultPreview,
  });
}

export async function subagentWait(args) {
  const job = await getJob(args.job_id);
  if (!job) return failResult(`Unknown job_id=${args.job_id}`);
  const maxWaitMs = 45000;
  const waitMs = Math.max(0, Math.min(Number(args.wait_ms ?? 30000), maxWaitMs));
  const pollMs = Math.max(500, Math.min(Number(args.poll_ms ?? 2500), 10000));
  const deadline = Date.now() + waitMs;
  let latest = null;
  do {
    latest = parseTextResult(await subagentPoll({ job_id: job.job_id }));
    if (latest.done || ["done", "collected", "collect_failed", "timeout", "archived", "deleted"].includes(latest.state)) {
      if (args.collect === true && latest.done) {
        const collect = parseTextResult(await subagentCollect({
          job_id: job.job_id,
          mode: args.collect_mode || job.collect_mode || "interrupt",
          timeout_ms: Math.min(Number(args.collect_timeout_ms || 45000), maxWaitMs),
          confirm_timeout_ms: Math.min(Number(args.confirm_timeout_ms || 30000), maxWaitMs),
          fallback_to_queue: args.fallback_to_queue === true,
        }));
        return textResult({ ok: true, done: true, collected: collect.ok === true, collect, poll: latest });
      }
      return textResult({ ok: true, done: Boolean(latest.done), poll: latest });
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
  } while (Date.now() < deadline);
  return textResult({
    ok: true,
    done: false,
    still_running: true,
    wait_ms: waitMs,
    poll: latest,
    note: "subagent_wait uses short waits to avoid broker/MCP transport timeout; call again to continue waiting.",
  });
}

export async function subagentReply(args) {
  const job = await getJob(args.job_id);
  if (!job) return failResult(`Unknown job_id=${args.job_id}`);
  const message = String(args.message || "").trim();
  if (!message) return failResult("message is required");
  if (["archived", "deleted"].includes(job.state)) {
    return failResult(`cannot reply to ${job.state} job`);
  }
  const summary = await getSummary(job.main_id, job.sub_cid);
  const status = summary?.status || "missing";
  if (!summary) return failResult("subagent cascade missing from LS summaries");
  if (!String(status).includes("IDLE")) {
    return failResult("subagent is busy; poll until done before reply", { status });
  }

  const metadata = await createMetadata();
  const images = await normalizeImages(args.images || []);
  const mode = args.mode || job.mode || "code";
  const modelSelection = await resolveModelSelection({
    model: args.model || (args.model_profile ? null : job.model),
    model_profile: args.model_profile || job.model_profile,
  });
  const resolvedSelection = await sendMessageWithModelFallback({
    mainId: job.main_id,
    cascadeId: job.sub_cid,
    metadata,
    text: message,
    mode: MODE_MAP[mode] || mode,
    images,
    blocking: false,
    modelSelection,
  });
  const model = resolvedSelection.model_resolved || job.model;
  const nextTurn = jobTurn(job) + 1;
  await updateJob(job.job_id, (current) => {
    current.turn = nextTurn;
    current.state = "running";
    current.model = model;
    current.model_profile = resolvedSelection.model_profile || current.model_profile || null;
    current.model_requested = resolvedSelection.model_requested || null;
    current.model_resolved = resolvedSelection.model_resolved || model;
    current.model_source = resolvedSelection.model_source || null;
    current.model_note = resolvedSelection.model_note || null;
    current.model_fallback_chain = resolvedSelection.model_fallback_chain || [];
    current.model_catalog_updated_at = resolvedSelection.catalog?.updated_at || null;
    current.model_send_fallback_from = resolvedSelection.model_send_fallback_from || null;
    current.model_send_error = resolvedSelection.model_send_error || null;
    current.mode = mode;
    current.result_step_count = 0;
    current.result_text = "";
    current.result_preview = "";
    current.collect_nonce = `collect_${current.job_id}_turn_${nextTurn}`;
    current.last_reply_at = nowIso();
    current.last_error = undefined;
    current.replies = [
      ...(current.replies || []),
      {
        turn: nextTurn,
        created_at: current.last_reply_at,
        mode,
        model,
        model_profile: resolvedSelection.model_profile || null,
        model_requested: resolvedSelection.model_requested || null,
        model_resolved: resolvedSelection.model_resolved || model,
        model_source: resolvedSelection.model_source || null,
        model_note: resolvedSelection.model_note || null,
        model_fallback_chain: resolvedSelection.model_fallback_chain || [],
        model_catalog_updated_at: resolvedSelection.catalog?.updated_at || null,
        model_send_fallback_from: resolvedSelection.model_send_fallback_from || null,
        model_send_error: resolvedSelection.model_send_error || null,
        message_preview: message.length > 500 ? `${message.slice(0, 500)}...` : message,
        image_count: images.length,
      },
    ];
  });
  return textResult({
    ok: true,
    job_id: job.job_id,
    sub_cid: job.sub_cid,
    state: "running",
    turn: nextTurn,
    status,
    model_requested: resolvedSelection.model_requested,
    model_profile: resolvedSelection.model_profile,
    model_resolved: resolvedSelection.model_resolved,
    model_source: resolvedSelection.model_source,
    model_note: resolvedSelection.model_note,
    model_fallback_chain: resolvedSelection.model_fallback_chain,
    model_catalog_updated_at: resolvedSelection.catalog?.updated_at || null,
    model_send_fallback_from: resolvedSelection.model_send_fallback_from || null,
    model_send_error: resolvedSelection.model_send_error || null,
  });
}

export async function subagentList(args = {}) {
  const rawJobs = await listJobs(args.filter || "active");
  const includeDeleted = Boolean(args.include_deleted || args.detail === "full");
  const includeArchived = Boolean(args.include_archived || args.detail === "full");
  const limit = Number(args.limit ?? 50);
  const jobs = rawJobs
    .filter((job) => includeDeleted || job.state !== "deleted")
    .filter((job) => includeArchived || job.state !== "archived")
    .sort((left, right) => Date.parse(right.updated_at || right.created_at || 0) - Date.parse(left.updated_at || left.created_at || 0));
  const visibleJobs = Number.isFinite(limit) && limit > 0 ? jobs.slice(0, limit) : jobs;
  const counts = rawJobs.reduce((acc, job) => {
    acc[job.state] = (acc[job.state] || 0) + 1;
    return acc;
  }, {});
  return textResult({
    ok: true,
    filter: args.filter || "active",
    count: visibleJobs.length,
    total_matching_before_visibility_filter: rawJobs.length,
    hidden: {
      deleted: includeDeleted ? 0 : rawJobs.filter((job) => job.state === "deleted").length,
      archived: includeArchived ? 0 : rawJobs.filter((job) => job.state === "archived").length,
    },
    counts_by_state: counts,
    jobs: visibleJobs.map((job) => ({
      job_id: job.job_id,
      sub_cid: job.sub_cid,
      main_id: job.main_id,
      label: job.label,
      state: job.state,
      turn: jobTurn(job),
      depth: job.depth,
      parent_job_id: job.parent_job_id,
      created_at: job.created_at,
      updated_at: job.updated_at,
      title_best_effort: job.title_best_effort,
    })),
    note: includeDeleted || includeArchived
      ? "full visibility requested"
      : "deleted/archived jobs are hidden by default; pass include_deleted/include_archived or detail:'full' for history.",
  });
}

async function archiveJob(job) {
  const archiveDir = path.join(getDataDir(), "archive");
  await fs.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${job.job_id}.json`);
  let trajectory = null;
  let steps = null;
  try {
    trajectory = await getTrajectory(job.main_id, job.sub_cid);
    steps = await getCompleteSteps(job.main_id, job.sub_cid);
  } catch (error) {
    trajectory = { error: error.message };
  }
  await fs.writeFile(archivePath, JSON.stringify({ job, trajectory, steps, archived_at: nowIso() }, null, 2), "utf8");
  await writeAudit({
    category: "archive",
    ok: true,
    operation: "write_archive",
    job_id: job.job_id,
    main_id: job.main_id,
    sub_cid: job.sub_cid,
    archive_path: archivePath,
  });
  return archivePath;
}

async function waitUntilDeleted(mainId, cascadeId, timeoutMs = 30000) {
  const started = Date.now();
  let lastSummary = null;
  while (Date.now() - started < timeoutMs) {
    lastSummary = await getSummary(mainId, cascadeId);
    if (!lastSummary) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`DeleteCascadeTrajectory did not remove ${cascadeId}; last status=${lastSummary?.status || "unknown"}`);
}

async function recordInjection(mainId) {
  const counterPath = path.join(getDataDir(), "injection-count.json");
  let counters = {};
  try {
    counters = JSON.parse(await fs.readFile(counterPath, "utf8"));
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const key = `${today}:${mainId}`;
  counters[key] = (counters[key] || 0) + 1;
  await fs.writeFile(counterPath, JSON.stringify(counters, null, 2), "utf8");
  const max = Number(process.env.SUBAGENT_MAX_DAILY_INJECTIONS || 100);
  if (counters[key] > max) {
    throw new Error(`self-driven injection limit exceeded for ${mainId}: ${counters[key]}/${max}`);
  }
}

async function relatedJobs(root) {
  const jobs = await listJobs("all");
  if (!root) return [];
  const result = [root];
  const queue = [root.job_id];
  while (queue.length) {
    const parentId = queue.shift();
    for (const job of jobs) {
      if (job.parent_job_id === parentId && !result.some((item) => item.job_id === job.job_id)) {
        result.push(job);
        queue.push(job.job_id);
      }
    }
  }
  return result;
}

export async function subagentDispose(args) {
  const job = await getJob(args.job_id);
  if (!job) return failResult(`Unknown job_id=${args.job_id}`);
  const mode = args.mode || "archive";
  if (!["archive", "delete"].includes(mode)) {
    return failResult("mode must be archive or delete");
  }
  const targets = args.cascade_tree ? await relatedJobs(job) : [job];
  const processed = [];
  for (const target of targets.sort((left, right) => right.depth - left.depth)) {
    const archivePath = await archiveJob(target);
    if (mode === "delete") {
      try {
        await cancelCascade(target.main_id, target.sub_cid);
      } catch {}
      await deleteCascade(target.main_id, target.sub_cid);
      await waitUntilDeleted(target.main_id, target.sub_cid);
    }
    await updateJob(target.job_id, (current, registry) => {
      current.state = mode === "delete" ? "deleted" : "archived";
      current.archive_path = archivePath;
      current.archived_at = nowIso();
      registry.archives[target.job_id] = {
        job_id: target.job_id,
        archive_path: archivePath,
        archived_at: current.archived_at,
        delete_after_archive: mode === "delete",
      };
    });
    processed.push({ job_id: target.job_id, cid: target.sub_cid, action: mode, archive_path: archivePath });
  }
  return textResult({
    ok: true,
    processed,
    refused: [],
  });
}

async function exportArchiveCopies(archiveRefs) {
  if (!archiveRefs.length) return null;
  const exportDir = path.join(getDataDir(), "archive-exports");
  await fs.mkdir(exportDir, { recursive: true });
  const exportPath = path.join(exportDir, `archive-retention-${Date.now()}.json`);
  const exported = [];
  for (const archiveRef of archiveRefs) {
    let archive = null;
    try {
      archive = JSON.parse(await fs.readFile(archiveRef.archive_path, "utf8"));
    } catch (error) {
      archive = { error: error.message };
    }
    exported.push({
      archive_ref: archiveRef,
      archive,
    });
  }
  await fs.writeFile(exportPath, JSON.stringify({
    exported_at: nowIso(),
    reason: "retention hard-delete backup",
    archives: exported,
  }, null, 2), "utf8");
  await writeAudit({
    category: "archive_retention",
    ok: true,
    operation: "export_before_hard_delete",
    export_path: exportPath,
    count: archiveRefs.length,
  });
  return exportPath;
}

async function cleanupOldJobs(args = {}) {
  const ttlSec = Number(args.idle_ttl_sec ?? process.env.SUBAGENT_IDLE_TTL_SEC ?? 86400);
  const ttlMs = ttlSec * 1000;
  const dryRun = args.dry_run !== undefined ? Boolean(args.dry_run) : false;
  const maxArchivePerRun = Number(args.max_archive_per_run ?? process.env.SUBAGENT_CLEANUP_MAX_ARCHIVE_PER_RUN ?? 20);
  const retainArchives = args.retain_archives === undefined
    ? Number(process.env.SUBAGENT_RETAIN_ARCHIVES || 200)
    : Number(args.retain_archives);
  const hardDeleteArchives = Boolean(args.hard_delete_archives);
  const registry = await readRegistry();
  const candidates = Object.values(registry.jobs)
    .filter((job) => ["done", "timeout"].includes(job.state))
    .filter((job) => isOlderThan(cleanupAgeAnchor(job), ttlMs))
    .sort((left, right) => Date.parse(cleanupAgeAnchor(left) || 0) - Date.parse(cleanupAgeAnchor(right) || 0))
    .slice(0, maxArchivePerRun);

  const archived = [];
  const skipped = [];
  for (const job of candidates) {
    const reason = `${job.state} idle over ${ttlSec}s`;
    if (dryRun) {
      archived.push({ job_id: job.job_id, dry_run: true, action: "archive", reason });
      continue;
    }
    try {
      const archivePath = await archiveJob(job);
      await updateJob(job.job_id, (current, currentRegistry) => {
        if (!["done", "timeout"].includes(current.state) || !isOlderThan(cleanupAgeAnchor(current), ttlMs)) {
          skipped.push({ job_id: current.job_id, reason: "state or TTL changed before archive" });
          return;
        }
        current.state = "archived";
        current.archive_path = archivePath;
        current.archived_at = nowIso();
        current.cleanup_reason = reason;
        currentRegistry.archives[current.job_id] = {
          job_id: current.job_id,
          archive_path: archivePath,
          archived_at: current.archived_at,
          delete_after_archive: false,
        };
      });
      archived.push({ job_id: job.job_id, action: "archive", archive_path: archivePath, reason });
    } catch (error) {
      skipped.push({ job_id: job.job_id, reason: error.message });
    }
  }

  const retention = {
    retain_archives: retainArchives,
    hard_delete_archives: hardDeleteArchives,
    prunable: [],
    deleted: [],
    export_path: null,
  };
  if (Number.isFinite(retainArchives) && retainArchives >= 0) {
    const latestRegistry = await readRegistry();
    const activeArchiveRefs = Object.values(latestRegistry.archives || {})
      .filter((archiveRef) => !archiveRef.file_deleted_at)
      .sort((left, right) => Date.parse(right.archived_at || 0) - Date.parse(left.archived_at || 0));
    const oldArchiveRefs = activeArchiveRefs.slice(retainArchives);
    retention.prunable = oldArchiveRefs.map((archiveRef) => ({
      job_id: archiveRef.job_id,
      archive_path: archiveRef.archive_path,
      archived_at: archiveRef.archived_at,
    }));
    if (!dryRun && hardDeleteArchives && oldArchiveRefs.length) {
      const exportPath = await exportArchiveCopies(oldArchiveRefs);
      retention.export_path = exportPath;
      for (const archiveRef of oldArchiveRefs) {
        if (await fileExists(archiveRef.archive_path)) {
          await fs.rm(archiveRef.archive_path, { force: true });
        }
        await writeAudit({
          category: "archive_retention",
          ok: true,
          operation: "delete_archive_file",
          job_id: archiveRef.job_id,
          archive_path: archiveRef.archive_path,
          export_path: exportPath,
        });
        await mutateRegistry("cleanupRetention", async (currentRegistry) => {
          const currentArchive = currentRegistry.archives?.[archiveRef.job_id];
          if (currentArchive) {
            currentArchive.pruned_at = nowIso();
            currentArchive.file_deleted_at = nowIso();
            currentArchive.export_path = exportPath;
          }
          const currentJob = currentRegistry.jobs?.[archiveRef.job_id];
          if (currentJob) {
            currentJob.archive_export_path = exportPath;
            currentJob.archive_file_deleted_at = nowIso();
          }
        });
        retention.deleted.push({ job_id: archiveRef.job_id, archive_path: archiveRef.archive_path, export_path: exportPath });
      }
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    idle_ttl_sec: ttlSec,
    archived,
    skipped,
    retention,
  };
}

export async function subagentCleanup(args = {}) {
  return textResult(await cleanupOldJobs(args));
}

export function startCleanupScheduler() {
  const intervalSec = Number(process.env.SUBAGENT_CLEANUP_INTERVAL_SEC ?? 3600);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return null;
  const timer = setInterval(async () => {
    try {
      const result = await cleanupOldJobs({});
      if (result.archived.length || result.retention.deleted.length) {
        console.error(`[wsf-subagent cleanup] archived=${result.archived.length} deleted_archives=${result.retention.deleted.length}`);
      }
    } catch (error) {
      console.error(`[wsf-subagent cleanup] ${error.message}`);
    }
  }, intervalSec * 1000);
  timer.unref?.();
  return timer;
}

function parseTextResult(result) {
  return JSON.parse(result.content?.[0]?.text || "{}");
}

function isCollectTerminal(job) {
  return !job || ["collected", "archived", "deleted", "missing", "stale_queue", "collect_failed"].includes(job.state) || Boolean(collectResultForTurn(job));
}

function collectKey(job) {
  if (!job) return null;
  return `${job.job_id}:turn:${jobTurn(job)}`;
}

function collectLockIsFresh(job) {
  const ttlMs = Number(process.env.SUBAGENT_COLLECT_LOCK_TTL_MS || 900000);
  const startedAt = job?.collecting_started_at || job?.updated_at;
  const started = Date.parse(startedAt || "");
  return Number.isFinite(started) && Date.now() - started <= ttlMs;
}

function isCollectBusy(job) {
  if (!job) return false;
  if (collectRuns.has(collectKey(job))) return true;
  if (job.state === "collecting" || job.auto_collect_state === "collecting") {
    return collectLockIsFresh(job);
  }
  return false;
}

function timeoutRecheckDue(job) {
  if (job?.state !== "timeout") return true;
  const recheckAt = Date.parse(job.timeout_recheck_after || "");
  return !Number.isFinite(recheckAt) || Date.now() >= recheckAt;
}

function nextTimeoutRecheck(job) {
  const count = Number(job?.timeout_recheck_count || 0);
  const baseMs = Number(process.env.SUBAGENT_TIMEOUT_RECHECK_BASE_MS || 30000);
  const maxMs = Number(process.env.SUBAGENT_TIMEOUT_RECHECK_MAX_MS || 300000);
  const delayMs = Math.min(maxMs, baseMs * (2 ** Math.min(count, 3)));
  return new Date(Date.now() + delayMs).toISOString();
}

function shouldScheduleAutoCollect(job) {
  return Boolean(
    job?.auto_collect === true
    && !isCollectTerminal(job)
    && !isCollectBusy(job)
    && timeoutRecheckDue(job),
  );
}

function scheduleAutoCollect(jobId, delayMs = 1000) {
  if (autoCollectTimers.has(jobId) || autoCollectRuns.has(jobId)) return;
  const timer = setTimeout(async () => {
    autoCollectTimers.delete(jobId);
    if (autoCollectRuns.has(jobId)) return;
    autoCollectRuns.add(jobId);
    try {
      await runAutoCollect(jobId);
    } catch (error) {
      console.error(`[wsf-subagent auto-collect] job=${jobId} ${error.message}`);
      try {
        await updateJob(jobId, (current) => {
          current.auto_collect_state = "failed";
          current.last_error = error.message;
          current.updated_at = nowIso();
        });
      } catch {}
    } finally {
      autoCollectRuns.delete(jobId);
    }
  }, delayMs);
  timer.unref?.();
  autoCollectTimers.set(jobId, timer);
}

async function runAutoCollect(jobId) {
  const intervalMs = Number(process.env.SUBAGENT_AUTO_COLLECT_POLL_MS || 2500);
  const maxRunMs = Number(process.env.SUBAGENT_AUTO_COLLECT_MAX_MS || 600000);
  const started = Date.now();
  while (Date.now() - started < maxRunMs) {
    const job = await getJob(jobId);
    if (!job || !shouldScheduleAutoCollect(job)) return;
    await updateJob(jobId, (current) => {
      current.auto_collect_state = current.state === "timeout" ? "timeout_rechecking" : "polling";
      current.updated_at = nowIso();
    });
    const poll = parseTextResult(await subagentPoll({ job_id: jobId }));
    const refreshed = await getJob(jobId);
    if (isCollectTerminal(refreshed)) return;
    if (poll.done || refreshed?.state === "done") {
      await updateJob(jobId, (current) => {
        if (isCollectTerminal(current) || current.state === "collecting") return;
        current.auto_collect_state = "collecting";
        current.updated_at = nowIso();
      });
      const collect = parseTextResult(await subagentCollect({
        job_id: jobId,
        mode: refreshed.collect_mode || "interrupt",
        timeout_ms: Number(process.env.SUBAGENT_AUTO_COLLECT_TIMEOUT_MS || 180000),
        confirm_timeout_ms: Number(process.env.SUBAGENT_AUTO_COLLECT_CONFIRM_TIMEOUT_MS || 90000),
        fallback_to_queue: true,
      }));
      await updateJob(jobId, (current) => {
        current.auto_collect_state = collect.ok ? "collected" : "failed";
        current.auto_collect_result = collect;
        current.updated_at = nowIso();
      });
      return;
    }
    if (refreshed?.deadline_at && Date.parse(refreshed.deadline_at) < Date.now() && ["creating", "running", "timeout"].includes(refreshed.state)) {
      let timeoutNoticeResult = refreshed.timeout_notice_result || null;
      if (!timeoutNoticeResult?.delivered) {
        try {
          timeoutNoticeResult = await sendTimeoutNotice(refreshed, poll);
        } catch (error) {
          timeoutNoticeResult = { delivered: false, error: error.message, attempted_at: nowIso() };
        }
      }
      await updateJob(jobId, (current) => {
        current.state = "timeout";
        current.auto_collect_state = "timeout";
        current.timed_out_at = current.timed_out_at || nowIso();
        current.timeout_recheck_count = (current.timeout_recheck_count || 0) + 1;
        current.timeout_recheck_after = nextTimeoutRecheck(current);
        current.timeout_notice_result = timeoutNoticeResult;
        current.updated_at = nowIso();
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await updateJob(jobId, (current) => {
    current.auto_collect_state = "watcher_timeout";
    current.updated_at = nowIso();
  });
}

export function startAutoCollectScheduler() {
  const intervalSec = Number(process.env.SUBAGENT_AUTO_COLLECT_SCAN_SEC ?? 5);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return null;
  const scan = async () => {
    try {
      const jobs = await listJobs("active");
      for (const job of jobs) {
        if (shouldScheduleAutoCollect(job) && !autoCollectTimers.has(job.job_id) && !autoCollectRuns.has(job.job_id)) {
          scheduleAutoCollect(job.job_id);
        }
      }
    } catch (error) {
      console.error(`[wsf-subagent auto-collect scan] ${error.message}`);
    }
  };
  scan();
  const timer = setInterval(scan, intervalSec * 1000);
  timer.unref?.();
  return timer;
}

function renderCollectMessage(job) {
  return [
    `[subagent:${job.job_id}:turn:${jobTurn(job)}] ${job.label}`,
    `sub_cid=${job.sub_cid}`,
    `state=${job.state}`,
    `turn=${jobTurn(job)}`,
    "",
    job.result_text || job.result_preview || "No result text captured yet. Use subagent_poll before collect for richer output.",
  ].join("\n");
}

function renderTimeoutMessage(job, poll = {}) {
  return [
    `[subagent-timeout:${job.job_id}:turn:${jobTurn(job)}] ${job.label}`,
    `sub_cid=${job.sub_cid}`,
    `state=timeout`,
    `turn=${jobTurn(job)}`,
    `deadline_at=${job.deadline_at || ""}`,
    "",
    "子代理已超过 timeout_sec，MCP 会继续低频复查；如果它之后完成，会再次自动回插最终结果。",
    poll.result_preview || job.result_preview ? "" : "当前尚未捕获可用最终产出。",
    poll.result_preview || job.result_preview || "",
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

async function sendTimeoutNotice(job, poll = {}) {
  const marker = `[subagent-timeout:${job.job_id}:turn:${jobTurn(job)}]`;
  const metadata = await createMetadata();
  await recordInjection(job.main_id);
  const message = renderTimeoutMessage(job, poll);
  const mainCascadeConfig = await createMainCascadeConfig(job.main_id, job.model);
  const snapshot = await readMainSnapshot(job.main_id);
  if (!isMainRunning(snapshot.summary)) {
    await sendMessage(job.main_id, job.main_id, metadata, message, {
      cascadeConfig: mainCascadeConfig,
      blocking: false,
    });
    const confirmed = await waitForTextInSteps(job.main_id, marker, 30000);
    return {
      delivered: confirmed,
      when: "timeout_idle_sent",
      delivered_by: "send_user_message_idle",
      marker,
      sent_at: nowIso(),
    };
  }
  const queued = await queueMessage(job.main_id, job.main_id, metadata, message, {
    cascadeConfig: mainCascadeConfig,
  });
  return {
    delivered: Boolean(queued.queueId),
    when: "timeout_queued",
    delivered_by: "queue_timeout_notice",
    queue_id: queued.queueId || null,
    marker,
    sent_at: nowIso(),
  };
}

async function flushQueuedCollectIfIdle(job, existingCollect, targetMainId) {
  if (
    existingCollect?.when !== "queued"
    || !job.queue?.queue_id
    || !["queued", "unknown", "remove_failed"].includes(job.queue.state)
  ) {
    return null;
  }
  const turn = job.queue.turn || jobTurn(job);
  const marker = `[subagent:${job.job_id}:turn:${turn}]`;
  const steps = await getCompleteSteps(targetMainId, targetMainId);
  if (stepsIncludeText(steps, marker)) {
    const collectResult = {
      ...existingCollect,
      delivered: true,
      when: "queued_consumed",
      delivered_by: "queue_auto_consumed",
      turn,
    };
    await updateJob(job.job_id, (current) => {
      current.state = "collected";
      if (current.auto_collect === true) current.auto_collect_state = "collected";
      current.collect_results = current.collect_results || {};
      current.collect_results[String(turn)] = collectResult;
      current.collect_result = collectResult;
      current.auto_collect_result = { ok: true, ...collectResult };
      if (current.queue?.queue_id === job.queue.queue_id) {
        current.queue.state = "consumed";
        current.queue.updated_at = nowIso();
      }
      delete current.last_error;
    });
    return collectResult;
  }
  const summary = await getSummary(targetMainId, targetMainId);
  if (isMainRunning(summary)) return null;

  const metadata = await createMetadata();
  let removed = { removed: false };
  try {
    removed = await removeFromQueue(targetMainId, job.queue.main_id, metadata, job.queue.queue_id);
  } catch (error) {
    const latestSteps = await getCompleteSteps(targetMainId, targetMainId);
    if (stepsIncludeText(latestSteps, marker)) {
      return await flushQueuedCollectIfIdle(job, existingCollect, targetMainId);
    }
    removed = { removed: false, error: error.message };
  }
  const mainCascadeConfig = await createMainCascadeConfig(targetMainId, job.model);
  await sendMessage(targetMainId, targetMainId, metadata, renderCollectMessage(job), {
    cascadeConfig: mainCascadeConfig,
    blocking: false,
  });
  const confirmed = await waitForTextInSteps(targetMainId, marker, 30000);
  if (!confirmed) return null;
  const collectResult = {
    ...existingCollect,
    delivered: true,
    when: "idle_sent_after_stale_queue",
    mode_used: "queue_flush",
    queue_id: job.queue.queue_id,
    turn,
    fallback_from: existingCollect.fallback_from || "queued",
    boundary_reason: "main_idle_with_stale_queue",
    confirmed: true,
    delivered_by: "send_user_message_after_stale_queue",
  };
  await updateJob(job.job_id, (current) => {
    current.state = "collected";
    if (current.auto_collect === true) current.auto_collect_state = "collected";
    current.collect_results = current.collect_results || {};
    current.collect_results[String(turn)] = collectResult;
    current.collect_result = collectResult;
    if (current.queue?.queue_id === job.queue.queue_id) {
      current.queue.state = removed.removed ? "removed_after_collected" : "unknown";
      current.queue.updated_at = nowIso();
      current.queue.remove_attempts = (current.queue.remove_attempts || 0) + 1;
      if (removed.error) current.queue.last_error = removed.error;
    }
    current.auto_collect_result = { ok: true, ...collectResult };
    delete current.last_error;
  });
  return collectResult;
}

async function ensureCollectedResultMirror(job, collectResult) {
  if (!job?.job_id || !collectResult?.delivered) return;
  const turn = collectResult.turn || jobTurn(job);
  const shouldRepair =
    job.state !== "collected"
    || (job.auto_collect === true && (
      job.auto_collect_state !== "collected"
      || job.auto_collect_result?.ok !== true
    ));
  if (!shouldRepair) return;
  await updateJob(job.job_id, (current) => {
    current.state = "collected";
    if (current.auto_collect === true) {
      current.auto_collect_state = "collected";
      current.auto_collect_result = { ok: true, ...collectResult };
    }
    current.collect_results = current.collect_results || {};
    current.collect_results[String(turn)] = collectResult;
    current.collect_result = collectResult;
    delete current.last_error;
  });
}

function stepStatus(step) {
  return String(step?.status || step?.step?.status || step?.state || "").toUpperCase();
}

function stepArrayFromBody(body) {
  return body?.steps || body?.trajectorySteps || body?.cascadeSteps || [];
}

async function getCompleteSteps(mainId, cascadeId) {
  const summary = await getSummary(mainId, cascadeId);
  const total = Number(summary?.stepCount || 0);
  const offsets = new Set([0]);
  const stride = 50;
  const maxOffset = Math.max(total + 80, 120);
  for (let offset = stride; offset <= maxOffset; offset += stride) {
    offsets.add(offset);
  }
  if (total > 0) {
    for (const near of [total - 80, total - 50, total - 30, total - 20, total - 10, total]) {
      if (near > 0) offsets.add(near);
    }
  }
  const merged = [];
  const seen = new Set();
  let lastBody = null;
  for (const offset of [...offsets].filter((value) => value >= 0).sort((left, right) => left - right)) {
    const body = await getSteps(mainId, cascadeId, offset);
    lastBody = body;
    for (const step of stepArrayFromBody(body)) {
      const metadata = stepMetadata(step);
      const stableKey = [
        metadata.stepId || metadata.id || metadata.createdAt || "",
        metadata.executionId || "",
        stepType(step),
        stepStatus(step),
      ].join("|");
      const dedupeKey = stableKey.replace(/\|/g, "").trim()
        ? stableKey
        : JSON.stringify(step).slice(0, 1000);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(step);
    }
  }
  return {
    ...(lastBody || {}),
    steps: merged,
    trajectorySteps: merged,
    cascadeSteps: merged,
    summary,
  };
}

function isStepActive(step) {
  return /GENERATING|RUNNING|PENDING|IN_PROGRESS/.test(stepStatus(step));
}

function isStepDone(step) {
  return /DONE|COMPLETE|FINISH/.test(stepStatus(step));
}

function stepMetadata(step) {
  return step?.metadata || step?.step?.metadata || {};
}

function stepType(step) {
  return String(step?.type || step?.step?.type || step?.kind || "");
}

function stepIdentity(step, index) {
  const metadata = stepMetadata(step);
  const stableId = metadata.stepId || metadata.id || metadata.createdAt;
  if (stableId) return [stepType(step), stableId].join("|");
  return [index, stepType(step)].join("|");
}

function stepDescriptor(step, index) {
  if (!step) return null;
  const metadata = stepMetadata(step);
  return {
    index,
    type: stepType(step),
    status: stepStatus(step),
    created_at: metadata.createdAt || null,
    key: stepIdentity(step, index),
  };
}

function latestActiveStep(steps) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (isStepActive(steps[index])) {
      return stepDescriptor(steps[index], index);
    }
  }
  return null;
}

function latestUserStepConfig(steps) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type !== "CORTEX_STEP_TYPE_USER_INPUT" && !step?.userInput) continue;
    const metadata = stepMetadata(step);
    return {
      model: metadata.requestedModelUid || null,
      mode: metadata.plannerMode || null,
    };
  }
  return {};
}

async function createMainCascadeConfig(mainId, fallbackModel) {
  const summary = await getSummary(mainId, mainId);
  const stepsBody = await getCompleteSteps(mainId, mainId);
  const latestUserConfig = latestUserStepConfig(stepArrayFromBody(stepsBody));
  return createCascadeConfig({
    model: latestUserConfig.model || summary?.lastGeneratorModelUid || fallbackModel,
    mode: latestUserConfig.mode || MODE_MAP.code,
  });
}

function findWatchedStep(steps, watchedStep) {
  if (!watchedStep) return null;
  return steps
    .map((step, index) => ({ step, index }))
    .find(({ step, index }) => stepIdentity(step, index) === watchedStep.key) || null;
}

function isMainRunning(summary) {
  return String(summary?.status || "").includes("RUNNING");
}

async function readMainSnapshot(mainId) {
  const summary = await getSummary(mainId, mainId);
  const stepsBody = await getCompleteSteps(mainId, mainId);
  const steps = stepArrayFromBody(stepsBody);
  return {
    summary,
    stepsBody,
    steps,
    active_step: latestActiveStep(steps),
  };
}

async function waitForActiveStepAnchor(mainId, timeoutMs = 30000) {
  const started = Date.now();
  let lastSnapshot = null;
  while (Date.now() - started < timeoutMs) {
    lastSnapshot = await readMainSnapshot(mainId);
    if (!isMainRunning(lastSnapshot.summary)) {
      return { hit: false, reason: "main_not_running", ...lastSnapshot };
    }
    if (lastSnapshot.active_step) {
      return { hit: true, reason: "active_step_found", watched_step: lastSnapshot.active_step, ...lastSnapshot };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { hit: false, reason: "active_step_timeout", ...lastSnapshot };
}

async function waitForWatchedStepBoundary(mainId, watchedStep, marker, timeoutMs = 30000) {
  if (!watchedStep) {
    throw new Error("watchdog invariant violated: watchedStep is required for interrupt mode");
  }
  const started = Date.now();
  let lastSnapshot = null;
  while (Date.now() - started < timeoutMs) {
    lastSnapshot = await readMainSnapshot(mainId);
    const watched = findWatchedStep(lastSnapshot.steps, watchedStep);
    if (watched && isStepDone(watched.step)) {
      return {
        hit: true,
        reason: "watched_step_done",
        watched_step: stepDescriptor(watched.step, watched.index),
        ...lastSnapshot,
      };
    }
    if (stepsIncludeText(lastSnapshot.stepsBody, marker)) {
      return {
        hit: true,
        reason: "queue_auto_consumed",
        watched_step: watchedStep,
        ...lastSnapshot,
      };
    }
    if (!watched && !isMainRunning(lastSnapshot.summary)) {
      return {
        hit: true,
        reason: "main_idle_after_watched_step",
        watched_step: watchedStep,
        ...lastSnapshot,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { hit: false, reason: "timeout", watched_step: watchedStep, ...lastSnapshot };
}

async function sendCollectAfterBoundary(mainId, metadata, queueId, collectMessage, marker, options = {}) {
  try {
    await removeFromQueue(mainId, mainId, metadata, queueId);
  } catch (error) {
    if (stepsIncludeText(await getCompleteSteps(mainId, mainId), marker)) {
      return { delivered_by: "queue_auto_consumed" };
    }
    throw error;
  }
  await sendMessage(mainId, mainId, metadata, collectMessage, {
    cascadeConfig: options.cascadeConfig,
    blocking: false,
  });
  return { delivered_by: "send_user_message_after_boundary" };
}

async function interruptAtWatchedBoundary(mainId, metadata, queueId, watchedStep, marker, collectMessage, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastBoundary = null;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const boundary = await waitForWatchedStepBoundary(mainId, watchedStep, marker, Math.min(10000, remainingMs));
    lastBoundary = boundary;
    if (!boundary.hit) {
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      if (lastError) throw lastError;
      throw new Error(`step boundary timeout before interrupt; watched=${JSON.stringify(watchedStep)}`);
    }
    if (stepsIncludeText(boundary.stepsBody, marker)) {
      return { interrupted: null, boundary, delivered_by: "queue_auto_consumed" };
    }
    if (!isMainRunning(boundary.summary)) {
      const sent = await sendCollectAfterBoundary(mainId, metadata, queueId, collectMessage, marker, {
        cascadeConfig: options.cascadeConfig,
      });
      return { interrupted: null, boundary, delivered_by: sent.delivered_by };
    }
    try {
      const interrupted = await interruptWithQueuedMessage(mainId, mainId, metadata, queueId);
      return { interrupted, boundary, delivered_by: "interrupt_with_queued_message" };
    } catch (error) {
      lastError = error;
      const snapshot = await readMainSnapshot(mainId);
      if (stepsIncludeText(snapshot.stepsBody, marker)) {
        return { interrupted: null, boundary, delivered_by: "queue_auto_consumed" };
      }
      if (!isMainRunning(snapshot.summary)) {
        error.message = `${error.message}; boundary=${JSON.stringify(boundary)}; summary_status=${snapshot.summary?.status || "unknown"}`;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (lastError) throw lastError;
  throw new Error(`step boundary timeout before interrupt; lastBoundary=${JSON.stringify(lastBoundary)}`);
}

async function waitForTextInSteps(mainId, text, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const steps = await getCompleteSteps(mainId, mainId);
    if (JSON.stringify(steps).includes(text)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function stepsIncludeText(stepsBody, text) {
  return JSON.stringify(stepsBody || "").includes(text);
}

export async function subagentCollect(args) {
  const job = await getJob(args.job_id);
  if (!job) return failResult(`Unknown job_id=${args.job_id}`);
  const targetMainId = args.main_id || job.main_id;
  if (targetMainId !== job.main_id) {
    return failResult("main_id does not match registered job main_id");
  }
  const existingCollect = collectResultForTurn(job);
  if (existingCollect) {
    const flushedCollect = await flushQueuedCollectIfIdle(job, existingCollect, targetMainId);
    if (flushedCollect) {
      return textResult({ ok: true, idempotent: true, flushed: true, ...flushedCollect });
    }
    await ensureCollectedResultMirror(job, existingCollect);
    return textResult({ ok: true, idempotent: true, ...existingCollect });
  }

  if (!job.result_preview) {
    await subagentPoll({ job_id: job.job_id });
  }
  let refreshed = await getJob(job.job_id);
  const currentTurn = jobTurn(refreshed);
  const lockKey = collectKey(refreshed);
  if (collectRuns.has(lockKey)) {
    return textResult({
      ok: true,
      in_progress: true,
      job_id: refreshed.job_id,
      turn: currentTurn,
      queue_id: refreshed.queue?.queue_id || null,
      note: "collect already running for this job turn; refusing to queue duplicate message",
    });
  }
  collectRuns.add(lockKey);
  let claim = { status: "claimed" };
  try {
    await updateJob(refreshed.job_id, (current) => {
      const currentResult = collectResultForTurn(current);
      if (currentResult) {
        claim = { status: "collected", result: currentResult };
        return;
      }
      const staleLock = !collectLockIsFresh(current);
      if (current.state === "collecting" && jobTurn(current) === currentTurn && !staleLock) {
        claim = { status: "in_progress", queue: current.queue || null };
        return;
      }
      current.state = "collecting";
      current.collecting_turn = currentTurn;
      current.collecting_started_at = nowIso();
      current.collect_attempts = (current.collect_attempts || 0) + 1;
      if (current.auto_collect === true) current.auto_collect_state = "collecting";
    });
  } catch (error) {
    collectRuns.delete(lockKey);
    throw error;
  }
  if (claim.status === "collected") {
    collectRuns.delete(lockKey);
    const latestJob = await getJob(refreshed.job_id);
    const flushedCollect = await flushQueuedCollectIfIdle(latestJob || refreshed, claim.result, targetMainId);
    if (flushedCollect) {
      return textResult({ ok: true, idempotent: true, flushed: true, ...flushedCollect });
    }
    await ensureCollectedResultMirror(latestJob || refreshed, claim.result);
    return textResult({ ok: true, idempotent: true, ...claim.result });
  }
  if (claim.status === "in_progress") {
    collectRuns.delete(lockKey);
    return textResult({
      ok: true,
      in_progress: true,
      job_id: refreshed.job_id,
      turn: currentTurn,
      queue_id: claim.queue?.queue_id || null,
      note: "collect already claimed in registry; refusing to queue duplicate message",
    });
  }
  refreshed = await getJob(job.job_id);
  const mode = args.mode || refreshed.collect_mode || "interrupt";
  let metadata = null;
  let queueId = null;
  let watchedStep = null;
  let boundaryInfo = null;
  let anchorInfo = null;
  let deliveredBy = null;
  try {
    metadata = await createMetadata();
    await recordInjection(targetMainId);
    const collectMessage = renderCollectMessage(refreshed);
    const marker = `[subagent:${refreshed.job_id}:turn:${jobTurn(refreshed)}]`;
    const mainCascadeConfig = await createMainCascadeConfig(targetMainId, refreshed.model);
    if (mode === "interrupt") {
      const anchor = await waitForActiveStepAnchor(targetMainId, Math.min(Number(args.timeout_ms || 180000), 30000));
      anchorInfo = anchor;
      if (anchor.hit) {
        watchedStep = anchor.watched_step;
      } else if (anchor.reason === "main_not_running") {
        await sendMessage(targetMainId, targetMainId, metadata, collectMessage, {
          cascadeConfig: mainCascadeConfig,
          blocking: false,
        });
        const confirmed = await waitForTextInSteps(targetMainId, marker, Number(args.confirm_timeout_ms || 90000));
        if (!confirmed) {
          throw new Error("collect signal confirmation failed after idle send: marker not found in main steps");
        }
        const collectResult = {
          delivered: true,
          when: "idle_sent",
          mode_used: mode,
          turn: jobTurn(refreshed),
          boundary_reason: anchor.reason,
          watched_step: null,
          completed_step: null,
          delivered_by: "send_user_message_idle",
        };
        await updateJob(refreshed.job_id, (current) => {
          current.state = "collected";
          if (current.auto_collect === true) current.auto_collect_state = "collected";
          delete current.collecting_turn;
          delete current.collecting_started_at;
          current.collect_results = current.collect_results || {};
          current.collect_results[String(jobTurn(current))] = collectResult;
          current.collect_result = collectResult;
        });
        collectRuns.delete(lockKey);
        return textResult({ ok: true, ...collectResult });
      } else if (args.fallback_to_queue === true) {
        watchedStep = null;
      } else {
        throw new Error(`active step anchor failed before queue: ${anchor.reason}`);
      }
    }
    const activeQueue = refreshed.queue
      && refreshed.queue.main_id === targetMainId
      && refreshed.queue.turn === jobTurn(refreshed)
      && ["queued", "unknown", "remove_failed"].includes(refreshed.queue.state)
      ? refreshed.queue
      : null;
    if (activeQueue?.queue_id) {
      queueId = activeQueue.queue_id;
    } else {
      const queued = await queueMessage(targetMainId, targetMainId, metadata, collectMessage, {
        cascadeConfig: mainCascadeConfig,
      });
      queueId = queued.queueId;
      if (!queueId) throw new Error(`QueueCascadeMessage returned no queueId: ${JSON.stringify(queued)}`);
      await updateJob(refreshed.job_id, (current) => {
        current.state = "collecting";
        const queueRecord = {
          queue_id: queueId,
          main_id: targetMainId,
          state: "queued",
          turn: jobTurn(current),
          collect_nonce: current.collect_nonce || null,
          attempt: current.collect_attempts || 1,
          created_at: nowIso(),
          updated_at: nowIso(),
          remove_attempts: 0,
        };
        current.queue = queueRecord;
        current.queue_history = [...(current.queue_history || []), queueRecord].slice(-20);
      });
    }

    if (mode === "queue") {
      const collectResult = { delivered: true, when: "queued", mode_used: "queue", queue_id: queueId, turn: jobTurn(refreshed) };
      await updateJob(refreshed.job_id, (current) => {
        current.state = "collected";
        if (current.auto_collect === true) current.auto_collect_state = "collected";
        delete current.collecting_turn;
        delete current.collecting_started_at;
        current.collect_results = current.collect_results || {};
        current.collect_results[String(jobTurn(current))] = collectResult;
        current.collect_result = collectResult;
      });
      collectRuns.delete(lockKey);
      return textResult({ ok: true, ...collectResult });
    }

    if (mode === "interrupt" && !watchedStep && args.fallback_to_queue === true) {
      const collectResult = {
        delivered: true,
        when: "queued",
        mode_used: "queue",
        queue_id: queueId,
        turn: jobTurn(refreshed),
        fallback_from: "interrupt",
        boundary_reason: anchorInfo?.reason || "active_step_unavailable",
        confirmed: false,
      };
      await updateJob(refreshed.job_id, (current) => {
        current.state = "collected";
        if (current.auto_collect === true) current.auto_collect_state = "collected";
        delete current.collecting_turn;
        delete current.collecting_started_at;
        current.collect_results = current.collect_results || {};
        current.collect_results[String(jobTurn(current))] = collectResult;
        current.collect_result = collectResult;
        if (current.queue) {
          current.queue.state = "queued";
          current.queue.updated_at = nowIso();
        }
      });
      collectRuns.delete(lockKey);
      return textResult({ ok: true, ...collectResult });
    }

    if (mode === "interrupt") {
      const interruptResult = await interruptAtWatchedBoundary(targetMainId, metadata, queueId, watchedStep, marker, collectMessage, {
        timeoutMs: Number(args.timeout_ms || 180000),
        cascadeConfig: mainCascadeConfig,
      });
      boundaryInfo = interruptResult.boundary;
      deliveredBy = interruptResult.delivered_by;
    } else {
      await interruptWithQueuedMessage(targetMainId, targetMainId, metadata, queueId);
      deliveredBy = "interrupt_with_queued_message";
    }
    const confirmed = await waitForTextInSteps(targetMainId, marker, Number(args.confirm_timeout_ms || 90000));
    if (!confirmed) {
      throw new Error("collect signal confirmation failed: marker not found in main steps");
    }
    const collectResult = {
      delivered: true,
      when: mode === "force" ? "forced" : "interrupted",
      mode_used: mode,
      queue_id: queueId,
      turn: jobTurn(refreshed),
      boundary_reason: boundaryInfo?.reason || null,
      watched_step: watchedStep,
      completed_step: boundaryInfo?.watched_step || null,
      delivered_by: deliveredBy,
    };
    await updateJob(refreshed.job_id, (current) => {
      current.state = "collected";
      if (current.auto_collect === true) current.auto_collect_state = "collected";
      delete current.collecting_turn;
      delete current.collecting_started_at;
      current.collect_results = current.collect_results || {};
      current.collect_results[String(jobTurn(current))] = collectResult;
      current.collect_result = collectResult;
      if (current.queue) {
        current.queue.state = "consumed";
        current.queue.updated_at = nowIso();
      }
    });
    collectRuns.delete(lockKey);
    return textResult({ ok: true, ...collectResult });
  } catch (error) {
    if (queueId && mode === "interrupt" && args.fallback_to_queue === true) {
      const collectResult = {
        delivered: true,
        when: "queued",
        mode_used: "queue",
        queue_id: queueId,
        turn: jobTurn(refreshed),
        fallback_from: "interrupt",
        last_error: error.message,
        confirmed: false,
      };
      await updateJob(job.job_id, (current) => {
        current.state = "collected";
        if (current.auto_collect === true) current.auto_collect_state = "collected";
        delete current.collecting_turn;
        delete current.collecting_started_at;
        current.collect_results = current.collect_results || {};
        current.collect_results[String(jobTurn(current))] = collectResult;
        current.collect_result = collectResult;
        current.last_error = error.message;
        if (current.queue) {
          current.queue.state = "queued";
          current.queue.updated_at = nowIso();
        }
      });
      collectRuns.delete(lockKey);
      return textResult({ ok: true, ...collectResult });
    }
    if (queueId) {
      try {
        const removed = await removeFromQueue(targetMainId, targetMainId, metadata, queueId);
        await updateJob(job.job_id, (current) => {
          current.state = "collect_failed";
          delete current.collecting_turn;
          delete current.collecting_started_at;
          if (current.queue) {
            current.queue.state = removed.removed ? "removed" : "unknown";
            current.queue.updated_at = nowIso();
            current.queue.remove_attempts = (current.queue.remove_attempts || 0) + 1;
          }
          current.last_error = error.message;
        });
      } catch (removeError) {
        await updateJob(job.job_id, (current) => {
          current.state = "stale_queue";
          delete current.collecting_turn;
          delete current.collecting_started_at;
          if (current.queue) {
            current.queue.state = "remove_failed";
            current.queue.updated_at = nowIso();
            current.queue.remove_attempts = (current.queue.remove_attempts || 0) + 1;
            current.queue.last_error = removeError.message;
          }
          current.last_error = error.message;
        });
      }
    } else {
      await updateJob(job.job_id, (current) => {
        current.state = "collect_failed";
        delete current.collecting_turn;
        delete current.collecting_started_at;
        current.last_error = error.message;
      });
    }
    collectRuns.delete(lockKey);
    return failResult(error.message, { queue_id: queueId });
  }
}

export async function subagentInterrupt(args) {
  const mainId = args.main_id || args.target_id;
  if (!mainId || !args.target_id) return failResult("target_id and main_id are required");
  const metadata = await createMetadata();
  await interruptWithQueuedMessage(mainId, args.target_id, metadata, args.queue_id);
  return textResult({ ok: true, interrupted: true, target_id: args.target_id, queue_id: args.queue_id || null });
}

export async function subagentReconcile() {
  const registry = await readRegistry();
  const changes = [];
  for (const job of Object.values(registry.jobs)) {
    if (["archived", "deleted"].includes(job.state)) continue;
    try {
      const summary = await getSummary(job.main_id, job.sub_cid);
      if (!summary) {
        await updateJob(job.job_id, (current) => {
          current.state = "missing";
          current.last_error = "sub_cid missing from LS summaries";
        });
        changes.push({ job_id: job.job_id, state: "missing" });
        continue;
      }
      if (job.deadline_at && Date.parse(job.deadline_at) < Date.now() && ["creating", "running"].includes(job.state)) {
        await updateJob(job.job_id, (current) => {
          current.state = "timeout";
        });
        changes.push({ job_id: job.job_id, state: "timeout" });
      }
      if (job.queue?.queue_id && ["queued", "unknown", "remove_failed"].includes(job.queue.state) && job.state === "stale_queue") {
        const metadata = await createMetadata();
        const removed = await removeFromQueue(job.main_id, job.queue.main_id, metadata, job.queue.queue_id);
        await updateJob(job.job_id, (current) => {
          current.queue.state = removed.removed ? "removed" : "unknown";
          current.queue.updated_at = nowIso();
          current.queue.remove_attempts = (current.queue.remove_attempts || 0) + 1;
        });
        changes.push({ job_id: job.job_id, queue_id: job.queue.queue_id, removed: removed.removed });
      }
      if (
        job.queue?.queue_id
        && ["queued", "unknown", "remove_failed"].includes(job.queue.state)
        && job.state === "collected"
        && collectResultForTurn(job)?.when !== "queued"
      ) {
        const metadata = await createMetadata();
        const marker = `[subagent:${job.job_id}:turn:${job.queue.turn || jobTurn(job)}]`;
        let removed = { removed: false };
        try {
          removed = await removeFromQueue(job.main_id, job.queue.main_id, metadata, job.queue.queue_id);
        } catch (error) {
          const steps = await getCompleteSteps(job.main_id, job.main_id);
          if (!stepsIncludeText(steps, marker)) throw error;
        }
        await updateJob(job.job_id, (current) => {
          if (current.queue?.queue_id === job.queue.queue_id) {
            current.queue.state = removed.removed ? "removed_after_collected" : "consumed";
            current.queue.updated_at = nowIso();
            current.queue.remove_attempts = (current.queue.remove_attempts || 0) + 1;
          }
        });
        changes.push({ job_id: job.job_id, queue_id: job.queue.queue_id, cleanup: "collected_residual_queue", removed: removed.removed });
      }
    } catch (error) {
      await updateJob(job.job_id, (current) => {
        current.last_error = error.message;
      });
      changes.push({ job_id: job.job_id, error: error.message });
    }
  }
  return textResult({ ok: true, changes });
}

export async function subagentMoveQueuedMessage(args) {
  const job = await getJob(args.job_id);
  if (!job) return failResult(`Unknown job_id=${args.job_id}`);
  if (!job.queue?.queue_id) return failResult("job has no queue_id");
  const metadata = await createMetadata();
  await moveQueuedMessage(job.main_id, job.queue.main_id, metadata, job.queue.queue_id, Number(args.to_index || 0));
  return textResult({ ok: true, job_id: job.job_id, queue_id: job.queue.queue_id, to_index: Number(args.to_index || 0) });
}

export async function waitForJobDone(jobId, timeoutMs = 120000) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Unknown job_id=${jobId}`);
  return await waitForStatus(
    job.main_id,
    job.sub_cid,
    (summary) => String(summary?.status || "").includes("IDLE"),
    { timeoutMs, intervalMs: 2500 },
  );
}

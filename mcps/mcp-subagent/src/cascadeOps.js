import { callResolvedLanguageServer } from "./lsClient.js";
import { createCascadeConfig, createMetadata } from "./metadata.js";
import { writeAudit } from "./audit.js";

export const DEFAULT_MODEL = "claude-opus-4-8-xhigh";

const WRITE_METHODS = new Set([
  "StartCascade",
  "SendUserCascadeMessage",
  "QueueCascadeMessage",
  "RemoveFromQueue",
  "InterruptWithQueuedMessage",
  "MoveQueuedMessage",
  "RenameCascadeTrajectory",
  "CancelCascadeInvocationAndWait",
  "DeleteCascadeTrajectory",
]);

function auditPayload(method, payload) {
  return {
    method,
    cascade_id: payload?.cascadeId || null,
    queue_id: payload?.queueId || null,
    has_items: Array.isArray(payload?.items) && payload.items.length > 0,
    image_count: Array.isArray(payload?.images) ? payload.images.length : 0,
  };
}

export async function lsCall(mainId, method, payload = {}, options = {}) {
  try {
    const result = await callResolvedLanguageServer({
      mainId,
      method,
      payload,
      retries: options.retries ?? 1,
      timeoutMs: options.timeoutMs ?? 15000,
    });
    if (WRITE_METHODS.has(method)) {
      await writeAudit({
        category: "ls_write",
        ok: true,
        main_id: mainId,
        ...auditPayload(method, payload),
        resolved_pid: result.resolved?.pid,
        resolved_port: result.resolved?.port,
        attempts: result.attempts,
      });
    }
    return result.body;
  } catch (error) {
    if (WRITE_METHODS.has(method)) {
      await writeAudit({
        category: "ls_write",
        ok: false,
        main_id: mainId,
        ...auditPayload(method, payload),
        error: error.message,
      });
    }
    throw error;
  }
}

export async function startCascade(mainId) {
  const metadata = await createMetadata();
  const body = await lsCall(mainId, "StartCascade", {
    metadata,
    source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
    trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
  });
  const cascadeId = body.cascadeId || body.trajectoryId || body.id || body.cascade?.cascadeId;
  if (!cascadeId) {
    throw new Error(`StartCascade did not return cascadeId: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return { cascadeId, metadata };
}

export async function sendMessage(mainId, cascadeId, metadata, text, options = {}) {
  const payload = {
    cascadeId,
    metadata,
    items: [{ text }],
    images: options.images || [],
    blocking: options.blocking ?? false,
  };
  if (!options.preserveMode) {
    payload.cascadeConfig = options.cascadeConfig || createCascadeConfig({
      model: options.model || DEFAULT_MODEL,
      mode: options.mode,
    });
  }
  return await lsCall(mainId, "SendUserCascadeMessage", payload, { timeoutMs: options.timeoutMs ?? 20000 });
}

export async function queueMessage(mainId, cascadeId, metadata, text, options = {}) {
  const payload = {
    cascadeId,
    metadata,
    items: [{ text }],
    images: options.images || [],
  };
  if (!options.preserveMode) {
    payload.cascadeConfig = options.cascadeConfig || createCascadeConfig({
      model: options.model || DEFAULT_MODEL,
      mode: options.mode,
    });
  }
  return await lsCall(mainId, "QueueCascadeMessage", payload, { timeoutMs: options.timeoutMs ?? 15000 });
}

export async function removeFromQueue(mainId, cascadeId, metadata, queueId) {
  return await lsCall(mainId, "RemoveFromQueue", {
    cascadeId,
    metadata,
    queueId,
  });
}

export async function interruptWithQueuedMessage(mainId, cascadeId, metadata, queueId) {
  const payload = {
    cascadeId,
    metadata,
  };
  if (queueId) payload.queueId = queueId;
  return await lsCall(mainId, "InterruptWithQueuedMessage", payload);
}

export async function moveQueuedMessage(mainId, cascadeId, metadata, queueId, toIndex) {
  return await lsCall(mainId, "MoveQueuedMessage", {
    cascadeId,
    metadata,
    queueId,
    toIndex,
  });
}

export async function renameCascade(mainId, cascadeId, name) {
  return await lsCall(mainId, "RenameCascadeTrajectory", {
    cascadeId,
    name,
  });
}

export async function cancelCascade(mainId, cascadeId) {
  return await lsCall(mainId, "CancelCascadeInvocationAndWait", { cascadeId }, {
    timeoutMs: 30000,
  });
}

export async function deleteCascade(mainId, cascadeId) {
  return await lsCall(mainId, "DeleteCascadeTrajectory", { cascadeId });
}

export async function getTrajectory(mainId, cascadeId) {
  return await lsCall(mainId, "GetCascadeTrajectory", { cascadeId });
}

export async function getSteps(mainId, cascadeId, stepOffset = 0) {
  return await lsCall(mainId, "GetCascadeTrajectorySteps", {
    cascadeId,
    stepOffset,
  });
}

export async function getSummary(mainId, cascadeId) {
  const body = await lsCall(mainId, "GetAllCascadeTrajectories", {});
  return body.trajectorySummaries?.[cascadeId] || null;
}

export async function waitForStatus(mainId, cascadeId, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 1500;
  const started = Date.now();
  let lastSummary = null;
  while (Date.now() - started < timeoutMs) {
    lastSummary = await getSummary(mainId, cascadeId);
    if (predicate(lastSummary)) return lastSummary;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastSummary;
}

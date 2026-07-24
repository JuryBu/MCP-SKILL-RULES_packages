import fs from "node:fs";
import path from "node:path";

function boundedString(value, name, maximum, required = false) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  if (required && !normalized) throw new Error(`${name} 不能为空`);
  if (normalized.length > maximum) throw new Error(`${name} 不能超过 ${maximum} 个字符`);
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function loadHeartbeatConfig(configPath) {
  if (!fs.existsSync(configPath)) throw new Error(`心跳配置不存在：${configPath}`);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  if (Number(raw.schemaVersion ?? 1) !== 1) {
    throw new Error(`不支持 heartbeat schemaVersion=${raw.schemaVersion}`);
  }
  return {
    schemaVersion: 1,
    taskId: boundedString(raw.taskId, "taskId", 128, true),
    runId: boundedString(raw.runId, "runId", 128),
    intervalMinutes: boundedInteger(raw.intervalMinutes, 30, 1, 1440),
    summary: boundedString(raw.summary ?? "训练进程仍在运行", "summary", 500),
    progress: boundedString(raw.progress, "progress", 240),
    checkpointAt: boundedString(raw.checkpointAt, "checkpointAt", 80),
  };
}

export function buildHeartbeatInput(config, nowDate) {
  const intervalMilliseconds = config.intervalMinutes * 60000;
  const slot = Math.floor(nowDate.getTime() / intervalMilliseconds);
  return {
    task_id: config.taskId,
    run_id: config.runId,
    event: "heartbeat",
    dedupe_key: `${config.taskId}:heartbeat:${config.runId || "no-run"}:${slot}`,
    summary: config.summary,
    progress: config.progress,
    checkpoint_at: config.checkpointAt,
    next_check_at: new Date(nowDate.getTime() + intervalMilliseconds).toISOString(),
  };
}

export function writeHeartbeatRuntimeState(runtimeStatePath, patch, options = {}) {
  let current = {};
  if (fs.existsSync(runtimeStatePath)) {
    try {
      current = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      current = {};
    }
  }
  const next = {
    schemaVersion: 1,
    ...current,
    ...patch,
    pid: options.pid ?? patch.pid ?? current.pid ?? process.pid,
  };
  atomicWriteJson(runtimeStatePath, next);
  return next;
}

export async function runHeartbeatAttempt(options) {
  const nowDate = options.now?.() ?? new Date();
  const config = loadHeartbeatConfig(options.configPath);
  const input = buildHeartbeatInput(config, nowDate);
  writeHeartbeatRuntimeState(options.runtimeStatePath, {
    status: "running",
    taskId: config.taskId,
    runId: config.runId,
    intervalMinutes: config.intervalMinutes,
    lastAttemptAt: nowDate.toISOString(),
    nextAttemptAt: input.next_check_at,
  }, options);
  try {
    const result = await options.notifier.sendTrainingEvent(input);
    const healthy = result.sent === true || result.duplicateSuppressed === true;
    const state = writeHeartbeatRuntimeState(options.runtimeStatePath, {
      status: "running",
      lastSuccessAt: healthy ? nowDate.toISOString() : undefined,
      lastResult: result,
      lastError: null,
    }, options);
    appendJsonLine(options.logPath, {
      at: nowDate.toISOString(),
      type: "heartbeat_attempt",
      ok: healthy,
      sent: Boolean(result.sent),
      verified: Boolean(result.verified),
      duplicateSuppressed: Boolean(result.duplicateSuppressed),
      reason: result.reason ?? null,
      dedupeKey: input.dedupe_key,
    });
    return { config, input, result, state };
  } catch (error) {
    const publicError = {
      code: error?.code ?? "HEARTBEAT_ERROR",
      message: error?.message ?? String(error),
      outcomeUnknown: Boolean(error?.outcomeUnknown),
    };
    const state = writeHeartbeatRuntimeState(options.runtimeStatePath, {
      status: "running",
      lastError: publicError,
    }, options);
    appendJsonLine(options.logPath, {
      at: nowDate.toISOString(),
      type: "heartbeat_attempt",
      ok: false,
      error: publicError,
      dedupeKey: input.dedupe_key,
    });
    return { config, input, error: publicError, state };
  }
}

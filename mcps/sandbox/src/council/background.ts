import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { TEMP_DIR } from "../temp-store.js";
import { formatElapsed } from "../lifecycle.js";
import { hasOwnerAccess, normalizeOwnerId, ownerMismatchText, newUuid } from "../owner.js";
import { normalizeCouncilModelConfig, type CouncilCheckpoint, type CouncilRunParams, type CouncilTranscript } from "./types.js";
import {
    councilArtifactPath,
    councilTaskDirectory,
    createCouncilArtifactRun,
    finishCouncilArtifactRun,
    listCouncilArtifactManifests,
    readCouncilArtifactManifest,
    validCouncilIdentifier,
} from "./artifact-store.js";
import { formatCouncilArtifactSummary } from "./transcript.js";
import { councilRuntimeTempRoot } from "./paths.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));
const SERVER_ROOT = path.resolve(path.dirname(WORKER_PATH), "..", "..");
const CONFIGURED_TASK_ROOT = process.env.SANDBOX_COUNCIL_TASK_ROOT
    ? path.resolve(process.env.SANDBOX_COUNCIL_TASK_ROOT)
    : undefined;
const LEGACY_WORKER_CWD_TASK_ROOT = path.join(path.dirname(WORKER_PATH), "sandbox-data", "temp", "council-tasks");
const LEGACY_PROCESS_CWD_TASK_ROOT = path.join(TEMP_DIR, "council-tasks");
const LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT = path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity", "sandbox-data", "temp", "council-tasks");
const DEFAULT_BACKGROUND_MAX_RUN_MS = Number(process.env.SANDBOX_COUNCIL_BACKGROUND_MAX_RUN_MS || 45 * 60_000);
const configuredAbortGraceMs = Number(process.env.SANDBOX_COUNCIL_BACKGROUND_ABORT_GRACE_MS || 15_000);
const BACKGROUND_ABORT_GRACE_MS = Number.isFinite(configuredAbortGraceMs)
    ? Math.max(1_000, Math.min(configuredAbortGraceMs, 5 * 60_000))
    : 15_000;

export interface PersistentCouncilSpec {
    taskId: string;
    runId: string;
    artifactManifestPath: string;
    ownerId: string;
    startedAt: string;
    deadlineAt?: string;
    checkpointPath?: string;
    transcriptPath?: string;
    outputDir?: string;
    workerIdentity?: CouncilWorkerIdentity;
    resume?: {
        sourceTaskId: string;
        sourceRunId?: string;
        checkpointPath: string;
        transcriptJsonPath: string;
    };
    params: Omit<CouncilRunParams, "onProgress" | "signal">;
}

interface PersistentCouncilProgress {
    status: "running" | "done" | "error" | "interrupted";
    taskId: string;
    runId: string;
    artifactManifestPath: string;
    ownerId: string;
    pid?: number;
    workerIdentity?: CouncilWorkerIdentity;
    startedAt: string;
    updatedAt: string;
    deadlineAt?: string;
    progressText?: string;
}

interface PersistentCouncilDone {
    status: "done" | "error" | "interrupted";
    taskId: string;
    runId: string;
    artifactManifestPath: string;
    ownerId: string;
    startedAt: string;
    finishedAt: string;
    resultText?: string;
    transcript?: CouncilTranscript;
    error?: string;
    pid?: number;
    workerIdentity?: CouncilWorkerIdentity;
    resumedBy?: string;
    newTaskId?: string;
    newRunId?: string;
}

export interface CouncilResumeSource {
    sourceTaskId: string;
    sourceRunId?: string;
    sourceArtifactManifestPath?: string;
    spec: PersistentCouncilSpec;
    checkpoint: CouncilCheckpoint;
    checkpointPath: string;
    transcript: CouncilTranscript;
    transcriptJsonPath: string;
}

export interface PersistentCouncilQueryResult {
    taskId: string;
    runId?: string;
    artifactManifestPath?: string;
    ownerId: string;
    status: "running" | "done" | "error" | "interrupted" | "missing" | "owner_mismatch";
    startedAt?: string;
    finishedAt?: string;
    deadlineAt?: string;
    progressText?: string;
    resultText?: string;
    transcript?: CouncilTranscript;
    error?: string;
    pid?: number;
    resumedBy?: string;
    newTaskId?: string;
    newRunId?: string;
}

function ensureTaskRoot(): void {
    if (CONFIGURED_TASK_ROOT) fs.mkdirSync(CONFIGURED_TASK_ROOT, { recursive: true });
    else fs.mkdirSync(path.join(councilRuntimeTempRoot(), "council-tasks"), { recursive: true });
}

function taskRootDirectory(): string {
    return CONFIGURED_TASK_ROOT || path.join(councilRuntimeTempRoot(), "council-tasks");
}

function getTaskDir(taskId: string): string {
    const safeTaskId = validCouncilIdentifier(taskId, "taskId");
    return CONFIGURED_TASK_ROOT ? path.join(CONFIGURED_TASK_ROOT, safeTaskId) : councilTaskDirectory(safeTaskId);
}

function getTaskPaths(taskId: string) {
    const dir = getTaskDir(taskId);
    return {
        dir,
        spec: path.join(dir, "spec.json"),
        progress: path.join(dir, "progress.json"),
        checkpoint: path.join(dir, "checkpoint.json"),
        done: path.join(dir, "done.json"),
    };
}

function getLegacyWorkerCwdTaskPaths(taskId: string) {
    const dir = path.join(LEGACY_WORKER_CWD_TASK_ROOT, taskId);
    return {
        dir,
        spec: path.join(dir, "spec.json"),
        progress: path.join(dir, "progress.json"),
        done: path.join(dir, "done.json"),
    };
}

function getLegacyProcessCwdTaskPaths(taskId: string) {
    const dir = path.join(LEGACY_PROCESS_CWD_TASK_ROOT, taskId);
    return {
        dir,
        spec: path.join(dir, "spec.json"),
        progress: path.join(dir, "progress.json"),
        done: path.join(dir, "done.json"),
    };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(temp, filePath);
}

function readJson<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
        return null;
    }
}

function transcriptJsonPathFromMarkdown(transcriptPath: string): string {
    return transcriptPath.toLowerCase().endsWith(".md")
        ? transcriptPath.slice(0, -3) + ".json"
        : `${transcriptPath}.json`;
}

function copyIfMissing(source: string, target: string): boolean {
    try {
        if (!fs.existsSync(source) || fs.existsSync(target)) return false;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        return true;
    } catch {
        return false;
    }
}

function recoverLegacyWorkerCwdTask(taskId: string): void {
    const paths = getTaskPaths(taskId);
    const legacyRoots = [
        getLegacyWorkerCwdTaskPaths(taskId),
        getLegacyProcessCwdTaskPaths(taskId),
        {
            dir: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId),
            spec: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId, "spec.json"),
            progress: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId, "progress.json"),
            done: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId, "done.json"),
        },
    ];
    for (const legacy of legacyRoots) {
        if (!fs.existsSync(legacy.dir) || path.resolve(legacy.dir) === path.resolve(paths.dir)) continue;
        copyIfMissing(legacy.spec, paths.spec);
        copyIfMissing(legacy.done, paths.done);
        copyIfMissing(legacy.progress, paths.progress);
    }
}

export interface CouncilWorkerIdentity {
    pid: number;
    startId: string;
}

export type CouncilWorkerTerminationResult = "not_required" | "terminated" | "not_running" | "identity_missing" | "identity_mismatch";

export interface CouncilWorkerTerminationDependencies {
    observeIdentity?: (pid: number) => CouncilWorkerIdentity | undefined;
    terminateProcessTree?: (pid: number) => void;
}

function isPidAlive(pid?: number): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function killProcessTree(pid?: number): void {
    if (!pid) return;
    try {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        killer.unref();
    } catch {
        // Best-effort deadline cleanup.
    }
}

function getPowerShellCommand(): string {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (systemRoot) {
        const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (fs.existsSync(candidate)) return candidate;
    }
    return "powershell.exe";
}

function workerProcessStartId(pid: number): string | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
        if (process.platform === "win32") {
            const result = spawnSync(getPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], {
                encoding: "utf-8",
                windowsHide: true,
                timeout: 3_000,
            });
            return result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
        }
        if (process.platform === "linux") {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
            return fields[19] || undefined;
        }
        const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 3_000 });
        return result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
    } catch {
        return undefined;
    }
}

export function readCouncilWorkerIdentity(pid?: number): CouncilWorkerIdentity | undefined {
    if (!pid || !isPidAlive(pid)) return undefined;
    const startId = workerProcessStartId(pid);
    return startId ? { pid, startId } : undefined;
}

export function terminateCouncilWorkerIfIdentityMatches(
    expected: CouncilWorkerIdentity | undefined,
    dependencies: CouncilWorkerTerminationDependencies = {},
): CouncilWorkerTerminationResult {
    if (!expected) return "identity_missing";
    const observed = (dependencies.observeIdentity || readCouncilWorkerIdentity)(expected.pid);
    if (!observed) return "not_running";
    if (observed.pid !== expected.pid || observed.startId !== expected.startId) return "identity_mismatch";
    (dependencies.terminateProcessTree || killProcessTree)(expected.pid);
    return "terminated";
}

export function reclaimCouncilWorkerAfterDeadline(
    status: "running" | "done" | "error" | "interrupted",
    workerIdentity: CouncilWorkerIdentity | undefined,
    dependencies: CouncilWorkerTerminationDependencies = {},
): CouncilWorkerTerminationResult {
    if (status === "done" || status === "error") return "not_required";
    return terminateCouncilWorkerIfIdentityMatches(workerIdentity, dependencies);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
    return new Date().toISOString();
}

function normalizeCouncilRunParams(params: CouncilRunParams): CouncilRunParams {
    return {
        ...params,
        participants: params.participants.map(normalizeCouncilModelConfig),
        moderator: normalizeCouncilModelConfig(params.moderator),
        transcriptionModel: params.transcriptionModel ? normalizeCouncilModelConfig(params.transcriptionModel) : undefined,
        textProjectionModel: params.textProjectionModel ? normalizeCouncilModelConfig(params.textProjectionModel) : undefined,
    };
}

function serializeCouncilRunParams(params: CouncilRunParams): Omit<CouncilRunParams, "onProgress" | "signal"> {
    const { onProgress: _onProgress, signal: _signal, ...serializableParams } = params;
    return serializableParams;
}

function forceKillResultText(result: CouncilWorkerTerminationResult): string {
    if (result === "terminated") return "已强制回收匹配身份的 worker 进程树";
    if (result === "not_running") return "worker 已退出，无需强制回收";
    if (result === "not_required") return "任务已正常结束，无需强制回收";
    return "worker 身份无法确认，未强制结束 PID";
}

function scheduleCouncilWorkerForceKill(taskId: string, ownerId: string, deadlineAt: string): void {
    const graceMs = Math.max(0, new Date(deadlineAt).getTime() - Date.now()) + BACKGROUND_ABORT_GRACE_MS;
    const timer = setTimeout(() => {
        const paths = getTaskPaths(taskId);
        const spec = readJson<PersistentCouncilSpec>(paths.spec);
        const progress = readJson<PersistentCouncilProgress>(paths.progress);
        const done = readJson<PersistentCouncilDone>(paths.done);
        const workerIdentity = done?.workerIdentity || progress?.workerIdentity || spec?.workerIdentity;
        const termination = reclaimCouncilWorkerAfterDeadline(done?.status || "running", workerIdentity);
        if (termination === "not_required") return;
        if (!done) {
            finalizeCouncilTask(taskId, ownerId, {
                status: "interrupted",
                error: `后台 worker 在 deadline 后 ${BACKGROUND_ABORT_GRACE_MS}ms 内未退出，${forceKillResultText(termination)}`,
                pid: workerIdentity?.pid || progress?.pid,
                startedAt: progress?.startedAt || spec?.startedAt,
            });
        }
    }, graceMs);
    timer.unref?.();
}

function normalizeCouncilTranscript(transcript: CouncilTranscript): CouncilTranscript {
    return {
        ...transcript,
        participants: transcript.participants.map(normalizeCouncilModelConfig),
        moderator: normalizeCouncilModelConfig(transcript.moderator),
        rounds: transcript.rounds.map((round) => ({
            ...round,
            messages: round.messages.map((message) => ({
                ...message,
                provider: normalizeCouncilModelConfig({ id: message.participantId, role: message.role, provider: message.provider }).provider,
            })),
        })),
    };
}

function isTaskDirInsideRoot(taskDir: string): boolean {
    const root = path.resolve(taskRootDirectory());
    const resolved = path.resolve(taskDir);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function listCouncilTaskDirs(): fs.Dirent[] {
    ensureTaskRoot();
    try {
        return fs.readdirSync(taskRootDirectory(), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
        return [];
    }
}

export function cleanOldCouncilTasks(maxAgeDays = 15): number {
    const cutoffMs = Date.now() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
    const dependentTaskIds = new Set(
        listCouncilArtifactManifests()
            .filter((record) => record.state === "valid")
            .flatMap((record) => record.manifest.dependsOn.map((dependency) => dependency.taskId).filter((taskId): taskId is string => Boolean(taskId))),
    );
    let removed = 0;

    for (const entry of listCouncilTaskDirs()) {
        if (dependentTaskIds.has(entry.name)) continue;
        const paths = getTaskPaths(entry.name);
        if (!isTaskDirInsideRoot(paths.dir)) continue;
        if (fs.existsSync(path.join(paths.dir, ".preserve"))) continue;

        const progress = readJson<PersistentCouncilProgress>(paths.progress);
        const done = readJson<PersistentCouncilDone>(paths.done);
        if (progress?.status === "running" && !done) continue;

        const timestamp = done?.finishedAt || progress?.updatedAt;
        if (!timestamp) continue;
        const updatedAtMs = Date.parse(timestamp);
        if (!Number.isFinite(updatedAtMs) || updatedAtMs >= cutoffMs) continue;

        try {
            fs.rmSync(paths.dir, { recursive: true, force: true });
            removed += 1;
        } catch {
            // Best-effort cleanup; a locked task directory should not block startup.
        }
    }

    return removed;
}

export interface CouncilStartupScanResult {
    discovered: number;
    running: number;
    interrupted: number;
}

export function scanCouncilTasksOnStartup(logger: (message: string) => void = console.error): CouncilStartupScanResult {
    const summary: CouncilStartupScanResult = { discovered: 0, running: 0, interrupted: 0 };

    for (const entry of listCouncilTaskDirs()) {
        const taskId = entry.name;
        const paths = getTaskPaths(taskId);
        const progress = readJson<PersistentCouncilProgress>(paths.progress);
        if (!progress || fs.existsSync(paths.done)) continue;

        summary.discovered += 1;
        if (progress.pid && isPidAlive(progress.pid)) {
            summary.running += 1;
            logger(`[sandbox] 旧council任务 ${taskId} worker仍在运行 (pid=${progress.pid})`);
            continue;
        }

        const spec = readJson<PersistentCouncilSpec>(paths.spec);
        finalizeCouncilTask(taskId, spec?.ownerId || progress.ownerId, {
            status: "interrupted",
            error: "worker已退出",
            pid: progress.pid,
            startedAt: progress.startedAt,
        });
        summary.interrupted += 1;
        logger(`[sandbox] 旧council任务 ${taskId} worker已退出，已标记中断`);
    }

    logger(`[sandbox] 发现 ${summary.discovered} 个旧council任务，${summary.running} 个worker仍在运行，${summary.interrupted} 个已标记中断`);
    return summary;
}

export function readCouncilResumeSource(taskId: string, requestOwnerId: string): CouncilResumeSource {
    const ownerId = normalizeOwnerId(requestOwnerId);
    const paths = getTaskPaths(taskId);
    recoverLegacyWorkerCwdTask(taskId);
    const loadedSpec = readJson<PersistentCouncilSpec>(paths.spec);
    const spec = loadedSpec ? { ...loadedSpec, params: normalizeCouncilRunParams(loadedSpec.params) } : undefined;
    if (!spec) {
        throw new Error(`❌ 未找到可恢复的 council 任务 ${taskId}`);
    }
    if (!hasOwnerAccess(spec.ownerId, ownerId)) {
        throw new Error(ownerMismatchText("后台任务", taskId));
    }
    const progress = readJson<PersistentCouncilProgress>(paths.progress);
    const done = readJson<PersistentCouncilDone>(paths.done);
    if (!done && progress?.status === "running" && isPidAlive(progress.pid)) {
        throw new Error(`❌ council 任务 ${taskId} 的 worker 仍在运行，不能并发 resume；请等待任务结束或先中止旧任务`);
    }
    const transcriptPath = spec.transcriptPath || spec.params.transcriptPath;
    if (!transcriptPath) {
        throw new Error(`❌ council 任务 ${taskId} 缺少 transcriptPath，无法 resume`);
    }
    const transcriptJsonPath = transcriptJsonPathFromMarkdown(transcriptPath);
    let checkpoint: CouncilCheckpoint | undefined;
    let transcript: CouncilTranscript | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const checkpointBefore = readJson<CouncilCheckpoint>(paths.checkpoint);
        const loadedTranscript = readJson<CouncilTranscript>(transcriptJsonPath);
        const checkpointAfter = readJson<CouncilCheckpoint>(paths.checkpoint);
        if (!checkpointBefore || !checkpointAfter || !loadedTranscript) continue;
        if (checkpointBefore.updatedAt !== checkpointAfter.updatedAt) continue;
        const candidateTranscript = normalizeCouncilTranscript(loadedTranscript);
        const lastRound = candidateTranscript.rounds.at(-1)?.round || 0;
        const requiredRound = checkpointAfter.roundComplete || checkpointAfter.phase === "moderator"
            ? checkpointAfter.currentRound
            : checkpointAfter.lastCompletedRound || 0;
        if (checkpointAfter.transcriptId !== candidateTranscript.id || lastRound < requiredRound) continue;
        checkpoint = checkpointAfter;
        transcript = candidateTranscript;
        break;
    }
    if (!checkpoint) {
        throw new Error(`❌ council 任务 ${taskId} 缺少稳定 checkpoint 快照，无法 resume；请稍后重试`);
    }
    if (!transcript) {
        throw new Error(`❌ council 任务 ${taskId} 缺少稳定 transcript JSON，无法 resume: ${transcriptJsonPath}`);
    }
    const sourceRunId = spec.runId || transcript.runId;
    const sourceArtifactRun = sourceRunId ? readCouncilArtifactManifest(sourceRunId, { touch: "resume" }) : undefined;
    if (sourceArtifactRun) {
        transcript.runId = sourceArtifactRun.runId;
        transcript.artifactManifestPath = sourceArtifactRun.artifactManifestPath;
    }
    return {
        sourceTaskId: taskId,
        sourceRunId,
        sourceArtifactManifestPath: sourceArtifactRun?.artifactManifestPath,
        spec,
        checkpoint,
        checkpointPath: paths.checkpoint,
        transcript,
        transcriptJsonPath,
    };
}

export function markCouncilTaskResumed(sourceTaskId: string, requestOwnerId: string, newTaskId: string, newRunId: string): void {
    const ownerId = normalizeOwnerId(requestOwnerId);
    const paths = getTaskPaths(sourceTaskId);
    recoverLegacyWorkerCwdTask(sourceTaskId);
    const spec = readJson<PersistentCouncilSpec>(paths.spec);
    const progress = readJson<PersistentCouncilProgress>(paths.progress);
    const done = readJson<PersistentCouncilDone>(paths.done);
    const sourceOwnerId = done?.ownerId || spec?.ownerId || progress?.ownerId || ownerId;
    if (!hasOwnerAccess(sourceOwnerId, ownerId)) {
        throw new Error(ownerMismatchText("后台任务", sourceTaskId));
    }
    const payload: PersistentCouncilDone = {
        status: done?.status || "interrupted",
        taskId: sourceTaskId,
        runId: done?.runId || spec?.runId || progress?.runId || "legacy",
        artifactManifestPath: done?.artifactManifestPath || spec?.artifactManifestPath || progress?.artifactManifestPath || "",
        ownerId: sourceOwnerId,
        startedAt: done?.startedAt || progress?.startedAt || spec?.startedAt || nowIso(),
        finishedAt: done?.finishedAt || nowIso(),
        resultText: done?.resultText,
        transcript: done?.transcript,
        error: done?.error || "任务已被 resume 接管",
        pid: done?.pid ?? progress?.pid,
        workerIdentity: done?.workerIdentity || progress?.workerIdentity || spec?.workerIdentity,
        resumedBy: ownerId,
        newTaskId,
        newRunId,
    };
    writeJsonAtomic(paths.done, payload);
}

export function writeCouncilTaskProgress(taskId: string, ownerId: string, progressText: string, pid?: number, startedAt?: string, deadlineAt?: string, workerIdentity?: CouncilWorkerIdentity): void {
    const paths = getTaskPaths(taskId);
    const current = readJson<PersistentCouncilProgress>(paths.progress);
    const spec = readJson<PersistentCouncilSpec>(paths.spec);
    const payload: PersistentCouncilProgress = {
        status: "running",
        taskId,
        runId: current?.runId || spec?.runId || "legacy",
        artifactManifestPath: current?.artifactManifestPath || spec?.artifactManifestPath || "",
        ownerId,
        pid: pid ?? current?.pid,
        workerIdentity: workerIdentity ?? current?.workerIdentity ?? spec?.workerIdentity,
        startedAt: startedAt || current?.startedAt || nowIso(),
        updatedAt: nowIso(),
        deadlineAt: deadlineAt || current?.deadlineAt,
        progressText,
    };
    writeJsonAtomic(paths.progress, payload);
}

export function finalizeCouncilTask(taskId: string, ownerId: string, result: {
    status: "done" | "error" | "interrupted";
    transcript?: CouncilTranscript;
    resultText?: string;
    error?: string;
    pid?: number;
    startedAt?: string;
}): void {
    const paths = getTaskPaths(taskId);
    const current = readJson<PersistentCouncilProgress>(paths.progress);
    const spec = readJson<PersistentCouncilSpec>(paths.spec);
    const payload: PersistentCouncilDone = {
        status: result.status,
        taskId,
        runId: current?.runId || spec?.runId || result.transcript?.runId || "legacy",
        artifactManifestPath: current?.artifactManifestPath || spec?.artifactManifestPath || result.transcript?.artifactManifestPath || "",
        ownerId,
        startedAt: result.startedAt || current?.startedAt || nowIso(),
        finishedAt: nowIso(),
        transcript: result.transcript,
        resultText: result.resultText,
        error: result.error,
        pid: result.pid ?? current?.pid,
        workerIdentity: current?.workerIdentity ?? spec?.workerIdentity,
    };
    writeJsonAtomic(paths.done, payload);
    if (payload.runId !== "legacy") {
        const artifactRun = readCouncilArtifactManifest(payload.runId);
        if (artifactRun.manifest.status === "running") finishCouncilArtifactRun(payload.runId, result.status);
    }
    const progressPayload: PersistentCouncilProgress = {
        status: result.status,
        taskId,
        runId: payload.runId,
        artifactManifestPath: payload.artifactManifestPath,
        ownerId,
        pid: payload.pid,
        workerIdentity: payload.workerIdentity,
        startedAt: payload.startedAt,
        updatedAt: payload.finishedAt,
        deadlineAt: current?.deadlineAt,
        progressText: result.error || result.resultText,
    };
    writeJsonAtomic(paths.progress, progressPayload);
}

export function startPersistentCouncilTask(runParams: CouncilRunParams, ownerIdInput?: string, maxRunMs = DEFAULT_BACKGROUND_MAX_RUN_MS, resumeSource?: CouncilResumeSource): { id: string; ownerId: string; deadlineAt: string; runId: string; artifactManifestPath: string } {
    ensureTaskRoot();
    const taskId = `council-${newUuid()}`;
    runParams = normalizeCouncilRunParams(runParams);
    const ownerId = normalizeOwnerId(ownerIdInput || runParams.ownerId);
    const startedAt = nowIso();
    const deadlineAt = new Date(Date.now() + maxRunMs).toISOString();
    const paths = getTaskPaths(taskId);
    const shouldUseProvidedTranscriptPath = Boolean(runParams.transcriptPath && (!resumeSource || runParams.transcriptPath !== resumeSource.spec.transcriptPath));
    const shouldUseProvidedOutputDir = Boolean(runParams.outputDir && (!resumeSource || runParams.outputDir !== resumeSource.spec.outputDir));
    const shouldUseProvidedCheckpointPath = Boolean(runParams.checkpointPath && (!resumeSource || runParams.checkpointPath !== resumeSource.checkpointPath));
    const artifactRun = createCouncilArtifactRun({
        taskId,
        ownerId,
        dependsOn: resumeSource ? [{ taskId: resumeSource.sourceTaskId, runId: resumeSource.sourceRunId }] : undefined,
    });
    runParams = {
        ...runParams,
        ownerId,
        taskId,
        runId: artifactRun.runId,
        artifactManifestPath: artifactRun.artifactManifestPath,
    };
    const transcriptPath = shouldUseProvidedTranscriptPath
        ? runParams.transcriptPath as string
        : shouldUseProvidedOutputDir
            ? path.join(path.resolve(runParams.outputDir as string), `council_${taskId}.md`)
        : councilArtifactPath(artifactRun.runId, "transcript", "council.md");
    const checkpointPath = shouldUseProvidedCheckpointPath ? runParams.checkpointPath as string : paths.checkpoint;
    const outputDir = shouldUseProvidedOutputDir ? runParams.outputDir as string : undefined;
    const resumeTranscriptJsonPath = resumeSource ? path.join(paths.dir, "resume-transcript.json") : undefined;
    const resumeCheckpointPath = resumeSource ? path.join(paths.dir, "resume-checkpoint.json") : undefined;
    const serializedParams = serializeCouncilRunParams(runParams);
    if (shouldUseProvidedTranscriptPath || shouldUseProvidedOutputDir) serializedParams.transcriptPath = transcriptPath;
    else delete serializedParams.transcriptPath;
    if (!shouldUseProvidedOutputDir) delete serializedParams.outputDir;
    const spec: PersistentCouncilSpec = {
        taskId,
        runId: artifactRun.runId,
        artifactManifestPath: artifactRun.artifactManifestPath,
        ownerId,
        startedAt,
        deadlineAt,
        checkpointPath,
        transcriptPath,
        outputDir,
        resume: resumeSource ? {
            sourceTaskId: resumeSource.sourceTaskId,
            sourceRunId: resumeSource.sourceRunId,
            checkpointPath: resumeCheckpointPath as string,
            transcriptJsonPath: resumeTranscriptJsonPath as string,
        } : undefined,
        params: {
            ...serializedParams,
            ownerId,
            taskId,
            runId: artifactRun.runId,
            artifactManifestPath: artifactRun.artifactManifestPath,
            checkpointPath,
        },
    };
    try {
        if (resumeSource && resumeTranscriptJsonPath && resumeCheckpointPath) {
            writeJsonAtomic(resumeTranscriptJsonPath, normalizeCouncilTranscript(resumeSource.transcript));
            writeJsonAtomic(resumeCheckpointPath, resumeSource.checkpoint);
        }
        writeJsonAtomic(paths.spec, spec);
        if (resumeSource) {
            markCouncilTaskResumed(resumeSource.sourceTaskId, ownerId, taskId, artifactRun.runId);
        }
        writeCouncilTaskProgress(taskId, ownerId, "任务已启动，等待 worker 接管。", undefined, startedAt, deadlineAt);
        const child = spawn(process.execPath, [WORKER_PATH, paths.spec], {
            cwd: SERVER_ROOT,
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.unref();
        const workerIdentity = readCouncilWorkerIdentity(child.pid);
        if (workerIdentity) writeJsonAtomic(paths.spec, { ...spec, workerIdentity });
        writeCouncilTaskProgress(taskId, ownerId, "worker 已启动，准备执行 council。", child.pid, startedAt, deadlineAt, workerIdentity);
        scheduleCouncilWorkerForceKill(taskId, ownerId, deadlineAt);
    } catch (error) {
        const current = readCouncilArtifactManifest(artifactRun.runId);
        if (current.manifest.status === "running") finishCouncilArtifactRun(artifactRun.runId, "error");
        throw error;
    }
    return { id: taskId, ownerId, deadlineAt, runId: artifactRun.runId, artifactManifestPath: artifactRun.artifactManifestPath };
}

function readTask(taskId: string, requestOwnerId: string): PersistentCouncilQueryResult {
    const ownerId = normalizeOwnerId(requestOwnerId);
    const paths = getTaskPaths(taskId);
    recoverLegacyWorkerCwdTask(taskId);
    const spec = readJson<PersistentCouncilSpec>(paths.spec);
    if (!spec) {
        return { taskId, ownerId, status: "missing", error: `❌ 未找到后台任务 ${taskId}` };
    }
    if (!hasOwnerAccess(spec.ownerId, ownerId)) {
        return { taskId, ownerId, status: "owner_mismatch", error: ownerMismatchText("后台任务", taskId) };
    }
    const done = readJson<PersistentCouncilDone>(paths.done);
    if (done) {
        const deadlineAtMs = spec.deadlineAt ? new Date(spec.deadlineAt).getTime() : Number.NaN;
        if (done.status === "interrupted" && Number.isFinite(deadlineAtMs) && Date.now() > deadlineAtMs + BACKGROUND_ABORT_GRACE_MS) {
            reclaimCouncilWorkerAfterDeadline(done.status, done.workerIdentity || spec.workerIdentity);
        }
        return {
            taskId,
            runId: done.runId || spec.runId,
            artifactManifestPath: done.artifactManifestPath || spec.artifactManifestPath,
            ownerId: done.ownerId,
            status: done.status,
            startedAt: done.startedAt,
            finishedAt: done.finishedAt,
            resultText: done.resultText,
            transcript: done.transcript,
            deadlineAt: spec.deadlineAt,
            error: done.error,
            pid: done.pid,
            resumedBy: done.resumedBy,
            newTaskId: done.newTaskId,
            newRunId: done.newRunId,
        };
    }
    const progress = readJson<PersistentCouncilProgress>(paths.progress);
    if (progress) {
        const deadlineAtMs = progress.deadlineAt ? new Date(progress.deadlineAt).getTime() : Number.NaN;
        if (Number.isFinite(deadlineAtMs) && Date.now() > deadlineAtMs + BACKGROUND_ABORT_GRACE_MS) {
            const termination = reclaimCouncilWorkerAfterDeadline(progress.status, progress.workerIdentity || spec.workerIdentity);
            const error = `后台任务在 deadline 后 ${BACKGROUND_ABORT_GRACE_MS}ms 仍未结束，${forceKillResultText(termination)}`;
            finalizeCouncilTask(taskId, progress.ownerId, {
                status: "interrupted",
                error,
                pid: progress.pid,
                startedAt: progress.startedAt,
            });
            return {
                taskId,
                runId: progress.runId || spec.runId,
                artifactManifestPath: progress.artifactManifestPath || spec.artifactManifestPath,
                ownerId: progress.ownerId,
                status: "interrupted",
                startedAt: progress.startedAt,
                deadlineAt: progress.deadlineAt,
                pid: progress.pid,
                error,
                progressText: progress.progressText,
            };
        }
        if (progress.pid && !isPidAlive(progress.pid)) {
            const error = "后台 worker 已退出，但未写入完成标记";
            finalizeCouncilTask(taskId, progress.ownerId, {
                status: "interrupted",
                error,
                pid: progress.pid,
                startedAt: progress.startedAt,
            });
            return {
                taskId,
                runId: progress.runId || spec.runId,
                artifactManifestPath: progress.artifactManifestPath || spec.artifactManifestPath,
                ownerId: progress.ownerId,
                status: "interrupted",
                startedAt: progress.startedAt,
                deadlineAt: progress.deadlineAt,
                pid: progress.pid,
                error,
                progressText: progress.progressText,
            };
        }
        return {
            taskId,
            runId: progress.runId || spec.runId,
            artifactManifestPath: progress.artifactManifestPath || spec.artifactManifestPath,
            ownerId: progress.ownerId,
            status: "running",
            startedAt: progress.startedAt,
            deadlineAt: progress.deadlineAt,
            progressText: progress.progressText,
            pid: progress.pid,
        };
    }
    return {
        taskId,
        ownerId,
        status: "missing",
        error: `❌ 后台任务 ${taskId} 缺少状态文件`,
    };
}

export async function waitForPersistentCouncilTask(taskId: string, waitSeconds: number, ownerIdInput?: string): Promise<PersistentCouncilQueryResult> {
    const ownerId = normalizeOwnerId(ownerIdInput);
    const maxWaitMs = Math.max(0, Math.min(waitSeconds || 0, 300)) * 1000;
    const deadline = Date.now() + maxWaitMs;
    while (true) {
        const snapshot = readTask(taskId, ownerId);
        if (snapshot.status !== "running") return snapshot;
        if (Date.now() >= deadline) return snapshot;
        await sleep(Math.min(1000, deadline - Date.now()));
    }
}

export function formatPersistentCouncilTask(result: PersistentCouncilQueryResult): string {
    if (result.status === "missing" || result.status === "owner_mismatch") {
        return result.error || `❌ 后台任务 ${result.taskId} 不可用`;
    }
    if (result.status === "running") {
        return [
            "⏳ 后台任务运行中",
            `🆔 taskId: ${result.taskId}`,
            `👤 ownerId: ${result.ownerId}`,
            result.pid ? `🧵 pid: ${result.pid}` : "",
            result.startedAt ? `⏱️ 已用: ${formatElapsed(Date.now() - new Date(result.startedAt).getTime())}` : "",
            result.deadlineAt ? `⏳ deadlineAt: ${result.deadlineAt}` : "",
            "",
            "## 当前进度",
            result.progressText || "暂无进度文本",
            "",
            result.runId ? formatCouncilArtifactSummary(result.runId) : "",
        ].filter(Boolean).join("\n");
    }
    if (result.status === "interrupted") {
        return [
            "⚠️ 后台任务中断",
            `🆔 taskId: ${result.taskId}`,
            `👤 ownerId: ${result.ownerId}`,
            result.newTaskId ? `🔁 resumedBy: ${result.resumedBy || result.ownerId} → ${result.newTaskId}` : "",
            result.pid ? `🧵 pid: ${result.pid}` : "",
            result.error || "worker 已退出",
            result.progressText ? `\n## 最后进度\n${result.progressText}` : "",
            "",
            result.runId ? formatCouncilArtifactSummary(result.runId) : "",
        ].filter(Boolean).join("\n");
    }
    const text = result.resultText || result.error || `✅ 后台任务 ${result.taskId} 已完成`;
    if (!result.runId || text.includes("## 产物路径")) return text;
    return `${text}\n\n${formatCouncilArtifactSummary(result.runId)}`;
}

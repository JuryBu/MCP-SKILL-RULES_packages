import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_ROOT } from "./store.js";
import type { CorpusConversation, CorpusSearchRequest, CorpusSourceStatus, CorpusVerifiedIdentity } from "./conversation-corpus-types.js";
import { CORPUS_SOURCES, corpusConversationKey, resolveCorpusSources, type CorpusSource } from "./conversation-corpus-sources.js";
import { compileCorpusSearch, type CorpusConversationMatch } from "./conversation-corpus-search.js";

export type CorpusTaskPhase = "listing" | "scanning" | "finalizing" | "idle";
export type CorpusTaskState = "running" | "cancelling" | "completed" | "partial" | "cancelled" | "failed" | "resumable";

export interface CorpusSemanticVersion { query: string | null; provider: string | null; }
export interface CorpusPreparedEvidence {
    kind: "conversation_body_projection";
    conversationId: string;
    source?: CorpusSource;
    sourceRevision: string;
    cacheGeneration?: string;
    complete: boolean;
    sourceBytes: number;
    commitPath?: string;
}

export interface CorpusTaskCommit {
    revision: number;
    conversationId: string;
    source?: CorpusSource;
    complete: boolean;
    result: CorpusConversationMatch | null;
    scannedMessages: number;
    mirrorMessagesSkipped: number;
    sourceBytes: number;
    warnings: string[];
    error?: string;
    changed: boolean;
    queryComputeMs?: number;
    semanticVersion?: CorpusSemanticVersion;
    prepared?: CorpusPreparedEvidence;
    unverified?: boolean;
    verifiedIdentity?: CorpusVerifiedIdentity;
}

export interface CorpusTaskCoverage {
    scope: "frozen_candidates";
    discoveryComplete: boolean;
    complete: boolean;
    candidateConversations: number;
    scannedConversations: number;
    committedConversations: number;
    partialConversations: number;
    errorConversations: number;
    pendingConversations: number;
    scannedMessages: number;
    mirrorMessagesSkipped: number;
    sourceBytes: number;
    warnings: string[];
    errors: Array<{ source?: CorpusSource; conversationId: string; message: string }>;
    sourceStatuses: CorpusSourceStatus[];
}

export interface CorpusTaskStoredState {
    version: 1;
    taskId: string;
    ownerId: string;
    requestHash: string;
    secret: string;
    status: CorpusTaskState;
    phase: CorpusTaskPhase;
    revision: number;
    discoveryComplete: boolean;
    createdAt: string;
    updatedAt: string;
    snapshotId?: string;
    snapshotHash?: string;
    error?: string;
    checkpointEveryMessages: number;
    checkpointIntervalMs: number;
    computeMs: number;
    semanticVersion?: CorpusSemanticVersion;
    commitBatchSize?: number;
    dataChains?: CorpusSource[];
    sourceStatuses?: CorpusSourceStatus[];
}

export interface CorpusTaskSnapshot {
    snapshotId: string;
    revision: number;
    status: CorpusTaskState;
    results: CorpusConversationMatch[];
    coverage: CorpusTaskCoverage;
    semanticVersion?: CorpusSemanticVersion;
    prepared?: CorpusPreparedEvidence;
}

export interface CorpusTaskLoaded {
    directory: string;
    state: CorpusTaskStoredState;
    request: CorpusSearchRequest;
    candidates: CorpusConversation[];
    commits: CorpusTaskCommit[];
    records: Map<string, CorpusTaskCommit>;
}

interface TaskLease { pid: number; token: string; }

interface CorpusCommitFile { filename: string; firstRevision: number; lastRevision: number; }
interface CorpusCommitBatch {
    version: 1;
    taskId: string;
    ownerId: string;
    requestHash: string;
    firstRevision: number;
    lastRevision: number;
    commits: CorpusTaskCommit[];
}

const revisionName = (revision: number): string => String(revision).padStart(12, "0");

async function corpusCommitFiles(directory: string): Promise<CorpusCommitFile[]> {
    return (await fs.readdir(path.join(directory, "commits"))).flatMap(filename => {
        const match = /^(\d{12})(?:-(\d{12})\.batch)?\.json$/.exec(filename);
        return match ? [{ filename, firstRevision: Number(match[1]), lastRevision: Number(match[2] ?? match[1]) }] : [];
    }).sort((left, right) => left.firstRevision - right.firstRevision || left.lastRevision - right.lastRevision);
}

function validateCommit(commit: CorpusTaskCommit, revision: number): void {
    const source = corpusCommitSource(commit);
    const identity = commit?.verifiedIdentity;
    const verified = Boolean(identity && identity.authority === "devin-sqlite" && identity.source === "windsurf" && source === identity.source
        && typeof identity.canonicalId === "string" && identity.canonicalId && Array.isArray(identity.aliases)
        && identity.aliases.every(alias => typeof alias === "string") && identity.aliases.includes(commit.conversationId)
        && identity.aliases.includes(identity.canonicalId) && /^[a-f0-9]{64}$/u.test(identity.evidence)
        && typeof identity.sourceRevision === "string" && identity.sourceRevision
        && (!commit.result || (commit.result.conversation?.id === identity.canonicalId
            && commit.result.conversation.canonicalId === identity.canonicalId && commit.result.sourceRevision === identity.sourceRevision))
        && (!commit.prepared || (commit.prepared.conversationId === identity.canonicalId && commit.prepared.sourceRevision === identity.sourceRevision)));
    if (!commit || commit.revision !== revision || typeof commit.conversationId !== "string" || !commit.conversationId
        || !CORPUS_SOURCES.includes(source)
        || (identity && !verified)
        || (commit.result && ((!verified && commit.result.conversation?.id !== commit.conversationId) || commit.result.conversation.source !== source))
        || (commit.prepared && ((!verified && commit.prepared.conversationId !== commit.conversationId) || (commit.prepared.source ?? "codex") !== source))) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task commit identity is invalid");
    }
    if (commit.semanticVersion && [commit.semanticVersion.query, commit.semanticVersion.provider]
        .some(value => value !== null && (typeof value !== "string" || !value.trim()))) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task commit semantic version is invalid");
    }
}

function validateCommitSource(state: CorpusTaskStoredState, commit: CorpusTaskCommit): void {
    const sources = state.dataChains ?? ["codex"];
    if (!sources.includes(corpusCommitSource(commit)) || (commit.source === undefined && (sources.length !== 1 || sources[0] !== "codex"))) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task commit does not identify a bound source");
    }
}

export function corpusCommitSource(commit: Pick<CorpusTaskCommit, "source"> | null | undefined): CorpusSource {
    return commit?.source ?? "codex";
}

export function corpusCommitKey(commit: Pick<CorpusTaskCommit, "source" | "conversationId">): string {
    return corpusConversationKey({ source: corpusCommitSource(commit), id: commit.conversationId });
}

export function corpusPreparationDirectory(options: { ownerId: string; root?: string; conversationId: string; source: CorpusSource }): string {
    const base = path.join(corpusOwnerDirectory(options), "preparations");
    const identity = options.source === "codex" ? options.conversationId : corpusConversationKey({ source: options.source, id: options.conversationId });
    const hash = crypto.createHash("sha256").update(identity).digest("hex");
    return options.source === "codex" ? path.join(base, hash) : path.join(base, options.source, hash);
}

export function corpusTaskSources(request: CorpusSearchRequest): CorpusSource[] {
    return request.dataChains === undefined ? ["codex"] : resolveCorpusSources({ dataChains: request.dataChains });
}

export function validateCorpusSourceStatuses(statuses: CorpusSourceStatus[], sources: CorpusSource[]): void {
    if (!Array.isArray(statuses) || new Set(statuses.map(status => status?.source)).size !== statuses.length
        || statuses.some(status => !status || !sources.includes(status.source) || !["ok", "partial", "error"].includes(status.status)
            || !Number.isInteger(status.candidateCount) || status.candidateCount < 0 || !Array.isArray(status.warnings)
            || status.warnings.some(warning => typeof warning !== "string") || (status.error !== undefined && typeof status.error !== "string"))) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus source coverage is invalid");
    }
}

async function readCommitFile(task: Pick<CorpusTaskLoaded, "directory" | "state">, file: CorpusCommitFile): Promise<CorpusTaskCommit[]> {
    try {
        if (file.firstRevision < 1 || file.lastRevision < file.firstRevision || file.lastRevision - file.firstRevision >= 32) {
            throw new Error("Invalid commit file range");
        }
        const value = await readCorpusJson<CorpusTaskCommit | CorpusCommitBatch>(path.join(task.directory, "commits", file.filename));
        let commits: CorpusTaskCommit[];
        if (file.filename.endsWith(".batch.json")) {
            const batch = value as CorpusCommitBatch;
            if (batch.version !== 1 || batch.taskId !== task.state.taskId || batch.ownerId !== task.state.ownerId
                || batch.requestHash !== task.state.requestHash || batch.firstRevision !== file.firstRevision
                || batch.lastRevision !== file.lastRevision || !Array.isArray(batch.commits)
                || batch.commits.length !== file.lastRevision - file.firstRevision + 1) throw new Error("Invalid commit batch identity");
            commits = batch.commits;
        } else commits = [value as CorpusTaskCommit];
        commits.forEach((commit, index) => { validateCommit(commit, file.firstRevision + index); validateCommitSource(task.state, commit); });
        return commits;
    } catch {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task commit file is missing or invalid");
    }
}

export async function writeCorpusTaskCommits(task: Pick<CorpusTaskLoaded, "directory" | "state">, commits: CorpusTaskCommit[]): Promise<void> {
    if (!commits.length || commits.length > 32) throw new Error("Corpus commit batch must contain 1 to 32 entries");
    const firstRevision = commits[0]!.revision;
    commits.forEach((commit, index) => { validateCommit(commit, firstRevision + index); validateCommitSource(task.state, commit); });
    if (firstRevision !== task.state.revision + 1) throw new Error("Corpus commit batch must extend the durable revision");
    const lastRevision = commits.at(-1)!.revision;
    const filename = commits.length === 1 ? `${revisionName(firstRevision)}.json`
        : `${revisionName(firstRevision)}-${revisionName(lastRevision)}.batch.json`;
    const value: CorpusTaskCommit | CorpusCommitBatch = commits.length === 1 ? commits[0]! : {
        version: 1, taskId: task.state.taskId, ownerId: task.state.ownerId, requestHash: task.state.requestHash,
        firstRevision, lastRevision, commits,
    };
    const target = path.join(task.directory, "commits", filename);
    try { await writeCorpusJson(target, value, true); }
    catch (error) {
        const hash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
        try { await readCorpusJson(target, hash); }
        catch { throw error; }
    }
}

export async function readCorpusTaskCommitRange(task: Pick<CorpusTaskLoaded, "directory" | "state">, firstRevision: number, lastRevision: number): Promise<CorpusTaskCommit[]> {
    if (lastRevision < firstRevision) return [];
    const files = (await corpusCommitFiles(task.directory)).filter(file => file.lastRevision >= firstRevision && file.firstRevision <= lastRevision);
    const commits: CorpusTaskCommit[] = [];
    for (let offset = 0; offset < files.length; offset += 16) {
        const batch = await Promise.all(files.slice(offset, offset + 16).map(file => readCommitFile(task, file)));
        for (const entries of batch) for (const commit of entries) {
            if (commit.revision < firstRevision || commit.revision > lastRevision) continue;
            if (commit.revision !== firstRevision + commits.length) throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus revision range is not contiguous");
            commits.push(commit);
        }
    }
    if (commits.length !== lastRevision - firstRevision + 1) throw corpusTaskError("CORPUS_TASK_CORRUPT", "Requested corpus revision history is missing");
    return commits;
}

export function corpusTaskError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

export function corpusOwnerHash(ownerId: string): string {
    if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 4096) throw corpusTaskError("CORPUS_OWNER_REQUIRED", "A stable nonempty ownerId is required");
    return crypto.createHash("sha256").update(ownerId).digest("hex");
}

export function corpusOwnerDirectory(options: { ownerId: string; root?: string }): string {
    return path.join(path.resolve(options.root ?? path.join(DATA_ROOT, "conversation-corpus-search")), corpusOwnerHash(options.ownerId));
}

export function corpusTaskDirectory(options: { ownerId: string; taskId: string; root?: string }): string {
    const directory = corpusOwnerDirectory(options);
    if (!/^corpus-[a-f0-9-]{36}$/.test(options.taskId)) throw corpusTaskError("CORPUS_TASK_NOT_FOUND", "Corpus task not found for this owner");
    return path.join(directory, options.taskId);
}

export async function writeCorpusJson(filename: string, value: unknown, directoryPrepared = false): Promise<void> {
    if (!directoryPrepared) await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    let published = false;
    try {
        await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
        await fs.rename(temporary, filename);
        published = true;
    } finally {
        if (!published) await fs.rm(temporary, { force: true });
    }
}

export async function readCorpusJson<Type>(filename: string, expectedHash?: string): Promise<Type> {
    const text = await fs.readFile(filename, "utf8");
    if (expectedHash && crypto.createHash("sha256").update(text).digest("hex") !== expectedHash) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task snapshot integrity check failed");
    }
    return JSON.parse(text) as Type;
}

function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function corpusLeaseIsLive(directory: string): Promise<boolean> {
    try {
        const lease = await readCorpusJson<TaskLease>(path.join(directory, "lease.json"));
        if (!Number.isInteger(lease.pid) || lease.pid < 1 || typeof lease.token !== "string" || !lease.token) {
            throw corpusTaskError("CORPUS_LEASE_UNCERTAIN", "Corpus lease ownership cannot be verified");
        }
        return processAlive(lease.pid);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export async function acquireCorpusLease(directory: string): Promise<() => Promise<void>> {
    const filename = path.join(directory, "lease.json");
    const token = crypto.randomUUID();
    const create = async (): Promise<void> => {
        const handle = await fs.open(filename, "wx");
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
        catch (error) { await fs.rm(filename, { force: true }); throw error; }
        finally { await handle.close(); }
    };
    try { await create(); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await corpusLeaseIsLive(directory)) throw corpusTaskError("CORPUS_TASK_RUNNING", "Corpus task is already running");
        const recoveryPath = path.join(directory, "lease-recovery.json");
        let recovery;
        try { recovery = await fs.open(recoveryPath, "wx"); }
        catch { throw corpusTaskError("CORPUS_TASK_RUNNING", "Corpus task lease recovery is already in progress"); }
        try {
            if (await corpusLeaseIsLive(directory)) throw corpusTaskError("CORPUS_TASK_RUNNING", "Corpus task is already running");
            await fs.rm(filename, { force: true });
            await create();
        } finally {
            await recovery.close();
            await fs.rm(recoveryPath, { force: true });
        }
    }
    return async () => {
        try {
            const lease = await readCorpusJson<TaskLease>(filename);
            if (lease.token === token) await fs.rm(filename, { force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    };
}

export async function loadCorpusTask(options: { ownerId: string; taskId: string; root?: string }, preferSnapshot = false): Promise<CorpusTaskLoaded> {
    const directory = corpusTaskDirectory(options);
    let state: CorpusTaskStoredState;
    try { state = await readCorpusJson<CorpusTaskStoredState>(path.join(directory, "state.json")); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw corpusTaskError("CORPUS_TASK_NOT_FOUND", "Corpus task not found for this owner");
        throw error;
    }
    if (state.version !== 1 || state.ownerId !== options.ownerId || state.taskId !== options.taskId) {
        throw corpusTaskError("CORPUS_TASK_NOT_FOUND", "Corpus task not found for this owner");
    }
    if (!Number.isInteger(state.revision) || state.revision < 0 || (state.snapshotId && !/^snapshot-[a-f0-9-]{36}$/.test(state.snapshotId))
        || (state.commitBatchSize !== undefined && (!Number.isInteger(state.commitBatchSize) || state.commitBatchSize < 1 || state.commitBatchSize > 32))) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task revision or snapshot identity is invalid");
    }
    let request = await readCorpusJson<CorpusSearchRequest>(path.join(directory, "request.json"));
    if (crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex") !== state.requestHash) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task request integrity check failed");
    }
    let sources: CorpusSource[];
    try { sources = corpusTaskSources(request); }
    catch { throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task sources are invalid"); }
    try {
        if (state.dataChains !== undefined && JSON.stringify(resolveCorpusSources({ dataChains: state.dataChains }).sort()) !== JSON.stringify([...sources].sort())) {
            throw new Error("Source binding changed");
        }
    } catch { throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task source binding changed"); }
    state.dataChains = sources;
    if (state.sourceStatuses !== undefined) {
        validateCorpusSourceStatuses(state.sourceStatuses, sources);
        if (state.sourceStatuses.length !== sources.length) throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task source coverage is incomplete");
    }
    try { request = compileCorpusSearch({ ...request, dataChains: sources, sourceFailureMode: request.sourceFailureMode ?? "warn" }).request; }
    catch { throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task request is invalid"); }
    if (preferSnapshot && state.snapshotId && !["running", "cancelling", "resumable"].includes(state.status)) {
        return { directory, state, request, candidates: [], commits: [], records: new Map() };
    }
    const candidates = state.discoveryComplete ? await readCorpusJson<CorpusConversation[]>(path.join(directory, "candidates.json")) : [];
    if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || !sources.includes(candidate.source)
        || typeof candidate.id !== "string" || !candidate.id || typeof candidate.workspace !== "string")) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task candidates have invalid source identities");
    }
    const candidateIds = new Set(candidates.map(corpusConversationKey));
    if (candidateIds.size !== candidates.length) throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task has duplicate candidate identities");
    const files = await corpusCommitFiles(directory);
    const commits: CorpusTaskCommit[] = [];
    const records = new Map<string, CorpusTaskCommit>();
    for (let offset = 0; offset < files.length; offset += 16) {
        const batch = await Promise.all(files.slice(offset, offset + 16).map(file => readCommitFile({ directory, state }, file)));
        for (const commit of batch.flat()) {
            if (commit.revision !== commits.length + 1 || !candidateIds.has(corpusCommitKey(commit))) {
                throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task commit sequence or candidate identity is invalid");
            }
            commits.push(commit);
            records.set(corpusCommitKey(commit), commit);
        }
    }
    if (state.revision > commits.length) {
        throw corpusTaskError("CORPUS_TASK_CORRUPT", "Corpus task state references missing commits or an invalid snapshot");
    }
    state.revision = commits.at(-1)?.revision ?? 0;
    state.computeMs = Math.max(state.computeMs, commits.at(-1)?.queryComputeMs ?? 0);
    if ((state.status === "running" || state.status === "cancelling") && !(await corpusLeaseIsLive(directory))) {
        state.status = "resumable";
        state.phase = "idle";
    }
    return { directory, state, request, candidates, commits, records };
}

export function corpusSemanticVersionsEqual(left?: CorpusSemanticVersion, right?: CorpusSemanticVersion): boolean {
    return (left?.query ?? null) === (right?.query ?? null) && (left?.provider ?? null) === (right?.provider ?? null);
}

export function corpusCurrentRecords(task: CorpusTaskLoaded): CorpusTaskCommit[] {
    return [...task.records.values()].filter(record => corpusSemanticVersionsEqual(record.semanticVersion, task.state.semanticVersion));
}

export function corpusResultRecords(task: CorpusTaskLoaded): CorpusTaskCommit[] {
    const seen = new Set<string>();
    return corpusCurrentRecords(task).filter(record => {
        const identity = record.verifiedIdentity;
        const result = record.result;
        if (!record.complete || record.unverified || !result || result.provisional || !identity
            || identity.authority !== "devin-sqlite" || identity.source !== corpusCommitSource(record)
            || result.conversation.source !== identity.source || result.conversation.id !== identity.canonicalId
            || result.conversation.canonicalId !== identity.canonicalId || !identity.aliases.includes(record.conversationId)
            || !identity.evidence || !identity.sourceRevision) return true;
        const key = JSON.stringify([identity.source, identity.canonicalId, identity.evidence, identity.sourceRevision,
            { ...result, conversation: { source: identity.source, id: identity.canonicalId }, warnings: [] }]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function corpusCoverage(task: CorpusTaskLoaded): CorpusTaskCoverage {
    const records = corpusCurrentRecords(task);
    const committed = records.filter(record => record.complete).length;
    const errors = records.filter(record => record.error).map(record => ({ source: corpusCommitSource(record), conversationId: record.conversationId, message: record.error! }));
    const partial = records.filter(record => !record.complete && !record.error).length;
    const sourceStatuses = corpusTaskSources(task.request).map((source): CorpusSourceStatus => {
        const status = task.state.sourceStatuses?.find(status => status.source === source);
        const sourceRecords = records.filter(record => corpusCommitSource(record) === source);
        const candidates = task.candidates.filter(candidate => candidate.source === source);
        const error = status?.error ?? (sourceRecords.filter(record => record.error).map(record => `${record.conversationId}: ${record.error}`).join("; ") || undefined);
        return {
            source, candidateCount: status?.candidateCount ?? candidates.length,
            status: status?.status === "error" ? "error" : status?.status === "partial" || sourceRecords.some(record => !record.complete) ? "partial" : "ok",
            warnings: [...new Set([...(status?.warnings ?? []), ...candidates.flatMap(candidate => candidate.sourceWarnings ?? []), ...sourceRecords.flatMap(record => record.warnings)])],
            ...(error ? { error } : {}),
        };
    });
    return {
        scope: "frozen_candidates", discoveryComplete: task.state.discoveryComplete,
        complete: task.state.discoveryComplete && committed === task.candidates.length && !task.state.error && sourceStatuses.every(status => status.status === "ok"),
        candidateConversations: task.candidates.length, scannedConversations: records.length, committedConversations: committed,
        partialConversations: partial, errorConversations: errors.length,
        pendingConversations: task.candidates.length - committed - partial - errors.length,
        scannedMessages: records.reduce((total, record) => total + record.scannedMessages, 0),
        mirrorMessagesSkipped: records.reduce((total, record) => total + record.mirrorMessagesSkipped, 0),
        sourceBytes: records.reduce((total, record) => total + record.sourceBytes, 0),
        warnings: [...new Set(sourceStatuses.flatMap(status => [...status.warnings, ...(status.error ? [`${status.source}: ${status.error}`] : [])]))], errors, sourceStatuses,
    };
}

export function corpusCursor(task: CorpusTaskLoaded, snapshotId: string, offset: number, snapshotHash: string): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, taskId: task.state.taskId, owner: corpusOwnerHash(task.state.ownerId), requestHash: task.state.requestHash,
        dataChains: corpusTaskSources(task.request), snapshotId, snapshotHash, offset })).toString("base64url");
    const signature = crypto.createHmac("sha256", task.state.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

export function parseCorpusCursor(task: CorpusTaskLoaded, cursor: string): { snapshotId: string; snapshotHash: string; offset: number } {
    try {
        if (typeof cursor !== "string" || cursor.length > 4096) throw new Error("Malformed cursor");
        const [payload, signature, extra] = cursor.split(".");
        const expected = crypto.createHmac("sha256", task.state.secret).update(payload).digest();
        const actual = Buffer.from(signature, "base64url");
        if (extra || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("Invalid signature");
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (decoded.version !== 1 || decoded.taskId !== task.state.taskId || decoded.owner !== corpusOwnerHash(task.state.ownerId)
            || !/^snapshot-[a-f0-9-]{36}$/.test(decoded.snapshotId) || !/^[a-f0-9]{64}$/.test(decoded.snapshotHash)
            || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error("Invalid cursor identity");
        if ((decoded.requestHash !== undefined && decoded.requestHash !== task.state.requestHash)
            || (decoded.dataChains !== undefined && JSON.stringify(decoded.dataChains) !== JSON.stringify(corpusTaskSources(task.request)))
            || (decoded.dataChains === undefined && JSON.stringify(corpusTaskSources(task.request)) !== '["codex"]')) throw new Error("Invalid cursor sources");
        return decoded;
    } catch { throw corpusTaskError("CORPUS_CURSOR_INVALID", "Cursor does not belong to this task, owner, or final snapshot"); }
}

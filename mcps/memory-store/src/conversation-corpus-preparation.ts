import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorpusProvider, CorpusSearchRequest } from "./conversation-corpus-types.js";
import { getCorpusSearchStatus, resumeCorpusSearch, startCorpusSearch, type CorpusSearchStatus } from "./conversation-corpus-task.js";
import {
    acquireCorpusLease, corpusOwnerDirectory, corpusTaskError, readCorpusJson, writeCorpusJson,
    type CorpusTaskStoredState,
} from "./conversation-corpus-task-store.js";

export interface StartCorpusPreparationOptions {
    ownerId: string;
    conversationId: string;
    provider: CorpusProvider;
    root?: string;
}

interface PreparationIndex {
    version: 1 | 2;
    ownerId: string;
    conversationId: string;
    taskId: string;
}

const starts = new Map<string, Promise<CorpusSearchStatus>>();
const active = (status: string): boolean => ["running", "cancelling", "resumable"].includes(status);
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

async function lock(directory: string): Promise<() => Promise<void>> {
    await fs.mkdir(directory, { recursive: true });
    const deadline = Date.now() + 5000;
    for (;;) {
        try { return await acquireCorpusLease(directory); }
        catch (error) {
            if (codeOf(error) !== "CORPUS_TASK_RUNNING" && codeOf(error) !== "CORPUS_LEASE_UNCERTAIN" && !(error instanceof SyntaxError)) throw error;
            if (Date.now() >= deadline) throw error;
            await sleep(10);
        }
    }
}

async function reusableTask(options: StartCorpusPreparationOptions, directory: string): Promise<CorpusSearchStatus | undefined> {
    let index: PreparationIndex | undefined;
    try { index = await readCorpusJson<PreparationIndex>(path.join(directory, "index.json")); }
    catch (error) { if (codeOf(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if ((index?.version === 2 || index?.version === 1) && index.ownerId === options.ownerId && index.conversationId === options.conversationId
        && /^corpus-[a-f0-9-]{36}$/.test(index.taskId)) {
        try {
            const status = await getCorpusSearchStatus({ ...options, taskId: index.taskId });
            if (status.request.purpose !== "prepare" || status.request.conversationIds?.length !== 1
                || status.request.conversationIds[0] !== options.conversationId) throw corpusTaskError("CORPUS_TASK_CORRUPT", "Preparation index points to a different request");
            if (active(status.status)) return status;
            if (index.version === 2) {
                try { await fs.stat(path.join(directory, "creating.json")); }
                catch (error) { if (codeOf(error) === "ENOENT") return undefined; throw error; }
            }
        } catch (error) { if (codeOf(error) !== "CORPUS_TASK_NOT_FOUND") throw error; }
    }
    const ownerDirectory = corpusOwnerDirectory(options);
    const candidates: CorpusSearchStatus[] = [];
    for (const entry of await fs.readdir(ownerDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^corpus-[a-f0-9-]{36}$/.test(entry.name)) continue;
        const taskDirectory = path.join(ownerDirectory, entry.name);
        let request: CorpusSearchRequest;
        let state: CorpusTaskStoredState;
        try {
            request = await readCorpusJson<CorpusSearchRequest>(path.join(taskDirectory, "request.json"));
            if (request.purpose !== "prepare" || request.conversationIds?.length !== 1 || request.conversationIds[0] !== options.conversationId) continue;
            state = await readCorpusJson<CorpusTaskStoredState>(path.join(taskDirectory, "state.json"));
        } catch (error) { if (codeOf(error) === "ENOENT") continue; throw error; }
        if (active(state.status)) candidates.push(await getCorpusSearchStatus({ ...options, taskId: entry.name }));
    }
    if (candidates.length > 1) throw corpusTaskError("CORPUS_PREPARATION_CONFLICT", "Multiple active preparation tasks require reconciliation");
    return candidates[0];
}

async function start(options: StartCorpusPreparationOptions, directory: string): Promise<CorpusSearchStatus> {
    const release = await lock(directory);
    try {
        const previous = await reusableTask(options, directory);
        if (!previous) await writeCorpusJson(path.join(directory, "creating.json"), {
            ownerId: options.ownerId, conversationId: options.conversationId, createdAt: new Date().toISOString(),
        });
        const status = previous?.status === "resumable"
            ? await resumeCorpusSearch({ ...options, taskId: previous.taskId })
            : previous ?? await startCorpusSearch({ ...options, request: {
                purpose: "prepare", conversationIds: [options.conversationId], messageRoles: ["user", "assistant", "subagent"],
            } });
        try {
            await writeCorpusJson(path.join(directory, "index.json"), {
                version: 2, ownerId: options.ownerId, conversationId: options.conversationId, taskId: status.taskId,
            } satisfies PreparationIndex);
            await fs.rm(path.join(directory, "creating.json"), { force: true });
        } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
                taskId: status.taskId, ownerId: options.ownerId,
            });
        }
        return status;
    } finally { await release(); }
}

export async function startCorpusPreparation(options: StartCorpusPreparationOptions): Promise<CorpusSearchStatus> {
    options = { ...options };
    const ownerDirectory = corpusOwnerDirectory(options);
    if (typeof options.conversationId !== "string" || !options.conversationId.trim() || options.conversationId.length > 4096) {
        throw new Error("A nonempty target conversationId is required for corpus preparation");
    }
    const directory = path.join(ownerDirectory, "preparations", crypto.createHash("sha256").update(options.conversationId).digest("hex"));
    const pending = starts.get(directory);
    if (pending) return pending;
    const promise = start(options, directory);
    starts.set(directory, promise);
    try { return await promise; }
    finally { if (starts.get(directory) === promise) starts.delete(directory); }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const IDLE_EXIT_TIMEOUT_MS = 3_600_000;
const states = ['starting', 'ready', 'sleeping', 'startup-failed', 'stopped'] as const;
const reasons = ['startup', 'idle-timeout', 'startup-error', 'stdin-end', 'stdin-close', 'stdin-error', 'parent-exit', 'duplicate-retirement', 'signal-int', 'signal-term', 'unknown'] as const;
export type RuntimeState = typeof states[number];
export type ExitReason = typeof reasons[number];
type PreviousExit = { reason: ExitReason; at: string | null; pid: number };
export interface RuntimeSnapshot {
    schemaVersion: 1;
    instanceId: string;
    state: RuntimeState;
    reason: ExitReason;
    pid: number;
    parentPid: number;
    startedAt: string;
    updatedAt: string;
    startupMs: number | null;
    previousExit: PreviousExit | null;
}

export function runtimeStateDirectory(): string {
    const installation = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
    const key = createHash('sha256').update(installation).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), 'mcp-web-fetcher-runtime', key);
}

export function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readRuntimeState(file: string): RuntimeSnapshot | null {
    try {
        if (fs.statSync(file).size > 8192) return null;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.schemaVersion !== 1 || typeof value.instanceId !== 'string' || value.instanceId.length === 0 || value.instanceId.length > 64
            || !states.includes(value.state) || !reasons.includes(value.reason)
            || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.parentPid) || value.parentPid <= 0
            || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
            || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
            || (value.startupMs !== null && (!Number.isFinite(value.startupMs) || value.startupMs < 0))) return null;
        const expectedReason = value.state === 'sleeping' ? 'idle-timeout' : value.state === 'startup-failed' ? 'startup-error'
            : ['starting', 'ready'].includes(value.state) ? 'startup' : null;
        if (expectedReason ? value.reason !== expectedReason : ['startup', 'idle-timeout', 'startup-error'].includes(value.reason)) return null;
        const prior = value.previousExit;
        if (prior !== null && (!prior || !reasons.includes(prior.reason) || !Number.isSafeInteger(prior.pid) || prior.pid <= 0
            || (prior.at !== null && (typeof prior.at !== 'string' || !Number.isFinite(Date.parse(prior.at)))))) return null;
        return {
            schemaVersion: 1, instanceId: value.instanceId, state: value.state, reason: value.reason,
            pid: value.pid, parentPid: value.parentPid, startedAt: value.startedAt, updatedAt: value.updatedAt,
            startupMs: value.startupMs,
            previousExit: prior ? { reason: prior.reason, at: prior.at, pid: prior.pid } : null,
        };
    } catch { return null; }
}

export function shouldExitForIdle(idleMs: number, activeRequests: number): boolean {
    return activeRequests === 0 && idleMs > IDLE_EXIT_TIMEOUT_MS;
}

export class RuntimeLifecycle {
    private snapshot: RuntimeSnapshot;
    private firstSuccessPending = true;
    private persistence: 'saved' | 'unavailable' | 'other-instance' = 'saved';
    private ownsState = false;
    private superseded = false;
    private readonly now: () => number;
    private readonly alive: (pid: number) => boolean;

    constructor(readonly stateFile: string, options: { pid?: number; parentPid?: number; now?: () => number; alive?: (pid: number) => boolean; startedAtMs?: number } = {}) {
        this.now = options.now ?? Date.now;
        this.alive = options.alive ?? isProcessAlive;
        const previous = readRuntimeState(stateFile);
        const parentPid = options.parentPid ?? process.ppid;
        const matching = previous?.parentPid === parentPid ? previous : null;
        const terminal = matching && ['sleeping', 'stopped', 'startup-failed'].includes(matching.state);
        const prior = terminal ? { reason: matching.reason, at: matching.updatedAt, pid: matching.pid }
            : matching && !this.alive(matching.pid) ? { reason: 'unknown' as const, at: null, pid: matching.pid } : null;
        this.snapshot = {
            schemaVersion: 1, instanceId: randomUUID(), state: 'starting', reason: 'startup',
            pid: options.pid ?? process.pid, parentPid,
            startedAt: new Date(options.startedAtMs ?? this.now() - Math.round(process.uptime() * 1000)).toISOString(),
            updatedAt: new Date(this.now()).toISOString(), startupMs: null, previousExit: prior,
        };
        this.persist();
    }

    ready(): void {
        this.snapshot.state = 'ready';
        this.snapshot.startupMs = Math.max(0, this.now() - Date.parse(this.snapshot.startedAt));
        this.persist();
    }

    exit(reason: ExitReason): void {
        this.snapshot.state = reason === 'idle-timeout' ? 'sleeping' : reason === 'startup-error' ? 'startup-failed' : 'stopped';
        this.snapshot.reason = reason;
        this.persist();
    }

    status() {
        return { ...this.snapshot, previousExit: this.snapshot.previousExit ? { ...this.snapshot.previousExit } : null, persistence: this.persistence };
    }

    decorate<Result>(result: Result): Result {
        if (!result || typeof result !== 'object') return result;
        const value = result as Record<string, any>;
        const first = this.firstSuccessPending && value.isError !== true && Array.isArray(value.content);
        if (first) this.firstSuccessPending = false;
        const resumed = first && this.persistence !== 'other-instance' && this.snapshot.previousExit?.reason === 'idle-timeout';
        const text = `后端已从空闲休眠自动唤醒，启动就绪用时 ${this.snapshot.startupMs ?? 0} ms；原工具结果继续返回。`;
        return {
            ...value,
            content: resumed ? [...value.content, { type: 'text', text }] : value.content,
            _meta: { ...(value._meta ?? {}), webFetcherLifecycle: { ...this.status(), resumedFromIdle: resumed } },
        } as Result;
    }

    private persist(): void {
        if (this.superseded) return;
        this.snapshot.updatedAt = new Date(this.now()).toISOString();
        const temporary = `${this.stateFile}.${this.snapshot.instanceId}.tmp`;
        try {
            const existing = readRuntimeState(this.stateFile);
            if (existing && existing.instanceId !== this.snapshot.instanceId
                && (this.ownsState || Date.parse(existing.startedAt) > Date.parse(this.snapshot.startedAt) || (this.alive(existing.pid)
                    && (['starting', 'ready'].includes(existing.state) || Date.parse(existing.startedAt) >= Date.parse(this.snapshot.startedAt))))) {
                this.persistence = 'other-instance';
                this.superseded = true;
                return;
            }
            fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
            fs.writeFileSync(temporary, JSON.stringify(this.snapshot), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporary, this.stateFile);
            this.ownsState = true;
            this.persistence = 'saved';
        } catch {
            this.persistence = 'unavailable';
        } finally {
            try { fs.unlinkSync(temporary); } catch { }
        }
    }
}

let current: RuntimeLifecycle | undefined;
export function initializeRuntimeLifecycle(): RuntimeLifecycle {
    return current ??= new RuntimeLifecycle(process.env.WEB_FETCHER_RUNTIME_STATE_FILE
        || path.join(runtimeStateDirectory(), `${process.ppid}.json`));
}
export function getRuntimeLifecycle(): RuntimeLifecycle | undefined { return current; }
export function decorateRuntimeResult<Result>(result: Result): Result { return current?.decorate(result) ?? result; }

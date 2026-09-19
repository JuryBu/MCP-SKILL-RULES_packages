import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getRuntimeMemorySampler, type MemoryProvider, type MemorySnapshot } from './memory-sampler.js';

export interface PageAcquireOptions {
    ownerId: string;
    deadlineAt?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    estimatedMemoryMB?: number;
}

export interface PageLease {
    readonly id: string;
    readonly ownerId: string;
    markCreated(): boolean;
    markReady(): boolean;
    markClosing(): boolean;
    release(): boolean;
}

export interface PageAdmissionOptions {
    memoryProvider?: MemoryProvider;
    maxPages?: number;
    maxQueue?: number;
    queueTimeoutMs?: number;
    estimatedMemoryMB?: number;
    minPhysicalMB?: number;
    minCommitMB?: number;
    sampleMaxAgeMs?: number;
    startupWindowMs?: number;
    now?: () => number;
}

export interface PageAdmissionDecision {
    blockedBy: string | null;
    memoryMode: 'windows' | 'page_limit_only';
    warning?: string;
    sampleReason?: string;
    sampleAgeMs?: number;
    sourceId?: string;
    sequence?: number;
    physicalAvailableMB?: number;
    commitAvailableMB?: number;
    projectedPhysicalMB?: number;
    projectedCommitMB?: number;
    uncoveredMemoryMB: number;
    estimatedMemoryMB: number;
    minPhysicalMB: number;
    minCommitMB: number;
    slotsUsed: number;
    maxPages: number;
    queueWaitMs: number;
    pageCreated: false;
    mayHaveStarted: false;
}

export class PageAdmissionError extends Error {
    constructor(public readonly code: string, public readonly admissionDecision: PageAdmissionDecision) {
        super(`${code}: blockedBy=${admissionDecision.blockedBy}; pages=${admissionDecision.slotsUsed}/${admissionDecision.maxPages}; `
            + `queueWaitMs=${Math.round(admissionDecision.queueWaitMs)}; estimateMB=${admissionDecision.estimatedMemoryMB}; `
            + `physicalMB=${admissionDecision.physicalAvailableMB ?? 'unknown'}/${admissionDecision.projectedPhysicalMB ?? 'unknown'}; `
            + `commitMB=${admissionDecision.commitAvailableMB ?? 'unknown'}/${admissionDecision.projectedCommitMB ?? 'unknown'}; `
            + `sampleAgeMs=${admissionDecision.sampleAgeMs ?? 'unknown'}; pageCreated=false; mayHaveStarted=false`
            + (admissionDecision.sampleReason ? `; sampleReason=${admissionDecision.sampleReason}` : ''));
        this.name = 'PageAdmissionError';
    }
}

type LeaseState = 'reserved' | 'active' | 'closing';

interface LeaseRecord {
    id: string;
    ownerId: string;
    state: LeaseState;
    estimate: number;
    uncovered: boolean;
    grantSource?: string;
    grantSequence?: number;
    createdAt?: number;
    readyAt?: number;
}

interface Waiter {
    options: PageAcquireOptions;
    estimate: number;
    enqueuedAt: number;
    deadlineAt: number;
    resolve: (lease: PageLease) => void;
    reject: (error: Error) => void;
    abortListener?: () => void;
    lastDecision?: PageAdmissionDecision;
}

interface ClosingDebt {
    estimate: number;
    releasedAt: number;
}

function envNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return process.env[name]?.trim() && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite positive number`);
    return value;
}

export class PageAdmissionController {
    private readonly memory: MemoryProvider;
    private readonly now: () => number;
    private readonly maxPages: number;
    private readonly maxQueue: number;
    private readonly queueTimeoutMs: number;
    private readonly estimate: number;
    private readonly minPhysicalMB: number;
    private readonly minCommitMB: number;
    private readonly sampleMaxAgeMs: number;
    private readonly startupWindowMs: number;
    private readonly leases = new Map<string, LeaseRecord>();
    private closingDebts: ClosingDebt[] = [];
    private readonly waiters: Waiter[] = [];
    private readonly ownerTurns = new Map<string, number>();
    private turn = 0;
    private lastSample?: MemorySnapshot;
    private lastDecision?: PageAdmissionDecision;
    private timer?: ReturnType<typeof setTimeout>;
    private unsubscribe?: () => void;
    private draining = false;
    private disposed = false;

    constructor(options: PageAdmissionOptions = {}) {
        this.memory = options.memoryProvider ?? getRuntimeMemorySampler();
        this.now = options.now ?? (() => performance.now());
        this.maxPages = Math.min(64, Math.floor(positive(options.maxPages ?? envNumber('WEB_FETCHER_MAX_CONCURRENT_PAGES', envNumber('WEB_FETCHER_MAX_PAGES', 8)), 'maxPages')));
        this.maxQueue = Math.floor(positive(options.maxQueue ?? envNumber('WEB_FETCHER_PAGE_QUEUE_LIMIT', 32), 'maxQueue'));
        if (this.maxPages < 1 || this.maxQueue < 1) throw new RangeError('Page and queue limits must be at least one');
        this.queueTimeoutMs = positive(options.queueTimeoutMs ?? envNumber('WEB_FETCHER_PAGE_QUEUE_TIMEOUT_MS', 8000), 'queueTimeoutMs');
        this.estimate = positive(options.estimatedMemoryMB ?? envNumber('WEB_FETCHER_PAGE_ESTIMATE_MB', 256), 'estimatedMemoryMB');
        this.minPhysicalMB = positive(options.minPhysicalMB ?? envNumber('WEB_FETCHER_MIN_PHYSICAL_MB', 1024), 'minPhysicalMB');
        this.minCommitMB = positive(options.minCommitMB ?? envNumber('WEB_FETCHER_MIN_COMMIT_MB', 2048), 'minCommitMB');
        this.sampleMaxAgeMs = positive(options.sampleMaxAgeMs ?? 2000, 'sampleMaxAgeMs');
        this.startupWindowMs = positive(options.startupWindowMs ?? envNumber('WEB_FETCHER_PAGE_STARTUP_WINDOW_MS', 5000), 'startupWindowMs');
        this.unsubscribe = this.memory.subscribe?.(() => this.refresh());
    }

    acquire(options: PageAcquireOptions): Promise<PageLease> {
        if (!options.ownerId?.trim()) return Promise.reject(new TypeError('ownerId is required'));
        if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) return Promise.reject(new RangeError('deadlineAt must be finite monotonic milliseconds'));
        if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) return Promise.reject(new RangeError('timeoutMs must be nonnegative'));
        if (options.estimatedMemoryMB !== undefined && (!Number.isFinite(options.estimatedMemoryMB) || options.estimatedMemoryMB <= 0)) return Promise.reject(new RangeError('estimatedMemoryMB must be positive'));
        const enqueuedAt = this.now();
        const deadlineAt = Math.min(options.deadlineAt ?? Infinity, enqueuedAt + Math.min(options.timeoutMs ?? this.queueTimeoutMs, this.queueTimeoutMs));
        return new Promise<PageLease>((resolve, reject) => {
            const waiter: Waiter = { options, estimate: options.estimatedMemoryMB ?? this.estimate, enqueuedAt, deadlineAt, resolve, reject };
            if (this.disposed) return reject(this.error(waiter, 'page_admission_closed', 'controller_closed'));
            if (options.signal?.aborted) return reject(this.error(waiter, 'page_admission_cancelled', 'cancelled'));
            if (this.now() >= deadlineAt) return reject(this.error(waiter, 'page_admission_timeout', 'deadline'));
            this.refresh();
            if (this.waiters.length >= this.maxQueue) return reject(this.error(waiter, 'page_admission_queue_full', 'queue_full'));
            waiter.abortListener = () => {
                if (!this.remove(waiter)) return;
                reject(this.error(waiter, 'page_admission_cancelled', 'cancelled'));
                this.refresh();
            };
            options.signal?.addEventListener('abort', waiter.abortListener, { once: true });
            this.waiters.push(waiter);
            this.refresh();
        });
    }

    private readSample(): MemorySnapshot {
        try { return this.memory.snapshot(); }
        catch { return { valid: false, mode: 'windows', sourceId: 'unknown', sequence: 0, sampledAt: -Infinity, reason: 'memory_provider_failed' }; }
    }

    private fresh(sample: MemorySnapshot, now: number): boolean {
        return sample.valid && sample.mode === 'windows' && Number.isFinite(sample.sampledAt)
            && Number.isSafeInteger(sample.sequence) && sample.sequence >= 0 && !!sample.sourceId
            && sample.sampledAt <= now && now - sample.sampledAt <= this.sampleMaxAgeMs
            && typeof sample.lowMemory === 'boolean'
            && Number.isFinite(sample.physicalAvailableMB) && sample.physicalAvailableMB! >= 0
            && Number.isFinite(sample.commitAvailableMB) && sample.commitAvailableMB! >= 0;
    }

    private retireCovered(sample: MemorySnapshot, now: number): void {
        if (!this.fresh(sample, now)) return;
        for (const lease of this.leases.values()) {
            if (!lease.uncovered || lease.createdAt === undefined || lease.readyAt === undefined) continue;
            const coverageAfter = Math.max(lease.readyAt, lease.createdAt + this.startupWindowMs);
            if (sample.sampledAt > coverageAfter
                && (sample.sourceId !== lease.grantSource || sample.sequence > (lease.grantSequence ?? -1))) lease.uncovered = false;
        }
        this.closingDebts = this.closingDebts.filter(debt => sample.sampledAt <= debt.releasedAt);
    }

    private uncoveredMemory(): number {
        let total = this.closingDebts.reduce((sum, debt) => sum + debt.estimate, 0);
        for (const lease of this.leases.values()) if (lease.uncovered) total += lease.estimate;
        return total;
    }

    private decision(waiter: Waiter, sample: MemorySnapshot, now: number): PageAdmissionDecision {
        const uncoveredMemoryMB = this.uncoveredMemory();
        const unsupported = sample.mode === 'unsupported';
        const maxPages = unsupported ? Math.min(5, this.maxPages) : this.maxPages;
        const decision: PageAdmissionDecision = {
            blockedBy: null, memoryMode: unsupported ? 'page_limit_only' : 'windows',
            warning: unsupported ? 'Complete system memory sampling is unavailable; conservative page-only limit applies' : undefined,
            sampleReason: sample.reason, sampleAgeMs: Number.isFinite(sample.sampledAt) ? Math.max(0, now - sample.sampledAt) : undefined,
            sourceId: sample.sourceId, sequence: sample.sequence,
            physicalAvailableMB: sample.physicalAvailableMB, commitAvailableMB: sample.commitAvailableMB,
            uncoveredMemoryMB, estimatedMemoryMB: waiter.estimate,
            minPhysicalMB: this.minPhysicalMB, minCommitMB: this.minCommitMB,
            slotsUsed: this.leases.size, maxPages, queueWaitMs: Math.max(0, now - waiter.enqueuedAt),
            pageCreated: false, mayHaveStarted: false,
        };
        if (this.leases.size >= maxPages) decision.blockedBy = 'page_limit';
        if (unsupported) return decision;
        if (!this.fresh(sample, now)) {
            decision.blockedBy ??= sample.valid ? 'memory_sample_stale_or_incomplete' : 'memory_sample_unavailable';
            return decision;
        }
        decision.projectedPhysicalMB = sample.physicalAvailableMB! - uncoveredMemoryMB - waiter.estimate;
        decision.projectedCommitMB = sample.commitAvailableMB! - uncoveredMemoryMB - waiter.estimate;
        if (sample.lowMemory) decision.blockedBy ??= 'windows_low_memory';
        if (decision.projectedPhysicalMB < this.minPhysicalMB) decision.blockedBy ??= 'physical_memory';
        if (decision.projectedCommitMB < this.minCommitMB) decision.blockedBy ??= 'commit_memory';
        return decision;
    }

    private error(waiter: Waiter, code: string, blockedBy?: string): PageAdmissionError {
        const decision = this.decision(waiter, this.lastSample ?? {
            valid: false, mode: 'windows', sourceId: 'not_sampled', sequence: 0, sampledAt: -Infinity,
        }, this.now());
        decision.blockedBy = blockedBy ?? decision.blockedBy ?? waiter.lastDecision?.blockedBy ?? 'deadline';
        this.lastDecision = decision;
        return new PageAdmissionError(code, decision);
    }

    private remove(waiter: Waiter): boolean {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return false;
        this.waiters.splice(index, 1);
        if (waiter.abortListener) waiter.options.signal?.removeEventListener('abort', waiter.abortListener);
        return true;
    }

    refresh(): void {
        if (this.draining || this.disposed) return;
        this.draining = true;
        try {
            const sample = this.readSample();
            this.lastSample = sample;
            this.retireCovered(sample, this.now());
            for (const waiter of [...this.waiters]) {
                if (waiter.options.signal?.aborted || this.now() >= waiter.deadlineAt) {
                    this.remove(waiter);
                    waiter.reject(this.error(waiter, waiter.options.signal?.aborted ? 'page_admission_cancelled' : 'page_admission_timeout', waiter.options.signal?.aborted ? 'cancelled' : undefined));
                }
            }
            while (this.waiters.length) {
                const owners = [...new Set(this.waiters.map(waiter => waiter.options.ownerId))];
                const orderedOwners = owners.sort((left, right) => (this.ownerTurns.get(left) ?? 0) - (this.ownerTurns.get(right) ?? 0));
                let selected: Waiter | undefined;
                for (const owner of orderedOwners) {
                    const waiter = this.waiters.find(candidate => candidate.options.ownerId === owner)!;
                    waiter.lastDecision = this.decision(waiter, sample, this.now());
                    this.lastDecision = waiter.lastDecision;
                    if (!waiter.lastDecision.blockedBy) { selected = waiter; break; }
                }
                if (!selected) break;
                if (selected.options.signal?.aborted || this.now() >= selected.deadlineAt) {
                    this.remove(selected);
                    selected.reject(this.error(selected, selected.options.signal?.aborted ? 'page_admission_cancelled' : 'page_admission_timeout', selected.options.signal?.aborted ? 'cancelled' : 'deadline'));
                    continue;
                }
                this.remove(selected);
                const lease = this.reserve(selected, sample);
                this.ownerTurns.set(selected.options.ownerId, ++this.turn);
                selected.resolve(lease);
            }
        } finally {
            this.draining = false;
            const liveOwners = new Set([...this.waiters.map(waiter => waiter.options.ownerId), ...[...this.leases.values()].map(lease => lease.ownerId)]);
            for (const owner of this.ownerTurns.keys()) if (!liveOwners.has(owner)) this.ownerTurns.delete(owner);
            if (this.timer) clearTimeout(this.timer);
            this.timer = undefined;
            if (this.waiters.length) {
                const remaining = Math.min(...this.waiters.map(waiter => waiter.deadlineAt - this.now()));
                this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, Math.max(1, Math.min(250, remaining)));
            }
        }
    }

    private reserve(waiter: Waiter, sample: MemorySnapshot): PageLease {
        const record: LeaseRecord = {
            id: randomUUID(), ownerId: waiter.options.ownerId, state: 'reserved',
            estimate: waiter.estimate, uncovered: sample.mode !== 'unsupported',
            grantSource: sample.sourceId, grantSequence: sample.sequence,
        };
        this.leases.set(record.id, record);
        return Object.freeze({
            id: record.id, ownerId: record.ownerId,
            markCreated: () => {
                if (!this.leases.has(record.id)) return false;
                record.createdAt ??= this.now();
                if (record.state !== 'closing') record.state = 'active';
                return true;
            },
            markReady: () => {
                if (!this.leases.has(record.id) || record.createdAt === undefined || record.state === 'closing') return false;
                record.readyAt ??= this.now();
                this.refresh();
                return true;
            },
            markClosing: () => {
                if (!this.leases.has(record.id)) return false;
                record.state = 'closing';
                return true;
            },
            release: () => {
                if (!this.leases.delete(record.id)) return false;
                if (record.uncovered && record.createdAt !== undefined) this.closingDebts.push({ estimate: record.estimate, releasedAt: this.now() });
                this.refresh();
                return true;
            },
        });
    }

    stats() {
        const records = [...this.leases.values()];
        return {
            reserved: records.filter(lease => lease.state === 'reserved').length,
            active: records.filter(lease => lease.state === 'active').length,
            closing: records.filter(lease => lease.state === 'closing').length,
            queued: this.waiters.length, used: records.length,
            max: this.lastSample?.mode === 'unsupported' ? Math.min(5, this.maxPages) : this.maxPages,
            configuredMax: this.maxPages, uncoveredMemoryMB: this.uncoveredMemory(),
            lastBlockedBy: this.lastDecision?.blockedBy ?? null,
            lastDecision: this.lastDecision ? { ...this.lastDecision } : undefined,
            memoryMode: this.lastSample?.mode === 'unsupported' ? 'page_limit_only' : 'windows',
            warning: this.lastSample?.mode === 'unsupported' ? 'unsupported_platform_page_limit_only' : undefined,
            disposed: this.disposed,
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        for (const waiter of [...this.waiters]) {
            this.remove(waiter);
            waiter.reject(this.error(waiter, 'page_admission_closed', 'controller_closed'));
        }
    }
}

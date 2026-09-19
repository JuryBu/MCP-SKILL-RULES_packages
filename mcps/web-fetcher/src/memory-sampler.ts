import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export interface MemorySnapshot {
    valid: boolean;
    mode: 'windows' | 'unsupported';
    sourceId: string;
    sequence: number;
    sampledAt: number;
    physicalAvailableMB?: number;
    commitAvailableMB?: number;
    lowMemory?: boolean;
    reason?: string;
}

export interface MemoryProvider {
    snapshot(): MemorySnapshot;
    subscribe?(listener: () => void): () => void;
}

export class MemorySampleDecoder {
    private sequence = 0;
    private sourceTime = -Infinity;
    private anchor?: { source: number; local: number };

    constructor(private readonly sourceId: string) {}

    decode(line: string, now = performance.now(), wallNow = Date.now()): MemorySnapshot {
        const invalid = (reason: string): MemorySnapshot => ({
            valid: false, mode: 'windows', sourceId: this.sourceId,
            sequence: this.sequence, sampledAt: -Infinity, reason,
        });
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { return invalid('invalid_sample_json'); }
        if (!message || typeof message !== 'object') return invalid('invalid_sample');
        const sequence = message.sequence;
        const sourceTime = message.sourceMonotonicMs;
        const wallTime = message.sampledAtUnixMs;
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= this.sequence
            || typeof sourceTime !== 'number' || !Number.isFinite(sourceTime) || sourceTime <= this.sourceTime
            || typeof wallTime !== 'number' || !Number.isFinite(wallTime)) return invalid('sample_out_of_order');
        this.sequence = sequence;
        this.sourceTime = sourceTime;
        const transportAge = wallNow - wallTime;
        if (transportAge < 0 || !Number.isFinite(transportAge)) return invalid('sample_clock_mismatch');
        const wallMappedTime = now - Math.max(0, transportAge);
        if (!this.anchor) this.anchor = { source: sourceTime, local: wallMappedTime };
        const sampledAt = Math.min(wallMappedTime, this.anchor.local + sourceTime - this.anchor.source);
        const complete = message.valid === true && typeof message.lowMemory === 'boolean'
            && typeof message.highMemory === 'boolean'
            && typeof message.physicalAvailableMB === 'number' && Number.isFinite(message.physicalAvailableMB)
            && message.physicalAvailableMB >= 0
            && typeof message.commitAvailableMB === 'number' && Number.isFinite(message.commitAvailableMB)
            && message.commitAvailableMB >= 0;
        if (!complete) return invalid(typeof message.reason === 'string' ? message.reason.slice(0, 160) : 'incomplete_sample');
        return {
            valid: true, mode: 'windows', sourceId: this.sourceId, sequence, sampledAt,
            physicalAvailableMB: message.physicalAvailableMB as number,
            commitAvailableMB: message.commitAvailableMB as number,
            lowMemory: message.lowMemory as boolean,
        };
    }
}

export interface MemorySamplerOptions {
    platform?: NodeJS.Platform;
    intervalMs?: number;
    scriptPath?: string;
    restartDelayMs?: number;
    spawnProcess?: typeof spawn;
}

export class MemorySampler implements MemoryProvider {
    private child?: ChildProcess;
    private readonly listeners = new Set<() => void>();
    private generation = 0;
    private nextStartAt = 0;
    private closed = false;
    private closing?: Promise<void>;
    private current: MemorySnapshot;
    private readonly platform: NodeJS.Platform;
    private readonly exitHandler = () => { this.child?.kill(); };

    constructor(private readonly options: MemorySamplerOptions = {}) {
        this.platform = options.platform ?? process.platform;
        this.current = this.unavailable(this.platform === 'win32' ? 'sampler_starting' : 'unsupported_platform_page_limit_only');
    }

    private unavailable(reason: string): MemorySnapshot {
        return {
            valid: false, mode: this.platform === 'win32' ? 'windows' : 'unsupported',
            sourceId: `sampler-${this.generation}`, sequence: 0, sampledAt: -Infinity, reason,
        };
    }

    snapshot(): MemorySnapshot {
        if (!this.closed && this.platform === 'win32' && !this.child && performance.now() >= this.nextStartAt) this.start();
        return { ...this.current };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private publish(snapshot: MemorySnapshot): void {
        this.current = snapshot;
        for (const listener of this.listeners) listener();
    }

    private start(): void {
        this.generation++;
        const generation = this.generation;
        const interval = Math.max(250, Math.min(2000, this.options.intervalMs ?? 500));
        this.nextStartAt = performance.now() + (this.options.restartDelayMs ?? 5000);
        this.current = this.unavailable('sampler_starting');
        let child: ChildProcess;
        try {
            child = (this.options.spawnProcess ?? spawn)('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                '-ExecutionPolicy', 'Bypass', '-File',
                this.options.scriptPath ?? fileURLToPath(new URL('../native/memory-sampler.ps1', import.meta.url)),
                '-ParentProcessId', String(process.pid), '-IntervalMs', String(interval),
            ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            this.publish(this.unavailable('sampler_spawn_failed'));
            return;
        }
        this.child = child;
        process.removeListener('exit', this.exitHandler);
        process.once('exit', this.exitHandler);
        const decoder = new MemorySampleDecoder(`windows-${generation}-${child.pid ?? 'pending'}`);
        let buffer = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            if (this.closed || this.child !== child) return;
            buffer += chunk;
            if (buffer.length > 65536) {
                buffer = '';
                this.publish(this.unavailable('sample_buffer_overflow'));
                return;
            }
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) this.publish(decoder.decode(line));
            }
        });
        child.stderr?.on('data', () => {});
        child.on('error', () => {
            if (this.child === child) this.publish(this.unavailable('sampler_process_error'));
        });
        child.once('close', () => {
            if (this.child !== child) return;
            this.child = undefined;
            process.removeListener('exit', this.exitHandler);
            this.nextStartAt = performance.now() + (this.options.restartDelayMs ?? 5000);
            this.publish(this.unavailable(this.closed ? 'sampler_closed' : 'sampler_exited'));
        });
        child.unref?.();
        (child.stdout as typeof child.stdout & { unref?: () => void })?.unref?.();
        (child.stderr as typeof child.stderr & { unref?: () => void })?.unref?.();
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.current = this.unavailable('sampler_closed');
        this.listeners.clear();
        const child = this.child;
        if (!child) return Promise.resolve();
        this.closing = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Memory sampler did not confirm exit within 5 seconds')), 5000);
            child.once('close', () => { clearTimeout(timeout); resolve(); });
            child.kill();
        });
        return this.closing;
    }
}

let runtimeSampler: MemorySampler | undefined;

export function getRuntimeMemorySampler(): MemorySampler {
    return runtimeSampler ??= new MemorySampler();
}

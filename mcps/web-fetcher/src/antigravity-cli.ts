import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { chmod, mkdtemp, open, readFile, readdir, readlink, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { getRuntimeMemorySampler, type MemoryProvider } from './memory-sampler.js';
import { antigravityFailure, remainingAntigravityMs, type AntigravityEndpoint, type AntigravityOutcome, type AntigravityRequest, type AntigravityResult } from './antigravity-types.js';
import { parseAntigravityCatalog, selectAntigravityModel } from './antigravity-models.js';
import { callAntigravityRpc } from './antigravity-rpc.js';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_BYTES = 12 * 1024 * 1024;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const CLI_EOF_GRACE_MS = 3000;
const CLI_CLEANUP_RESERVE_MS = 4000;
const DENIED_ACTIONS = ['read_file', 'write_file', 'command', 'read_url', 'execute_url', 'download_url', 'mcp'];
const IMAGE_SETTINGS = JSON.stringify({
    toolPermission: 'strict',
    permissions: { allow: [], ask: [], deny: DENIED_ACTIONS.map(action => `${action}(*)`) },
});

type JsonObject = Record<string, any>;
type CliTransport = 'cli-ls' | 'cli-agent';

export type AntigravityCliCleanup = import('./antigravity-types.js').AntigravityCleanup;
export type AntigravityCliResult = AntigravityResult;

class CliFault extends Error {
    constructor(readonly outcome: AntigravityOutcome, message: string, readonly fallback = false) { super(message); }
}

function classifyError(value: unknown): CliFault {
    const message = JSON.stringify(value)?.slice(0, 8192) ?? '';
    if (/unauthenticated|unauthorized|not.logged.in|authentication|login.required|invalid.api.key|auth.required|"code":401/iu.test(message)) {
        return new CliFault('auth-required', 'Antigravity CLI 需要认证');
    }
    if (/quota|resource.exhausted|rate.limit|too.many.requests|credit|billing|"code":429/iu.test(message)) {
        return new CliFault('quota-exhausted', 'Antigravity CLI 额度或速率受限');
    }
    if (/method.not.found|not.supported|unsupported|unknown.model|model.not.found|"code":-32601/iu.test(message)) {
        return new CliFault('unsupported', 'Antigravity CLI 不支持所需协议或模型', true);
    }
    return new CliFault('rejected', 'Antigravity CLI 拒绝请求');
}

function findCommand(): string | null {
    const explicit = process.env.WEB_FETCHER_ANTIGRAVITY_CLI_PATH;
    const candidates = explicit ? [explicit] : [
        ...(process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')] : [path.join(os.homedir(), '.local', 'bin', 'agy')]),
        ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/gu, ''), process.platform === 'win32' ? 'agy.exe' : 'agy')),
    ];
    for (const candidate of candidates) {
        try {
            if (!path.isAbsolute(candidate) || !statSync(candidate).isFile()) continue;
            accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
            return candidate;
        } catch {}
    }
    return null;
}

function delay(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds))); }

async function bounded<T>(operation: Promise<T>, deadline: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), remainingAntigravityMs({ deadline })); })]);
    } finally { clearTimeout(timer); }
}

class RequestScope {
    readonly controller = new AbortController();
    readonly operationDeadline: number;
    model: string | null;
    private readonly timer: ReturnType<typeof setTimeout>;
    private reason: 'cancelled' | 'deadline' = 'cancelled';
    private readonly onAbort = () => this.cancel();

    constructor(readonly request: AntigravityRequest) {
        const remaining = remainingAntigravityMs(request);
        this.model = request.model ?? null;
        this.operationDeadline = request.deadline - Math.min(CLI_CLEANUP_RESERVE_MS, Math.max(30, Math.floor(remaining / 5)));
        this.timer = setTimeout(() => { this.reason = 'deadline'; this.controller.abort(); }, remainingAntigravityMs({ deadline: this.operationDeadline }));
        request.signal?.addEventListener('abort', this.onAbort, { once: true });
        if (request.signal?.aborted) this.cancel();
    }

    cancel(): void { this.controller.abort(); }
    check(): void {
        if (remainingAntigravityMs({ deadline: this.operationDeadline }) <= 0 && !this.controller.signal.aborted) { this.reason = 'deadline'; this.controller.abort(); }
        if (this.controller.signal.aborted) throw new CliFault(this.reason === 'deadline' ? 'timeout-unknown' : 'cancelled', this.reason === 'deadline' ? 'Antigravity CLI 请求期限已到' : 'Antigravity CLI 请求已取消');
    }

    async wait<T>(operation: Promise<T>): Promise<T> {
        const signal = this.controller.signal;
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => { try { this.check(); } catch (error) { reject(error); } };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        });
        const combined = Promise.race([operation, aborted]);
        try { this.check(); } catch {}
        try { const value = await combined; this.check(); return value; }
        finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    }

    dispose(): void { clearTimeout(this.timer); this.request.signal?.removeEventListener('abort', this.onAbort); }
}

function execText(command: string, args: string[], deadline: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, encoding: 'utf8', timeout: Math.max(1, Math.floor(Math.min(1500, remainingAntigravityMs({ deadline })))), maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new CliFault('not-started', '无法核对自有 CLI 端口', true)) : resolve(stdout));
    });
}

async function verifyEndpoint(pid: number, port: number, deadline: number): Promise<boolean> {
    if (process.platform === 'win32') {
        const output = await execText('netstat.exe', ['-ano', '-p', 'tcp'], deadline);
        return output.split(/\r?\n/u).some(line => {
            const fields = line.trim().split(/\s+/u);
            return fields[0] === 'TCP' && fields[1] === `127.0.0.1:${port}` && fields[3] === 'LISTENING' && Number(fields[4]) === pid;
        });
    }
    if (process.platform === 'linux') {
        const sockets = new Set<string>();
        for (const descriptor of await readdir(`/proc/${pid}/fd`)) {
            try { const match = (await readlink(`/proc/${pid}/fd/${descriptor}`)).match(/^socket:\[(\d+)\]$/u); if (match) sockets.add(match[1]); } catch {}
        }
        const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
        return (await readFile('/proc/net/tcp', 'utf8')).split('\n').some(line => {
            const fields = line.trim().split(/\s+/u);
            return fields[1] === `0100007F:${hexPort}` && fields[3] === '0A' && sockets.has(fields[9]);
        });
    }
    throw new CliFault('unsupported', '当前系统尚无自有 CLI 端口归属校验', true);
}

async function terminateOwned(child: ChildProcessWithoutNullStreams, deadline: number): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        await execText('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], deadline).catch(() => {});
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }
}

export interface AntigravityCliOptions {
    resolveCommand?: () => string | null;
    spawnProcess?: typeof spawn;
    verifyEndpoint?: (pid: number, port: number, deadline: number) => Promise<boolean>;
    memoryProvider?: MemoryProvider;
    platform?: NodeJS.Platform;
    queueLimit?: number;
}

class AcpRuntime {
    readonly identity = randomUUID();
    readonly child: ChildProcessWithoutNullStreams;
    readonly closed: Promise<void>;
    ended = false;
    closing = false;
    code: number | null = null;
    unexpectedExit = false;
    fault?: CliFault;
    capabilities: JsonObject = {};
    session: JsonObject = {};
    onUpdate?: (params: JsonObject) => void;
    private sequence = 0;
    private buffer = '';
    private outputBytes = 0;
    private stderrBytes = 0;
    private stderrFault?: CliFault;
    private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();

    constructor(readonly root: string, command: string, agent: boolean, spawnProcess: typeof spawn) {
        const args = [...(agent ? ['--settings', IMAGE_SETTINGS] : []), 'acp', '--stdio', '--include-default-customizations=false', '--cli_log_file', path.join(root, 'backend.log')];
        this.child = spawnProcess(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }) as ChildProcessWithoutNullStreams;
        this.closed = new Promise(resolve => {
            this.child.once('close', code => {
                this.ended = true; this.code = code; this.unexpectedExit = !this.closing;
                if (this.buffer.trim()) this.fail(new CliFault('invalid-response', 'ACP 输出存在未结束的数据帧'));
                if (!this.closing || this.pending.size > 0 || code !== 0 || this.fault) this.fail(this.fault ?? (code !== 0 ? this.stderrFault : undefined) ?? new CliFault('transport-unknown', '自有 CLI 已退出'));
                resolve();
            });
        });
        this.child.on('error', () => this.fail(new CliFault('not-started', '自有 CLI 启动失败', true)));
        this.child.stdin.on('error', () => this.fail(new CliFault('transport-unknown', 'ACP 输入通道已关闭')));
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
        this.child.stderr.on('data', (chunk: Buffer) => {
            this.stderrBytes += chunk.length;
            const diagnostic = chunk.toString('utf8');
            if (/unauthenticated|unauthorized|not.logged.in|authentication.failed|quota.exhausted|resource.exhausted|rate.limit.exceeded/iu.test(diagnostic)) {
                const classified = classifyError(diagnostic);
                if (classified.outcome === 'auth-required' || classified.outcome === 'quota-exhausted') this.stderrFault = classified;
            }
            if (this.stderrBytes > MAX_PROTOCOL_BYTES) this.fail(new CliFault('invalid-response', 'CLI stderr 超出大小限制'));
        });
    }

    private fail(error: CliFault): void {
        this.fault ??= error;
        for (const entry of this.pending.values()) entry.reject(this.fault);
        this.pending.clear();
    }

    private consume(chunk: string): void {
        if (this.fault) return;
        this.outputBytes += Buffer.byteLength(chunk);
        this.buffer += chunk;
        if (this.outputBytes > MAX_PROTOCOL_BYTES || Buffer.byteLength(this.buffer) > MAX_OUTPUT_BYTES) {
            this.fail(new CliFault('invalid-response', 'ACP 输出超出大小限制')); return;
        }
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0 && !this.fault) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            let message: JsonObject;
            try { message = JSON.parse(line); } catch { this.fail(new CliFault('invalid-response', 'ACP 输出不是合法 JSON 帧')); return; }
            if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') { this.fail(new CliFault('invalid-response', 'ACP 输出帧格式错误')); return; }
            if (typeof message.method === 'string') {
                if (message.id !== undefined) {
                    const response = message.method === 'session/request_permission'
                        ? { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }
                        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability disabled' } };
                    try { this.write(response); }
                    catch { this.fail(new CliFault('transport-unknown', 'ACP 客户端响应通道已关闭')); return; }
                } else if (message.method === 'session/update') {
                    try { this.onUpdate?.(message.params ?? {}); } catch (error) { this.fail(error instanceof CliFault ? error : new CliFault('invalid-response', 'ACP 通知格式错误')); }
                }
                continue;
            }
            const entry = this.pending.get(message.id);
            if (!entry) continue;
            this.pending.delete(message.id);
            if (message.error !== undefined) entry.reject(classifyError(message.error));
            else if (message.result && typeof message.result === 'object') entry.resolve(message.result);
            else entry.reject(new CliFault('invalid-response', 'ACP 响应缺少结果对象'));
        }
    }

    private write(message: JsonObject, onSend?: () => void): void {
        const line = JSON.stringify(message) + '\n';
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new CliFault('rejected', 'ACP 请求超出大小限制');
        if (this.ended || this.closing || this.child.stdin.destroyed) throw this.fault ?? new CliFault('transport-unknown', 'ACP 运行实例已经关闭');
        onSend?.();
        this.child.stdin.write(line);
    }

    rpc(method: string, params: JsonObject, onSend?: () => void): Promise<JsonObject> {
        return new Promise((resolve, reject) => {
            if (this.fault) { reject(this.fault); return; }
            const id = ++this.sequence;
            this.pending.set(id, { resolve, reject });
            try { this.write({ jsonrpc: '2.0', id, method, params }, onSend); }
            catch (error) { this.pending.delete(id); reject(error); }
        });
    }

    notifyCancel(sessionId: string): void {
        try { this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); } catch {}
    }

    async initialize(scope: RequestScope): Promise<void> {
        const initialized = await scope.wait(this.rpc('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'web-fetcher', version: '1' },
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }));
        if (initialized.protocolVersion !== 1) throw new CliFault('unsupported', 'ACP 协议版本不兼容', true);
        this.capabilities = initialized.agentCapabilities ?? {};
        this.session = await scope.wait(this.rpc('session/new', { cwd: this.root, mcpServers: [] }));
        if (typeof this.session.sessionId !== 'string' || !this.session.sessionId || this.session.sessionId.length > 512) throw new CliFault('invalid-response', 'ACP 新会话缺少有效 sessionId');
    }

    async endpoint(scope: RequestScope, verify: NonNullable<AntigravityCliOptions['verifyEndpoint']>): Promise<AntigravityEndpoint> {
        while (true) {
            scope.check();
            if (this.fault) throw this.fault;
            try {
                const file = path.join(this.root, 'backend.log');
                if ((await stat(file)).size > MAX_LOG_BYTES) throw new CliFault('invalid-response', '自有 CLI 日志超出大小限制');
                const content = await readFile(file, 'utf8');
                const processMatch = content.match(/Starting language server process with pid (\d+)\b/u);
                const portMatch = content.match(/Language server listening on random port at (\d+) for HTTP\b/u);
                if (processMatch && Number(processMatch[1]) !== this.child.pid) throw new CliFault('not-started', '自有 CLI 日志 PID 归属不匹配', true);
                if (processMatch && portMatch) {
                    const port = Number(portMatch[1]);
                    if (port < 1 || port > 65535 || !this.child.pid) throw new CliFault('not-started', '自有 CLI 端口无效', true);
                    if (await scope.wait(verify(this.child.pid, port, scope.operationDeadline))) {
                        if (this.ended || this.fault) throw this.fault ?? new CliFault('not-started', '自有 CLI 已退出', true);
                        return { host: '127.0.0.1', port, pid: this.child.pid, identity: `${this.identity}:${this.child.pid}`, transport: 'cli-ls' };
                    }
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await scope.wait(delay(40));
        }
    }

    async close(deadline: number): Promise<AntigravityCliCleanup> {
        const started = performance.now();
        let method: AntigravityCliCleanup['method'] = this.ended ? 'already-exited' : 'stdin-eof';
        let eofWaitMs = 0;
        const warnings: string[] = [];
        this.closing = true;
        if (!this.ended) {
            try { this.child.stdin.end(); } catch { warnings.push('CLI stdin EOF 发送失败'); }
            const remaining = remainingAntigravityMs({ deadline });
            const forceReserve = Math.min(1000, Math.max(50, Math.floor(remaining / 5)));
            const graceEnd = Math.min(deadline - forceReserve, performance.now() + CLI_EOF_GRACE_MS);
            if (graceEnd > performance.now()) await bounded(this.closed, graceEnd);
            eofWaitMs = Math.round(performance.now() - started);
        }
        if (!this.ended && remainingAntigravityMs({ deadline }) > 0) {
            method = 'owned-tree-terminate';
            warnings.push('CLI 未在 EOF 宽限内退出，已请求终止自有进程树');
            await bounded(terminateOwned(this.child, deadline), Math.max(performance.now(), deadline - Math.min(80, remainingAntigravityMs({ deadline }) / 5)));
        }
        if (!this.ended) await bounded(this.closed, deadline);
        if (!this.ended) warnings.push('CLI 自有进程树退出尚未确认，运行实例保持隔离');
        if (this.ended && this.code !== 0) warnings.push('CLI 退出码非零');
        if (this.unexpectedExit) warnings.push('CLI 在客户端 EOF 清理之前退出');
        if (this.fault) warnings.push('CLI 存在独立的传输或协议诊断');
        return {
            status: !this.ended ? 'unconfirmed' : method === 'owned-tree-terminate' ? 'terminated'
                : this.code !== 0 || this.unexpectedExit || this.fault ? 'abnormal-exit' : 'graceful',
            confirmed: this.ended, method, exitCode: this.code, signal: this.child.signalCode,
            unexpectedExit: this.unexpectedExit, eofWaitMs, elapsedMs: Math.round(performance.now() - started),
            ...(this.fault ? { fault: { outcome: this.fault.outcome, error: this.fault.message } } : {}),
            warnings,
        };
    }
}

async function imageBlock(imagePath: string): Promise<JsonObject> {
    let handle;
    try {
        handle = await open(imagePath, 'r');
        const info = await handle.stat();
        if (!info.isFile() || info.size < 4 || info.size > MAX_IMAGE_BYTES) throw new CliFault('rejected', '图片附件格式或大小无效');
        const data = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
            if (!bytesRead) throw new CliFault('rejected', '图片附件读取不完整');
            offset += bytesRead;
        }
        if ((await handle.stat()).size !== info.size) throw new CliFault('rejected', '图片附件在读取时发生变化');
        const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
            : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
            : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
            : /^GIF8[79]a$/u.test(data.toString('ascii', 0, 6)) ? 'image/gif'
            : data.toString('ascii', 0, 2) === 'BM' ? 'image/bmp' : null;
        if (!mimeType) throw new CliFault('unsupported', '图片附件编码尚不受支持', true);
        return { type: 'image', data: data.toString('base64'), mimeType };
    } catch (error) { if (error instanceof CliFault) throw error; throw new CliFault('rejected', '图片附件不可读取'); }
    finally { await handle?.close(); }
}

interface QueueEntry {
    scope: RequestScope;
    transport: CliTransport;
    work: (runtime: AcpRuntime, scope: RequestScope, markSubmitted: () => void) => Promise<AntigravityResult>;
    resolve: (result: AntigravityCliResult) => void;
    onAbort: () => void;
}

export function selectAntigravityAgentModel(available: JsonObject[], request: Pick<AntigravityRequest, 'model' | 'purpose'>): JsonObject | undefined {
    if (request.model) {
        const direct = available.find(item => item.modelId === request.model || item.name === request.model);
        if (direct) return direct;
        const normalize = (value: string) => value.toLowerCase().replace(/\(limited time\)/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
        const matches = available.filter(item => typeof item.name === 'string' && normalize(item.name) === normalize(request.model!));
        return matches.length === 1 ? matches[0] : undefined;
    }
    const eligible = available.filter(item => item.disabled !== true && item.quotaInfo?.remainingFraction !== 0);
    const preferences = request.purpose === 'visual-review'
        ? [/argon.*high/iu, /carbon.*high/iu]
        : [/gemini.*3[.\-]?8.*flash.*high/iu];
    return preferences.map(pattern => eligible.find(item => pattern.test(`${item.modelId} ${item.name}`))).find(Boolean)
        ?? preferences.map(pattern => available.find(item => pattern.test(`${item.modelId} ${item.name}`))).find(Boolean);
}

export class AntigravityCliClient {
    private runtime?: AcpRuntime;
    private active?: QueueEntry;
    private draining?: Promise<void>;
    private disposing?: Promise<void>;
    private disposed = false;
    private readonly queue: QueueEntry[] = [];
    private readonly retainedRoots = new Set<string>();
    private readonly resolveCommand: () => string | null;

    constructor(private readonly options: AntigravityCliOptions = {}) { this.resolveCommand = options.resolveCommand ?? findCommand; }

    isInstalled(): boolean { return this.resolveCommand() !== null; }

    getStatus(): { installed: boolean; running: boolean; closing: boolean; activeLeases: number; queuedRequests: number; maxConcurrency: number; memoryProtection: string } {
        return { installed: this.isInstalled(), running: Boolean(this.runtime && !this.runtime.ended), closing: Boolean(this.runtime?.closing), activeLeases: this.active ? 1 : 0, queuedRequests: this.queue.length, maxConcurrency: 1, memoryProtection: 'startup-watermark-only' };
    }

    private enqueue(request: AntigravityRequest, transport: CliTransport, work: QueueEntry['work']): Promise<AntigravityCliResult> {
        if (typeof request.prompt !== 'string' || !request.prompt.trim()
            || (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim()))
            || (request.imagePaths !== undefined && (!Array.isArray(request.imagePaths) || request.imagePaths.some(image => typeof image !== 'string' || !image)))) {
            return Promise.resolve(antigravityFailure('rejected', 'CLI 请求的文本、模型或附件无效', transport));
        }
        if (remainingAntigravityMs(request) <= 0) return Promise.resolve(antigravityFailure('not-started', '请求期限已到或无效', transport, request.model ?? null));
        if (this.disposed) return Promise.resolve(antigravityFailure('cancelled', 'CLI 客户端已释放', transport, request.model ?? null));
        if (this.queue.length >= (this.options.queueLimit ?? 16)) return Promise.resolve(antigravityFailure('rejected', 'CLI 等待队列已满', transport, request.model ?? null));
        const scope = new RequestScope(request);
        return new Promise(resolve => {
            const entry: QueueEntry = { scope, transport, work, resolve, onAbort: () => {
                const index = this.queue.indexOf(entry);
                if (index < 0) return;
                this.queue.splice(index, 1);
                let fault: unknown;
                try { scope.check(); } catch (error) { fault = error; }
                scope.dispose();
                resolve(this.failure(fault, entry, false));
            } };
            this.queue.push(entry);
            scope.controller.signal.addEventListener('abort', entry.onAbort, { once: true });
            if (scope.controller.signal.aborted) entry.onAbort();
            if (!this.draining) {
                this.startDrain();
            }
        });
    }

    private startDrain(): void {
        this.draining = this.drain().finally(() => {
            this.draining = undefined;
            if (this.queue.length) this.startDrain();
        });
    }

    private failure(error: unknown, entry: QueueEntry, submitted: boolean): AntigravityResult {
        const fault = error instanceof CliFault ? error : new CliFault(submitted ? 'transport-unknown' : 'not-started', submitted ? 'CLI 已提交请求的结果未知' : 'CLI 请求未启动', !submitted);
        const outcome = fault.outcome === 'timeout-unknown' && !submitted ? 'not-started' : fault.outcome;
        return antigravityFailure(outcome, fault.message, entry.transport, entry.scope.model, submitted, !submitted && fault.fallback);
    }

    private async admit(scope: RequestScope): Promise<void> {
        const platform = this.options.platform ?? process.platform;
        if (platform !== 'win32' && !this.options.memoryProvider) {
            if (os.freemem() < 1024 * 1024 * 1024) throw new CliFault('rejected', 'CLI 启动可用内存不足');
            return;
        }
        const provider = this.options.memoryProvider ?? getRuntimeMemorySampler();
        while (true) {
            scope.check();
            const sample = provider.snapshot();
            if (sample.valid && performance.now() - sample.sampledAt <= 2000 && performance.now() >= sample.sampledAt) {
                if (sample.lowMemory || (sample.physicalAvailableMB ?? 0) < 1024 || (sample.commitAvailableMB ?? 0) < 1536) throw new CliFault('rejected', 'CLI 启动内存水位不足');
                return;
            }
            await scope.wait(delay(40));
        }
    }

    private async drain(): Promise<void> {
        while (this.queue.length) {
            const entry = this.queue.shift()!;
            this.active = entry;
            entry.scope.controller.signal.removeEventListener('abort', entry.onAbort);
            let submitted = false;
            let root: string | undefined;
            let runtime: AcpRuntime | undefined;
            let result: AntigravityCliResult;
            try {
                entry.scope.check();
                if (this.runtime && !this.runtime.ended) throw new CliFault('rejected', '上一个自有 CLI 尚未确认退出');
                if (this.runtime?.ended) { await rm(this.runtime.root, { recursive: true, force: true }); this.runtime = undefined; }
                const command = this.resolveCommand();
                if (!command) throw new CliFault('not-started', '未安装 Antigravity CLI', true);
                await this.admit(entry.scope);
                root = await mkdtemp(path.join(os.tmpdir(), 'web-fetcher-agy-'));
                await chmod(root, 0o700);
                entry.scope.check();
                runtime = new AcpRuntime(root, command, entry.transport === 'cli-agent', this.options.spawnProcess ?? spawn);
                this.runtime = runtime;
                await runtime.initialize(entry.scope);
                result = await entry.work(runtime, entry.scope, () => { submitted = true; });
                submitted ||= result.submitted;
            } catch (error) { result = this.failure(error, entry, submitted); }
            if (runtime) {
                const cleanup = await runtime.close(entry.scope.request.deadline);
                result = { ...result, cleanup };
                if (cleanup.confirmed && this.runtime === runtime) this.runtime = undefined;
            }
            if (root && (!runtime || runtime.ended)) {
                try { await rm(root, { recursive: true, force: true }); if (result.cleanup) result.cleanup.tempRemoved = true; }
                catch {
                    this.retainedRoots.add(root);
                    if (result.cleanup) { result.cleanup.tempRemoved = false; result.cleanup.warnings.push('CLI 临时目录清理失败，已保留待重试'); }
                }
            } else if (result.cleanup) result.cleanup.tempRemoved = false;
            entry.scope.dispose();
            this.active = undefined;
            entry.resolve(result);
        }
    }

    withEndpoint(request: AntigravityRequest, work: (endpoint: AntigravityEndpoint, scopedRequest: AntigravityRequest) => Promise<AntigravityResult>): Promise<AntigravityCliResult> {
        if (request.imagePaths?.length) return Promise.resolve(antigravityFailure('unsupported', 'CLI LS 仅支持纯文字请求', 'cli-ls', request.model ?? null, false, true));
        return this.enqueue(request, 'cli-ls', async (runtime, scope, markSubmitted) => {
            const endpoint = await runtime.endpoint(scope, this.options.verifyEndpoint ?? verifyEndpoint);
            scope.check();
            const scopedRequest: AntigravityRequest = {
                ...request,
                deadline: scope.operationDeadline,
                signal: scope.controller.signal,
                onSubmitted: model => {
                    markSubmitted();
                    if (model !== undefined) scope.model = model;
                    request.onSubmitted?.(model);
                },
            };
            return await scope.wait(work(endpoint, scopedRequest));
        });
    }

    callAgent(request: AntigravityRequest): Promise<AntigravityCliResult> {
        return this.enqueue(request, 'cli-agent', async (runtime, scope, markSubmitted) => {
            const imagePaths = request.imagePaths ?? [];
            if (imagePaths.length > 8) throw new CliFault('rejected', '图片请求最多包含 8 个附件');
            if (imagePaths.length && runtime.capabilities.promptCapabilities?.image !== true) throw new CliFault('unsupported', 'ACP 未声明原生图片能力', true);
            const prompt: JsonObject[] = [{ type: 'text', text: request.prompt }];
            let bytes = 0;
            for (const imagePath of imagePaths) {
                const block = await scope.wait(imageBlock(imagePath));
                bytes += Buffer.byteLength(block.data, 'base64');
                if (bytes > MAX_IMAGES_BYTES) throw new CliFault('rejected', '图片附件总大小超出限制');
                prompt.push(block);
            }
            if (request.schema) prompt.push({ type: 'text', text: `Return JSON matching this schema: ${JSON.stringify(request.schema)}` });
            const available: JsonObject[] = Array.isArray(runtime.session.models?.availableModels) ? runtime.session.models.availableModels : [];
            let model = selectAntigravityAgentModel(available, request);
            if (!model && request.model && /^(?:MODEL_PLACEHOLDER_)?M\d+$/iu.test(request.model)) {
                const endpoint = await runtime.endpoint(scope, this.options.verifyEndpoint ?? verifyEndpoint);
                const status = await scope.wait(callAntigravityRpc(endpoint, 'GetUserStatus', {}, { deadline: scope.operationDeadline, signal: scope.controller.signal }));
                if (status.status !== 200) throw classifyError(status.data);
                const selection = selectAntigravityModel(parseAntigravityCatalog(status.data), request.model);
                if (selection.error) throw new CliFault(selection.error.outcome, selection.error.error ?? '显式模型无法映射');
                if (!selection.model) throw new CliFault('invalid-response', '显式模型目录缺少映射结果');
                model = selectAntigravityAgentModel(available, { ...request, model: selection.model.label });
            }
            if (!model || typeof model.modelId !== 'string') throw new CliFault('unsupported', 'ACP 目录中没有所选模型', !request.model);
            scope.model = model.modelId;
            if (model.disabled === true) throw new CliFault('rejected', 'ACP 所选模型已停用');
            if (model.quotaInfo?.remainingFraction === 0) throw new CliFault('quota-exhausted', 'ACP 所选模型额度已耗尽');
            const sessionId = runtime.session.sessionId;
            if (runtime.session.models.currentModelId !== model.modelId) await scope.wait(runtime.rpc('session/set_model', { sessionId, modelId: model.modelId }));
            let text = '';
            let outputBytes = 0;
            let messageId: string | undefined;
            runtime.onUpdate = params => {
                if (params.sessionId !== sessionId) return;
                const update = params.update;
                if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') throw new CliFault('rejected', '受控模型请求出现了工具调用，已取消');
                if (update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
                if (typeof update.content.text !== 'string') throw new CliFault('invalid-response', 'ACP 文本块格式错误');
                if (typeof update.messageId === 'string' && messageId && messageId !== update.messageId) text = '';
                if (typeof update.messageId === 'string') messageId = update.messageId;
                outputBytes += Buffer.byteLength(update.content.text);
                if (outputBytes > MAX_OUTPUT_BYTES) throw new CliFault('invalid-response', 'ACP 最终文本超出大小限制');
                text += update.content.text;
            };
            scope.check();
            const pendingPrompt = runtime.rpc('session/prompt', { sessionId, prompt }, markSubmitted);
            let terminal: JsonObject;
            try { terminal = await scope.wait(pendingPrompt); }
            catch (error) {
                runtime.notifyCancel(sessionId);
                await bounded(pendingPrompt.catch(() => undefined), Math.min(request.deadline - 600, performance.now() + 700));
                throw error;
            } finally { runtime.onUpdate = undefined; }
            if (terminal.error || terminal.isError === true) throw classifyError(terminal.error ?? terminal);
            if (terminal.stopReason === 'cancelled') throw new CliFault('cancelled', 'ACP 已确认取消');
            if (terminal.stopReason === 'refusal') throw new CliFault('rejected', 'ACP 已拒绝生成');
            if (terminal.stopReason !== 'end_turn' || !text.trim() || (terminal.terminalStatus && !['success', 'completed', 'done'].includes(terminal.terminalStatus))) throw new CliFault('invalid-response', 'ACP 未返回完整成功终态');
            return { text: text.trim(), transport: 'cli-agent', model: model.modelId, outcome: 'success', submitted: true, safeToFallback: false };
        });
    }

    dispose(): Promise<void> {
        if (this.disposing) return this.disposing;
        this.disposed = true;
        this.active?.scope.cancel();
        for (const entry of [...this.queue]) entry.scope.cancel();
        this.disposing = (async () => {
            await this.draining;
            if (this.runtime && !(await this.runtime.close(performance.now() + CLI_CLEANUP_RESERVE_MS)).confirmed) throw new Error('自有 CLI 退出尚未确认');
            if (this.runtime?.ended) { await rm(this.runtime.root, { recursive: true, force: true }); this.runtime = undefined; }
            for (const root of this.retainedRoots) { await rm(root, { recursive: true, force: true }); this.retainedRoots.delete(root); }
        })();
        return this.disposing;
    }
}

const defaultClient = new AntigravityCliClient();

export function isAntigravityCliInstalled(): boolean { return defaultClient.isInstalled(); }
export function getAntigravityCliStatus(): ReturnType<AntigravityCliClient['getStatus']> { return defaultClient.getStatus(); }
export function withCliEndpoint(request: AntigravityRequest, work: (endpoint: AntigravityEndpoint, scopedRequest: AntigravityRequest) => Promise<AntigravityResult>): Promise<AntigravityCliResult> { return defaultClient.withEndpoint(request, work); }
export function callCliAgent(request: AntigravityRequest): Promise<AntigravityCliResult> { return defaultClient.callAgent(request); }
export function disposeAntigravityCli(): Promise<void> { return defaultClient.dispose(); }

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFault } from '../protocol.js';

export type AgentNativeHelper = 'agent-file-commit' | 'windows-agent-runner';

export interface NativeReply<Data = Record<string, unknown>> {
    protocolVersion: 1;
    ok: boolean;
    data?: Data;
    error?: { code: string; message: string; retryable: boolean; mayHaveStarted: boolean; details?: Record<string, unknown> };
}

export interface NativeCallOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    resourceId?: string;
    leaseMs?: number;
    keepControlOpen?: boolean;
}

export function helperEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec']) {
        const value = process.env[key];
        if (value) environment[key] = value;
    }
    environment.PATH = path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32');
    return environment;
}

export class AgentNativeClient {
    readonly packageRoot: string;

    constructor(packageRoot = fileURLToPath(new URL('../../../', import.meta.url))) {
        this.packageRoot = path.resolve(packageRoot);
    }

    async verifiedPath(helper: AgentNativeHelper): Promise<string> {
        if (process.platform !== 'win32' || process.arch !== 'x64') {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '原生工具仅在已支持的Windows x64环境启用');
        }
        try {
            const manifestPath = path.join(this.packageRoot, 'dist/native/agent-native-manifest.json');
            if ((await stat(manifestPath)).size > 65536) throw new Error('manifest-size');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            const relativePath = `dist/native/${helper}.exe`;
            const entry = manifest.artifacts?.find((artifact: Record<string, unknown>) => artifact.path === relativePath);
            if (manifest.schemaVersion !== 1 || manifest.supported !== true || !entry || entry.target?.platform !== 'win32'
                || entry.target?.arch !== 'x64' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('manifest-entry');
            const executable = path.join(this.packageRoot, relativePath);
            const information = await stat(executable);
            if (!information.isFile() || information.size !== entry.sizeBytes || information.size > 4 * 1024 * 1024) throw new Error('artifact-size');
            const bytes = await readFile(executable);
            if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('artifact-hash');
            return executable;
        } catch {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '包内原生辅助程序或构建清单未通过核对', { helper });
        }
    }

    async call<Data = Record<string, unknown>>(helper: AgentNativeHelper, request: Record<string, unknown>, options: NativeCallOptions = {}): Promise<NativeReply<Data>> {
        const executable = await this.verifiedPath(helper);
        if (options.signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '动作开始前已取消');
        return new Promise((resolve, reject) => {
            const child = spawn(executable, [], { windowsHide: true, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
            const maximum = options.maxOutputBytes ?? 2 * 1024 * 1024;
            const chunks: Buffer[] = [];
            let outputBytes = 0;
            let exceeded = false;
            let timedOut = false;
            let started = false;
            let settled = false;
            let renewal: ReturnType<typeof setInterval> | undefined;
            let cancelTimer: ReturnType<typeof setTimeout> | undefined;
            const send = (operation: string) => {
                if (!child.stdin.destroyed && options.resourceId) child.stdin.write(`${JSON.stringify({ resourceId: options.resourceId, operation })}\n`);
            };
            const abort = () => {
                if (options.keepControlOpen) {
                    send('cancel');
                    cancelTimer ??= setTimeout(() => child.kill(), 30000);
                } else child.kill();
            };
            const timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs ?? 15000);
            options.signal?.addEventListener('abort', abort, { once: true });
            child.once('spawn', () => { started = true; });
            child.stdin.on('error', () => {});
            child.stderr.on('data', () => {});
            child.stdout.on('data', (chunk: Buffer) => {
                outputBytes += chunk.length;
                if (outputBytes <= maximum) chunks.push(chunk);
                else { exceeded = true; abort(); }
            });
            const finish = () => {
                clearTimeout(timer);
                clearTimeout(cancelTimer);
                clearInterval(renewal);
                options.signal?.removeEventListener('abort', abort);
            };
            child.once('error', () => {
                if (settled) return;
                settled = true;
                finish();
                reject(new AgentFault('NATIVE_HELPER_START_FAILED', '原生辅助程序未能正常启动', { helper }, started));
            });
            child.once('close', code => {
                if (settled) return;
                settled = true;
                finish();
                try {
                    if (exceeded || timedOut) throw new Error('output-or-time-limit');
                    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as NativeReply<Data>;
                    if (reply.protocolVersion !== 1 || typeof reply.ok !== 'boolean' || code !== (reply.ok ? 0 : 1)) throw new Error('protocol');
                    if (!reply.ok && (!reply.error || typeof reply.error.mayHaveStarted !== 'boolean')) throw new Error('error');
                    resolve(reply);
                } catch {
                    reject(new AgentFault('RESOURCE_UNRESOLVED', '原生操作结果未确认，需查询原动作回执', { helper, resourceId: options.resourceId ?? null, timedOut, exceeded }, started));
                }
            });
            const input = `${JSON.stringify(request)}\n`;
            if (options.keepControlOpen) {
                child.stdin.write(input);
                renewal = setInterval(() => send('renew'), Math.min(30000, Math.floor((options.leaseMs ?? 90000) / 3)));
                if (options.signal?.aborted) abort();
            } else child.stdin.end(input);
        });
    }

    async require<Data = Record<string, unknown>>(helper: AgentNativeHelper, request: Record<string, unknown>, options?: NativeCallOptions): Promise<Data> {
        const result = await this.call<Data>(helper, request, options);
        if (!result.ok) throw new AgentFault(result.error!.code, result.error!.message, result.error!.details, result.error!.mayHaveStarted, result.error!.retryable);
        return result.data!;
    }
}

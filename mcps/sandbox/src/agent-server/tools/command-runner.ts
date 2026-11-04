import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ResourceRegistry } from '../resources/registry.js';
import type { ResourceReceipt } from '../resources/registry.js';
import { createCommandResourceAdapter } from '../resources/command-resource-adapter.js';
import { assertNotProtected, isWithin, pathIdentity, requirePolicy } from '../security/policy.js';
import { AgentNativeClient, helperEnvironment } from './native.js';
import type { BoundToolContext } from './types.js';
import { withDeclaredCommandWrites } from '../workspace/command-writes.js';
import type { DeclaredCommandWorkspace } from '../workspace/command-writes.js';
import { createWindowsJobLaunch, hasWindowsJobRunner, readWindowsJobMetadata, WindowsJobLaunchError } from '../../windows-job-runner.js';

export const COMMAND_AUTHORIZATION_BOUNDARY = Object.freeze({ enabled: true,
    mode: 'cooperative_windows_job', strongOsIsolationRequired: false,
    reason: '普通命令遵守当前任务规则；入口检查批准工作区和受保护路径，Windows Job限制内存并回收派生进程' });

export interface RestrictedCommandArguments {
    application: string;
    args: string[];
    cwd: string;
    stdin?: string;
    timeoutMs: number;
    maxMemoryMB: number;
    maxOutputBytes: number;
    writeSet?: string[];
}

export interface CommandCapability {
    available: boolean;
    commandCapability: string;
    reason?: string;
    productionAcceptance?: string;
    ordinaryProcessFallback?: boolean;
    [key: string]: unknown;
}

export interface RestrictedCommandReceipt extends Record<string, unknown> {
    resourceId: string;
    commandStarted: boolean;
    terminalConfirmed: boolean;
    cleanupState: string;
    stdoutBase64: string;
    stderrBase64: string;
    childExitCode: number | null;
}

interface JobRunnerOptions { receiptDirectory?: string; processProbeTimeoutMs?: number }
type CommandResult = RestrictedCommandReceipt & { stdout: string; stderr: string; coverage: Record<string, unknown> };
interface CommandAttempt { conversationId: string; runId: string; hash: string; settled: boolean; promise: Promise<CommandResult> }

function commandEvidence(receipt: Record<string, unknown>): Record<string, unknown> {
    const fields = ['resourceId', 'actionId', 'attemptId', 'policyRevision', 'argsHash', 'commandStarted', 'commandStartedKnown',
        'mayHaveStarted', 'terminalConfirmed', 'cleanupState', 'childExitCode',
        'helperPid', 'helperExited', 'helperExitCode', 'stopReason', 'peakMemoryBytes', 'outputTruncated', 'outputBytes',
        'observedBytes', 'forcedStop', 'spawnError', 'activeProcessesAtRelease', 'startErrorType', 'startErrorCode',
        'processEvidenceScope', 'recoveryMetadataPath', 'jobMetadata'];
    return Object.fromEntries(fields.filter(field => receipt[field] !== undefined).map(field => [field, receipt[field]]));
}

export function commandResourceReceipt(receipt: RestrictedCommandReceipt): ResourceReceipt {
    const evidence = commandEvidence(receipt);
    if (!receipt.terminalConfirmed || receipt.cleanupState !== 'released') evidence.output = {
        encoding: 'base64', stdoutBase64: receipt.stdoutBase64, stderrBase64: receipt.stderrBase64,
        retainedBytes: receipt.outputBytes, observedBytes: receipt.observedBytes, truncated: receipt.outputTruncated,
    };
    return { started: receipt.commandStartedKnown === true ? receipt.commandStarted : null,
        terminalConfirmed: receipt.terminalConfirmed, released: receipt.cleanupState === 'released', evidence };
}

export function validateOrdinaryCommand(args: RestrictedCommandArguments, context: BoundToolContext): void {
    pathIdentity(args.application);
    pathIdentity(args.cwd);
    if (!Array.isArray(args.args) || args.args.length > 256 || args.args.some(value => typeof value !== 'string' || value.includes('\0'))
        || !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 3600000
        || !Number.isSafeInteger(args.maxMemoryMB) || args.maxMemoryMB < 16 || args.maxMemoryMB > 4096
        || !Number.isSafeInteger(args.maxOutputBytes) || args.maxOutputBytes < 1 || args.maxOutputBytes > 1048576
        || Buffer.byteLength(args.stdin ?? '') > 16384) throw new AgentFault('INVALID_PARAMS', '命令参数或预算超出支持范围', { commandStarted: false });
    try {
        assertNotProtected(args.application, context);
        requirePolicy({ kinds: ['process', 'network'], writePaths: [args.cwd, ...(args.writeSet ?? [])] }, context);
        for (const candidate of args.writeSet ?? []) {
            if ((context.protectedPaths ?? []).some(root => isWithin(root, candidate))) {
                throw new AgentFault('TOOL_NOT_ALLOWED', '声明写集合包含可信核心保留路径');
            }
        }
        const protectedPaths = (context.protectedPaths ?? []).map(root => pathIdentity(root).replaceAll('\\', '/'));
        for (const value of args.args) {
            if (path.isAbsolute(value)) assertNotProtected(value, context);
            const normalized = (process.platform === 'win32' ? value.toLowerCase() : value).replaceAll('\\', '/');
            if (protectedPaths.some(root => normalized.includes(root))) {
                throw new AgentFault('TOOL_NOT_ALLOWED', '命令参数引用可信核心保留路径，请改为普通任务资料');
            }
        }
    } catch (error) {
        if (error instanceof AgentFault && error.code === 'TOOL_NOT_ALLOWED') {
            throw new AgentFault(error.code, error.message, { ...error.details, commandStarted: false,
                localPolicyViolation: true, source: 'local', pauseConversation: true, stopAutomaticRetry: true });
        }
        throw error;
    }
}

export class RestrictedCommandRunner {
    private readonly attempts = new Map<string, CommandAttempt>();
    private readonly attachedResources = new WeakSet<ResourceRegistry>();
    private readonly runningCommands = new Map<string, { cancel: () => void; completion: Promise<RestrictedCommandReceipt> }>();
    private workspace?: DeclaredCommandWorkspace;
    constructor(readonly native = new AgentNativeClient(), private readonly options: JobRunnerOptions = {}) {}

    bindWorkspace(workspace: DeclaredCommandWorkspace): void {
        if ([...this.attempts.values()].some(attempt => !attempt.settled)) throw new AgentFault('INVALID_STATE', '命令在途时不能替换工作区记录端口');
        this.workspace = workspace;
    }

    attachResources(resources: ResourceRegistry): void {
        if (this.attachedResources.has(resources)) return;
        resources.register(createCommandResourceAdapter({ cancel: async resourceId => {
            const running = this.runningCommands.get(resourceId);
            if (!running) return undefined;
            running.cancel();
            return commandResourceReceipt(await running.completion);
        } }));
        this.attachedResources.add(resources);
    }

    async capabilities(): Promise<CommandCapability> {
        return { available: hasWindowsJobRunner(), commandCapability: 'cooperative_windows_job',
            ordinaryProcessFallback: false, authorizationBoundary: COMMAND_AUTHORIZATION_BOUNDARY,
            reason: COMMAND_AUTHORIZATION_BOUNDARY.reason };
    }

    releaseForRun(conversationId: string, runId: string): void {
        for (const [key, attempt] of this.attempts) {
            if (attempt.settled && attempt.conversationId === conversationId && attempt.runId === runId) this.attempts.delete(key);
        }
    }

    async execute(args: RestrictedCommandArguments, context: BoundToolContext, resources?: ResourceRegistry): Promise<CommandResult> {
        if (resources) this.attachResources(resources);
        validateOrdinaryCommand(args, context);
        await context.assertCurrent?.();
        const key = JSON.stringify([context.principalId, context.conversationId, context.runId, context.actionId]);
        const hash = createHash('sha256').update(canonicalJson({ args, roots: context.roots,
            protectedPaths: context.protectedPaths ?? [], policyRevision: context.policyRevision })).digest('hex');
        const previous = this.attempts.get(key);
        if (previous) {
            if (previous.hash !== hash) throw new AgentFault('COMMAND_ID_REUSED', '同一动作的参数或授权版本变化', { commandStarted: false });
            return previous.promise;
        }
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '命令开始前已取消', { commandStarted: false });
        if (!hasWindowsJobRunner()) throw new AgentFault('COMMAND_CAPABILITY_UNAVAILABLE', 'Windows Job helper不可用', { commandStarted: false });
        const deadline = context.deadlineAt === undefined ? Infinity : Date.parse(context.deadlineAt);
        if (Number.isNaN(deadline) || deadline <= Date.now()) throw new AgentFault('TOOL_DEADLINE_EXCEEDED', '动作截止时间已到', { commandStarted: false });
        const attempt: CommandAttempt = { conversationId: context.conversationId, runId: context.runId, hash,
            settled: false, promise: Promise.resolve(undefined as unknown as CommandResult) };
        const execute = () => this.start(args, context, resources, hash, deadline);
        attempt.promise = (this.workspace && args.writeSet?.length
            ? withDeclaredCommandWrites(this.workspace, args.writeSet, context, hash, execute) : execute())
            .finally(() => { attempt.settled = true; });
        this.attempts.set(key, attempt);
        return attempt.promise;
    }

    private async start(args: RestrictedCommandArguments, context: BoundToolContext, resources: ResourceRegistry | undefined, hash: string, deadline: number): Promise<CommandResult> {
        const resourceId = randomUUID();
        await resources?.trackAttempt('native.command', resourceId, 'process', hash, context);
        let receipt: RestrictedCommandReceipt;
        let launchInvoked = false;
        try {
            await context.assertCurrent?.();
            if (context.signal.aborted || deadline <= Date.now()) throw new AgentFault('TOOL_CANCELLED', '命令登记后已停止',
                { commandStarted: false, terminalConfirmed: true, cleanupState: 'released' });
            const launch = createWindowsJobLaunch(args.application, args.args, args.cwd, args.maxMemoryMB);
            if (!launch) throw new AgentFault('COMMAND_CAPABILITY_UNAVAILABLE', '仅支持Windows Job启动',
                { commandStarted: false, terminalConfirmed: true, cleanupState: 'released' });
            if (this.options.receiptDirectory) {
                await mkdir(this.options.receiptDirectory, { recursive: true });
                launch.metadataPath = path.join(this.options.receiptDirectory, resourceId + '.job.json');
                launch.args[launch.args.indexOf('--metadata') + 1] = launch.metadataPath;
            }
            const controlPath = launch.metadataPath + '.control';
            const controlFlag = launch.args.indexOf('--control-file');
            if (controlFlag >= 0) launch.args[controlFlag + 1] = controlPath;
            else launch.args.splice(launch.args.indexOf('--'), 0, '--control-file', controlPath);
            await resources?.settleTracked(resourceId, { started: null, terminalConfirmed: false, released: false,
                evidence: { resourceId, actionId: context.actionId, attemptId: context.attemptId, argsHash: hash,
                    policyRevision: context.policyRevision, commandStartedKnown: false,
                    recoveryMetadataPath: launch.metadataPath, recoveryState: 'original_receipt_pending' } }, context);
            launchInvoked = true;
            receipt = await this.launch(args, context, resourceId, hash, deadline, launch, controlPath);
        } catch (error) {
            const fault = error instanceof WindowsJobLaunchError ? new AgentFault('COMMAND_START_FAILED', error.message,
                { commandStarted: false, terminalConfirmed: true, cleanupState: 'released', startErrorType: error.errorType })
                : !launchInvoked ? new AgentFault(error instanceof AgentFault ? error.code : 'COMMAND_START_FAILED',
                    error instanceof Error ? error.message : '普通命令尚未启动', {
                        ...(error instanceof AgentFault ? error.details : {}), commandStarted: false,
                        terminalConfirmed: true, cleanupState: 'released' }, false) : error;
            const details = fault instanceof AgentFault ? fault.details : undefined;
            await resources?.settleTracked(resourceId, { started: typeof details?.commandStarted === 'boolean' ? details.commandStarted : null,
                terminalConfirmed: details?.terminalConfirmed === true, released: details?.cleanupState === 'released',
                evidence: { code: fault instanceof AgentFault ? fault.code : 'RESOURCE_UNRESOLVED', ...details } }, context);
            throw fault;
        }
        const resourceReceipt = commandResourceReceipt(receipt);
        await resources?.settleTracked(resourceId, resourceReceipt, context);
        if (!receipt.commandStarted && typeof receipt.startErrorType === 'string') {
            throw new AgentFault('COMMAND_START_FAILED', '普通程序未能启动，请核对程序路径与工作目录', commandEvidence(receipt), false);
        }
        if (!receipt.terminalConfirmed || receipt.cleanupState !== 'released') throw new AgentFault('RESOURCE_RELEASE_PENDING',
            '原命令终态待核对，已保存有界输出和原资源回执，停止自动重发，请按原动作查询',
            { ...resourceReceipt.evidence, requestId: resourceId, manualReviewRequired: true, stopAutomaticRetry: true }, receipt.mayHaveStarted === true);
        return { ...receipt, stdout: Buffer.from(receipt.stdoutBase64, 'base64').toString('utf8'),
            stderr: Buffer.from(receipt.stderrBase64, 'base64').toString('utf8'), coverage: {
                roots: [...context.roots], include: args.writeSet ?? [], restoreSupport: 'external_untracked',
                processEvidenceScope: receipt.processEvidenceScope,
                unknownEffects: ['普通命令内部文件操作遵守当前任务规则，已声明写集合以外的改动不自动撤回', '联网产生的远端效果'],
            } };
    }

    private async launch(args: RestrictedCommandArguments, context: BoundToolContext, resourceId: string, hash: string,
        deadline: number, launch: NonNullable<ReturnType<typeof createWindowsJobLaunch>>, controlPath: string): Promise<RestrictedCommandReceipt> {
        const environment = helperEnvironment();
        environment.PATH = [path.dirname(args.application), environment.PATH].filter(Boolean).join(path.delimiter);
        const child = spawn(launch.command, launch.args, { cwd: launch.spawnCwd, env: environment,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
        let cancel = () => {};
        const completion = new Promise<RestrictedCommandReceipt>(resolve => {
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let retainedBytes = 0;
            let observedBytes = 0;
            let helperSpawned = false;
            let helperExited = false;
            let helperExitCode: number | null = null;
            let helperSignal: string | null = null;
            let stopReason: string | null = null;
            let spawnError: string | null = null;
            let finishing = false;
            let forcedStop = false;
            let stopTimer: ReturnType<typeof setTimeout> | undefined;
            let stopWrite: Promise<void> | undefined;
            const stop = (reason: string) => {
                if (stopReason) return;
                stopReason = reason;
                stopWrite = writeFile(controlPath, 'cancel', 'utf8').catch(() => {});
                stopTimer = setTimeout(() => { forcedStop = true; child.kill(); }, 5000);
            };
            cancel = () => stop('cancelled');
            const abort = () => stop('cancelled');
            const timeout = Math.max(1, Math.min(args.timeoutMs, deadline - Date.now(), 2147483647));
            const timer = setTimeout(() => stop(Date.now() >= deadline ? 'deadline' : 'timeout'), timeout);
            const collect = (target: Buffer[], chunk: Buffer) => {
                observedBytes += chunk.length;
                const keep = Math.min(chunk.length, args.maxOutputBytes - retainedBytes);
                if (keep > 0) { target.push(Buffer.from(chunk.subarray(0, keep))); retainedBytes += keep; }
                if (observedBytes > args.maxOutputBytes) stop('output_limit');
            };
            const finish = async () => {
                if (finishing) return;
                finishing = true;
                clearTimeout(timer);
                clearTimeout(stopTimer);
                context.signal.removeEventListener('abort', abort);
                const metadata = readWindowsJobMetadata(launch.metadataPath);
                const extended = metadata as (typeof metadata & { terminalConfirmed?: boolean; activeProcessesAtRelease?: number; cleanupState?: string });
                const commandStarted = metadata?.commandStarted === true;
                const startedKnown = metadata !== null || !helperSpawned;
                const terminalConfirmed = !helperSpawned || helperExited && !forcedStop && extended?.terminalConfirmed === true
                    && extended.activeProcessesAtRelease === 0 && extended.cleanupState === 'released';
                const receipt: RestrictedCommandReceipt = { resourceId, actionId: context.actionId, attemptId: context.attemptId,
                    policyRevision: context.policyRevision, argsHash: hash, commandStarted, commandStartedKnown: startedKnown,
                    mayHaveStarted: commandStarted || helperSpawned && metadata === null,
                    terminalConfirmed, cleanupState: terminalConfirmed ? 'released' : 'unconfirmed',
                    helperPid: child.pid ?? null, helperExited, helperExitCode, helperSignal, spawnError, forcedStop,
                    childExitCode: metadata?.childExitCode ?? null, stopReason: metadata?.memoryLimitHit ? 'memory' : stopReason,
                    peakMemoryBytes: metadata?.peakMemoryBytes ?? null, activeProcessesAtRelease: extended?.activeProcessesAtRelease ?? null,
                    startErrorType: metadata?.startErrorType ?? (!helperSpawned && spawnError ? 'windows_job_runner_spawn_failed' : null),
                    startErrorCode: metadata?.startErrorCode ?? null,
                    stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64'),
                    outputTruncated: observedBytes > args.maxOutputBytes, outputBytes: retainedBytes, observedBytes,
                    processEvidenceScope: 'windows_job_active_process_count_and_helper_exit',
                    ...(!terminalConfirmed ? { recoveryMetadataPath: launch.metadataPath, jobMetadata: metadata } : {}) };
                if (this.options.receiptDirectory) {
                    try { await writeFile(path.join(this.options.receiptDirectory, resourceId + '.receipt.json'), JSON.stringify(receipt, null, 2), 'utf8'); }
                    catch { receipt.receiptWriteFailed = true; }
                } else if (terminalConfirmed) await rm(launch.metadataPath, { force: true }).catch(() => {});
                await stopWrite;
                await rm(controlPath, { force: true }).catch(() => {});
                resolve(receipt);
            };
            child.once('spawn', () => { helperSpawned = true; if (context.signal.aborted) abort(); });
            child.stdout.on('data', chunk => collect(stdout, chunk));
            child.stderr.on('data', chunk => collect(stderr, chunk));
            child.stdin.on('error', () => {});
            child.once('error', error => { spawnError = error.message; });
            child.once('exit', (code, signal) => { helperExited = true; helperExitCode = code; helperSignal = signal; });
            child.once('close', () => { void finish(); });
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted) abort();
            child.stdin.end(args.stdin ?? '', 'utf8');
        });
        this.runningCommands.set(resourceId, { cancel, completion });
        try { return await completion; }
        finally { this.runningCommands.delete(resourceId); }
    }
}

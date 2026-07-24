import { spawn } from "node:child_process";
import type { FailureClass } from "./record-scheduler-contracts.js";
import { getProviderTransportAdapter, mapProviderTrafficClass, type ProviderTransportLease, type ProviderTransportSettlementKind } from "./provider-transport-adapter.js";
import type { ProviderTrafficClass } from "./provider-control-contracts.js";
import { ProviderAdmissionCancelledError } from "./provider-admission.js";

export const AGY_MODEL_SEQUENCE = [
    "Gemini 3.5 Flash (High)",
    "Gemini 3.5 Flash (Medium)",
    "Gemini 3.1 Pro (Low)",
] as const;

export type AgyModel = typeof AGY_MODEL_SEQUENCE[number];

export interface AgyInvocationOptions {
    command?: string;
    commandArgs?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    trafficClass?: ProviderTrafficClass;
    probe?: boolean;
    providerLease?: ProviderTransportLease;
    attemptId?: string;
}

export interface AgyExecResult {
    text: string | null;
    model: AgyModel;
    elapsedMs: number;
    launched: boolean;
    stdout: string;
    stderr: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
    failureClass?: FailureClass;
    timedOut?: boolean;
    cancelled?: boolean;
    truncated?: boolean;
}

export interface AgyAttempt {
    model: AgyModel;
    launched: boolean;
    exitCode?: number | null;
    error?: string;
    failureClass?: FailureClass;
    timedOut?: boolean;
    cancelled?: boolean;
    truncated?: boolean;
}

export interface AgyFallbackResult extends AgyExecResult {
    attempts: readonly AgyAttempt[];
}

export interface AgyProbeResult {
    available: boolean;
    result: AgyExecResult;
}

type TerminationReason = "abort" | "timeout" | "output_limit";

interface OutputCapture {
    chunks: Buffer[];
}

interface OutputBudget {
    limitBytes: number;
    capturedBytes: number;
    totalBytes: number;
    truncated: boolean;
}

export type AgyTerminationPolicy =
    | { strategy: "windows_taskkill"; timeoutMs: number }
    | { strategy: "posix_process_group"; termSignal: "SIGTERM"; killSignal: "SIGKILL"; graceMs: number };

const DEFAULT_AGY_COMMAND = "agy";
const DEFAULT_AGY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_AGY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_AGY_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_AGY_TERM_GRACE_MS = 500;
const AGY_PROBE_TIMEOUT_MS = 15_000;
export const AGY_MAX_PROMPT_UTF16_CODE_UNITS = 24_000;
export const AGY_WINDOWS_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS = 32_767;
export const AGY_WINDOWS_COMMAND_LINE_SAFETY_RESERVE_UTF16_CODE_UNITS = 1_024;
export const AGY_WINDOWS_SAFE_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS = AGY_WINDOWS_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS
    - AGY_WINDOWS_COMMAND_LINE_SAFETY_RESERVE_UTF16_CODE_UNITS;
export const AGY_PROBE_PROMPT = "Reply with OK.";

const RESERVED_COMMAND_ARGS = [
    "-p",
    "--print",
    "--prompt",
    "--model",
    "--sandbox",
] as const;
const DANGEROUS_COMMAND_ARG = "--dangerously-skip-permissions";
const AGY_GRANTED_TRANSPORT = Symbol("agy-granted-transport");

type AgyInternalInvocationOptions = AgyInvocationOptions & {
    [AGY_GRANTED_TRANSPORT]?: true;
};

function isGrantedTransportExecution(options: AgyInvocationOptions): boolean {
    return (options as AgyInternalInvocationOptions)[AGY_GRANTED_TRANSPORT] === true;
}

function readPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCommand(options: AgyInvocationOptions): string {
    return options.command || process.env.MEMORY_STORE_AGY_COMMAND || DEFAULT_AGY_COMMAND;
}

function resolveTimeoutMs(options: AgyInvocationOptions, fallback = DEFAULT_AGY_TIMEOUT_MS): number {
    return readPositiveInteger(options.timeoutMs, fallback);
}

function resolveMaxOutputBytes(options: AgyInvocationOptions): number {
    return readPositiveInteger(options.maxOutputBytes ?? process.env.MEMORY_STORE_AGY_MAX_OUTPUT_BYTES, DEFAULT_AGY_MAX_OUTPUT_BYTES);
}

function resolveKillTimeoutMs(): number {
    return readPositiveInteger(process.env.MEMORY_STORE_AGY_KILL_TIMEOUT_MS, DEFAULT_AGY_KILL_TIMEOUT_MS);
}

function resolveTermGraceMs(): number {
    return readPositiveInteger(process.env.MEMORY_STORE_AGY_TERM_GRACE_MS, DEFAULT_AGY_TERM_GRACE_MS);
}

export function getAgyTerminationPolicy(platform: NodeJS.Platform = process.platform): AgyTerminationPolicy {
    return platform === "win32"
        ? { strategy: "windows_taskkill", timeoutMs: resolveKillTimeoutMs() }
        : { strategy: "posix_process_group", termSignal: "SIGTERM", killSignal: "SIGKILL", graceMs: resolveTermGraceMs() };
}

function quoteWindowsCommandLineArgument(argument: string): string {
    if (argument && !/[\s"]/u.test(argument)) return argument;
    let quoted = "\"";
    let backslashes = 0;
    for (const character of argument) {
        if (character === "\\") {
            backslashes += 1;
            continue;
        }
        if (character === "\"") {
            quoted += "\\".repeat(backslashes * 2 + 1);
            backslashes = 0;
            quoted += "\"";
            continue;
        }
        if (backslashes > 0) quoted += "\\".repeat(backslashes);
        backslashes = 0;
        quoted += character;
    }
    quoted += "\\".repeat(backslashes * 2);
    return `${quoted}\"`;
}

export function measureAgyWindowsCommandLineUtf16CodeUnits(command: string, args: readonly string[]): number {
    return [command, ...args]
        .map(quoteWindowsCommandLineArgument)
        .join(" ")
        .length + 1;
}

function invalidInputResult(model: AgyModel, startedAt: number, error: string): AgyExecResult {
    return {
        text: null,
        model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        launched: false,
        stdout: "",
        stderr: "",
        error,
        failureClass: "DeterministicInput",
    };
}

function validateCommandArgs(commandArgs: readonly string[]): string | null {
    for (const argument of commandArgs) {
        if (argument.includes("\0")) return "agy commandArgs 含 NUL，禁止启动";
        if (argument === DANGEROUS_COMMAND_ARG || argument.startsWith(`${DANGEROUS_COMMAND_ARG}=`)) {
            return `agy commandArgs 禁止危险 flag ${DANGEROUS_COMMAND_ARG}`;
        }
        const reserved = RESERVED_COMMAND_ARGS.find(flag => argument === flag || argument.startsWith(`${flag}=`));
        if (reserved) return `agy commandArgs 禁止覆盖保留 flag ${reserved}`;
        if (argument.startsWith("-")) return `agy commandArgs 只允许安全的启动器位置参数，拒绝 flag ${argument}`;
    }
    return null;
}

function validateAgyInvocation(
    command: string,
    commandArgs: readonly string[],
    args: readonly string[],
    prompt: string,
): string | null {
    const commandArgsError = validateCommandArgs(commandArgs);
    if (commandArgsError) return commandArgsError;
    if (command.includes("\0") || prompt.includes("\0")) return "agy command 或 prompt 含 NUL，禁止启动";
    if (prompt.length > AGY_MAX_PROMPT_UTF16_CODE_UNITS) {
        return `agy prompt 超过安全上限 ${AGY_MAX_PROMPT_UTF16_CODE_UNITS} UTF-16 code units`;
    }
    if (process.platform !== "win32") return null;
    const codeUnits = measureAgyWindowsCommandLineUtf16CodeUnits(command, args);
    if (codeUnits > AGY_WINDOWS_SAFE_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS) {
        return `agy Windows 命令行需要 ${codeUnits} UTF-16 code units，超过保守预算 ${AGY_WINDOWS_SAFE_COMMAND_LINE_LIMIT_UTF16_CODE_UNITS}`;
    }
    return null;
}

function createCapture(): OutputCapture {
    return { chunks: [] };
}

function createOutputBudget(limitBytes: number): OutputBudget {
    return { limitBytes, capturedBytes: 0, totalBytes: 0, truncated: false };
}

function appendCapture(capture: OutputCapture, budget: OutputBudget, chunk: Buffer | string): boolean {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    budget.totalBytes += buffer.length;
    const remaining = Math.max(0, budget.limitBytes - budget.capturedBytes);
    if (remaining > 0) {
        const retained = buffer.subarray(0, remaining);
        capture.chunks.push(retained);
        budget.capturedBytes += retained.length;
    }
    if (budget.totalBytes > budget.limitBytes) budget.truncated = true;
    return budget.truncated;
}

function captureText(capture: OutputCapture): string {
    return Buffer.concat(capture.chunks).toString("utf8");
}

function previewStderr(stderr: string): string {
    return stderr
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" | ");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function cancelUnusedProviderLease(lease: ProviderTransportLease | undefined): Promise<void> {
    if (!lease) return;
    try {
        await getProviderTransportAdapter().cancel(lease);
    } catch {}
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}

function classifySpawnError(error: unknown): FailureClass {
    const code = errorCode(error);
    if (["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"].includes(code || "")) return "LocalResource";
    return "Availability";
}

function classifyExit(stderr: string, stdout: string): FailureClass {
    const detail = `${stderr}\n${stdout}`.toLowerCase();
    if (/(429|resource exhausted|rate limit|too many requests|quota exceeded|overloaded)/u.test(detail)) return "Congestion";
    if (/(out of memory|not enough memory|enomem|eagain|emfile|enfile)/u.test(detail)) return "LocalResource";
    if (/(unknown|invalid|unsupported).{0,80}model|model.{0,80}(unknown|invalid|unsupported)/u.test(detail)) return "DeterministicInput";
    if (/(not logged in|login|required authentication|unauthenticated|credential|connection refused|network unreachable|dns)/u.test(detail)) return "Availability";
    return "Availability";
}

function classifyAgyTransportResult(result: AgyExecResult): ProviderTransportSettlementKind {
    if (result.text !== null) return "success";
    if (result.timedOut || result.cancelled) return "unknown";
    if (result.failureClass === "Congestion") return "congestion";
    if (result.failureClass === "Availability") return "availability";
    if (result.failureClass === "LocalResource") return "local-resource";
    return "unknown";
}

function terminationResult(
    reason: TerminationReason,
    model: AgyModel,
    startedAt: number,
    launched: boolean,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    closeSignal: NodeJS.Signals | null,
): AgyExecResult {
    if (reason === "abort") {
        return {
            text: null,
            model,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            launched,
            stdout,
            stderr,
            exitCode,
            signal: closeSignal,
            error: "agy CLI 调用已取消",
            failureClass: launched ? "UnknownOutcome" : undefined,
            cancelled: true,
        };
    }
    if (reason === "timeout") {
        return {
            text: null,
            model,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            launched,
            stdout,
            stderr,
            exitCode,
            signal: closeSignal,
            error: "agy CLI 调用超时",
            failureClass: "UnknownOutcome",
            timedOut: true,
        };
    }
    return {
        text: null,
        model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        launched,
        stdout,
        stderr,
        exitCode,
        signal: closeSignal,
        error: "agy CLI 输出超过安全上限，已截断并终止进程",
        failureClass: "Complexity",
        truncated: true,
    };
}

function signalPosixProcessTree(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
        process.kill(-pid, signal);
        return true;
    } catch {
        try {
            process.kill(pid, signal);
            return true;
        } catch {
            return false;
        }
    }
}

async function waitForPosixProcessTreeExit(pid: number, graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        if (!signalPosixProcessTree(pid, 0)) return true;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return !signalPosixProcessTree(pid, 0);
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
    if (!pid) return;
    const policy = getAgyTerminationPolicy();
    if (policy.strategy === "posix_process_group") {
        if (!signalPosixProcessTree(pid, policy.termSignal)) return;
        if (await waitForPosixProcessTreeExit(pid, policy.graceMs)) return;
        signalPosixProcessTree(pid, policy.killSignal);
        return;
    }
    await new Promise<void>(resolve => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve();
        };
        let killer;
        try {
            killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                stdio: ["ignore", "ignore", "ignore"],
                windowsHide: true,
                shell: false,
            });
        } catch {
            finish();
            return;
        }
        timer = setTimeout(() => {
            try {
                killer.kill();
            } catch {
                finish();
                return;
            }
            finish();
        }, policy.timeoutMs);
        timer.unref?.();
        killer.once("error", finish);
        killer.once("close", finish);
    });
}

function isFallbackEligible(result: AgyExecResult): boolean {
    return result.launched
        && !result.cancelled
        && !result.timedOut
        && !result.truncated
        && result.failureClass !== "LocalResource"
        && result.failureClass !== "UnknownOutcome";
}

function toAttempt(result: AgyExecResult): AgyAttempt {
    return {
        model: result.model,
        launched: result.launched,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.cancelled ? { cancelled: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
    };
}

function timeoutBeforeFallback(model: AgyModel, startedAt: number): AgyExecResult {
    return {
        text: null,
        model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        launched: false,
        stdout: "",
        stderr: "",
        error: "agy CLI 调用超时",
        failureClass: "UnknownOutcome",
        timedOut: true,
    };
}

export async function callAgyModel(
    prompt: string,
    model: AgyModel,
    options: AgyInvocationOptions = {},
): Promise<AgyExecResult> {
    try {
    const startedAt = Date.now();
    if (options.signal?.aborted) {
        return terminationResult("abort", model, startedAt, false, "", "", null, null);
    }
    const maxOutputBytes = resolveMaxOutputBytes(options);
    const command = resolveCommand(options);
    const commandArgs = options.commandArgs || [];
    const args = [
        ...commandArgs,
        "-p", prompt,
        "--sandbox",
        "--model", model,
    ];
    const inputError = validateAgyInvocation(command, commandArgs, args, prompt);
    if (inputError) return invalidInputResult(model, startedAt, inputError);
    const stdoutCapture = createCapture();
    const stderrCapture = createCapture();
    const outputBudget = createOutputBudget(maxOutputBytes);
    const timeoutMs = resolveTimeoutMs(options);

    try {
        const executeAgy = () => {
                if (options.signal?.aborted) {
                    return Promise.resolve(terminationResult("abort", model, startedAt, false, "", "", null, null));
                }
                return new Promise<AgyExecResult>(resolve => {
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd || process.cwd(),
                env: options.env || process.env,
                detached: process.platform !== "win32",
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            resolve({
                text: null,
                model,
                elapsedMs: Math.max(0, Date.now() - startedAt),
                launched: false,
                stdout: "",
                stderr: "",
                error: `agy CLI 启动失败: ${errorMessage(error)}`,
                failureClass: classifySpawnError(error),
            });
            return;
        }

        let launched = false;
        let settled = false;
        let closeCode: number | null = null;
        let closeSignal: NodeJS.Signals | null = null;
        let streamError: string | null = null;
        let terminationReason: TerminationReason | null = null;
        let terminationPromise: Promise<void> | null = null;

        const cleanup = () => {
            clearTimeout(timeoutTimer);
            options.signal?.removeEventListener("abort", onAbort);
        };
        const finish = (result: AgyExecResult) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const currentOutput = () => ({ stdout: captureText(stdoutCapture), stderr: captureText(stderrCapture) });
        const finishTermination = () => {
            if (!terminationReason) return;
            const output = currentOutput();
            finish(terminationResult(
                terminationReason,
                model,
                startedAt,
                launched,
                output.stdout,
                output.stderr,
                closeCode,
                closeSignal,
            ));
        };
        const requestTermination = (reason: TerminationReason) => {
            if (terminationReason || settled) return;
            terminationReason = reason;
            terminationPromise = terminateProcessTree(child.pid);
            void terminationPromise.finally(finishTermination);
        };
        const onAbort = () => requestTermination("abort");
        const timeoutTimer = setTimeout(() => requestTermination("timeout"), timeoutMs);
        timeoutTimer.unref?.();

        if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

        child.once("spawn", () => {
            launched = true;
        });
        child.stdout.on("data", chunk => {
            if (appendCapture(stdoutCapture, outputBudget, chunk)) requestTermination("output_limit");
        });
        child.stderr.on("data", chunk => {
            if (appendCapture(stderrCapture, outputBudget, chunk)) requestTermination("output_limit");
        });
        child.stdout.on("error", error => {
            streamError = errorMessage(error);
        });
        child.stderr.on("error", error => {
            streamError = errorMessage(error);
        });
        child.once("error", error => {
            if (terminationReason) return;
            const output = currentOutput();
            finish({
                text: null,
                model,
                elapsedMs: Math.max(0, Date.now() - startedAt),
                launched,
                stdout: output.stdout,
                stderr: output.stderr,
                error: `agy CLI 启动失败: ${errorMessage(error)}`,
                failureClass: classifySpawnError(error),
            });
        });
        child.once("close", (code, signal) => {
            closeCode = code;
            closeSignal = signal;
            if (terminationReason) {
                if (terminationPromise) void terminationPromise.finally(finishTermination);
                return;
            }
            const output = currentOutput();
            if (outputBudget.truncated) {
                finish(terminationResult("output_limit", model, startedAt, launched, output.stdout, output.stderr, code, signal));
                return;
            }
            if (streamError) {
                finish({
                    text: null,
                    model,
                    elapsedMs: Math.max(0, Date.now() - startedAt),
                    launched,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    exitCode: code,
                    signal,
                    error: `agy CLI I/O 异常: ${streamError}`,
                    failureClass: "UnknownOutcome",
                });
                return;
            }
            if (code !== 0) {
                const stderrSummary = previewStderr(output.stderr);
                finish({
                    text: null,
                    model,
                    elapsedMs: Math.max(0, Date.now() - startedAt),
                    launched,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    exitCode: code,
                    signal,
                    error: stderrSummary
                        ? `agy CLI 调用失败: ${stderrSummary}`
                        : `agy CLI 调用失败，退出码 ${code ?? "unknown"}`,
                    failureClass: classifyExit(output.stderr, output.stdout),
                });
                return;
            }
            const text = output.stdout.trim();
            if (!text) {
                finish({
                    text: null,
                    model,
                    elapsedMs: Math.max(0, Date.now() - startedAt),
                    launched,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    exitCode: code,
                    signal,
                    error: "agy CLI 输出为空",
                    failureClass: "Quality",
                });
                return;
            }
            finish({
                text,
                model,
                elapsedMs: Math.max(0, Date.now() - startedAt),
                launched,
                stdout: output.stdout,
                stderr: output.stderr,
                exitCode: code,
                signal,
            });
        });
                });
        };
        if (isGrantedTransportExecution(options)) return await executeAgy();
        const adapter = getProviderTransportAdapter();
        return await (options.providerLease
            ? adapter.executeGranted(options.providerLease, executeAgy, classifyAgyTransportResult)
            : adapter.execute(
                "agy",
                {
                    trafficClass: mapProviderTrafficClass(options.trafficClass),
                    signal: options.signal,
                    probe: options.probe,
                    attemptId: options.attemptId,
                },
                executeAgy,
                classifyAgyTransportResult,
            ));
    } catch (error) {
        if (error instanceof ProviderAdmissionCancelledError) {
            return terminationResult("abort", model, startedAt, false, "", "", null, null);
        }
        throw error;
    }
    } finally {
        await cancelUnusedProviderLease(options.providerLease);
    }
}

export async function callAgyWithFallback(
    prompt: string,
    options: AgyInvocationOptions = {},
): Promise<AgyFallbackResult> {
    try {
    if (options.providerLease) {
        const grantedOptions: AgyInternalInvocationOptions = {
            ...options,
            providerLease: undefined,
            [AGY_GRANTED_TRANSPORT]: true,
        };
        return await getProviderTransportAdapter().executeGranted(
            options.providerLease,
            () => callAgyFallbackSequence(prompt, grantedOptions),
            result => classifyAgyTransportResult(result),
        );
    }
    return await callAgyFallbackSequence(prompt, options);
    } finally {
        await cancelUnusedProviderLease(options.providerLease);
    }
}

async function callAgyFallbackSequence(
    prompt: string,
    options: AgyInvocationOptions,
): Promise<AgyFallbackResult> {
    const startedAt = Date.now();
    const timeoutMs = resolveTimeoutMs(options);
    const attempts: AgyAttempt[] = [];
    let latest: AgyExecResult | null = null;
    for (const model of AGY_MODEL_SEQUENCE) {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        const result = remainingMs > 0
            ? await callAgyModel(prompt, model, { ...options, timeoutMs: remainingMs })
            : timeoutBeforeFallback(model, startedAt);
        attempts.push(toAttempt(result));
        latest = result;
        if (result.text !== null || !isFallbackEligible(result)) {
            return { ...result, attempts };
        }
    }
    if (!latest) {
        const result = timeoutBeforeFallback(AGY_MODEL_SEQUENCE[0], startedAt);
        return { ...result, attempts: [toAttempt(result)] };
    }
    return { ...latest, attempts };
}

export async function probeAgy(options: AgyInvocationOptions = {}): Promise<AgyProbeResult> {
    const result = await callAgyModel(AGY_PROBE_PROMPT, AGY_MODEL_SEQUENCE[0], {
        ...options,
        timeoutMs: options.timeoutMs ?? AGY_PROBE_TIMEOUT_MS,
        probe: true,
    });
    return { available: result.text !== null, result };
}

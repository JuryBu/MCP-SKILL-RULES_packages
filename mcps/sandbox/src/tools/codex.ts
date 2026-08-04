import { spawn, spawnSync, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { killProcessTree } from "../executor.js";
import { touchActivity, appendTiming, formatElapsed } from "../lifecycle.js";
import pidusage from "pidusage";
import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "../owner.js";
import { acquireResourceLease, serializeResourceAdmissionError, type ManagedResourceLease } from "../resource-admission-runtime.js";
import {
    createOutputDeliveryCollector,
    type OutputDeliveryCollector,
    type OutputDeliveryMode,
    type OutputDeliveryResult,
} from "../output-delivery.js";

/**
 * sandbox_codex 工具 — Codex CLI 专用调用（v1.2 后台模式）
 *
 * 核心设计变更（v1.2）：
 * - 新增后台模式（background=true）：启动后立刻返回 taskId
 * - 支持 action: check/wait/kill 管理后台任务
 * - stderr 智能过滤（去除 mcp: 调试行，上限 2000 字符）
 * - 上下文保护（有 outputFile 且报告已生成时压缩 stdout）
 * - 维护 Map<string, CodexTask> 任务池，进程自动清理
 */

// ── 类型定义 ──

interface CodexTask {
    id: string;
    ownerId: string;
    proc: ChildProcess;
    pid: number;
    startTime: number;
    queueWaitMs: number;
    status: "running" | "done" | "failed" | "killed";
    exitCode: number | null;
    killed: boolean;
    killReason: string | null;
    peakMemoryMB: number;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutLines: number;
    stderrLines: number;
    outputFile?: string;
    outputFileBaselineSize: number; // 启动前文件大小（-1=不存在）
    maxOutput: number;
    deliveryMode: OutputDeliveryMode;
    outputCollector: OutputDeliveryCollector;
    outputDelivery: OutputDeliveryResult | null;
    resourceLease: ManagedResourceLease;
    lastCheckTime: number; // 上次 check 的时间戳（节流用）
    resolvers: Array<(result: string) => void>;
    memoryMonitor: NodeJS.Timeout | null;
    timeoutTimer: NodeJS.Timeout | null;
    terminationTimer: NodeJS.Timeout | null;
    cleanupTimer: NodeJS.Timeout | null;
    finalized: boolean;
    finalizing: boolean;
    terminate: (reason: string) => void;
    finalize: () => void;
}

class CodexStartCancelledError extends Error {
    constructor() {
        super("Codex 调用已取消，任务未启动");
        this.name = "CodexStartCancelledError";
    }
}

// ── 模型列表缓存（启动时从 Codex CLI 缓存文件读取一次） ──

let modelsDescription = "";
try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    if (fs.existsSync(cachePath)) {
        const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        const visible = (raw.models || [])
            .filter((m: any) => m.visibility === "list")
            .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
            .map((m: any) => ({
                slug: m.slug as string,
                levels: ((m.supported_reasoning_levels || []) as any[]).map((l: any) => l.effort as string),
                fast: ((m.additional_speed_tiers || []) as string[]).includes("fast"),
            }));
        if (visible.length > 0) {
            modelsDescription = "\n\n可用模型（从 ~/.codex/models_cache.json 动态加载，Codex CLI 自动更新）:\n" +
                visible.map((m: { slug: string; levels: string[]; fast: boolean }) =>
                    `  - ${m.slug}，支持 reasoning effort: ${m.levels.join(", ")}${m.fast ? "\n    ↳ 支持 fast speed tier（约1.5x加速）" : ""}`
                ).join("\n") +
                "\n\n⚠️ model 参数只传模型名（如 \"gpt-5.4\"），reasoning effort 通过 configOverrides=\"model_reasoning_effort=xhigh\" 单独指定，二者不能拼接！";
        }
    }
} catch { /* models_cache.json 不存在或格式异常，模型列表为空但 model 参数仍可用 */ }

// ── 任务池 ──

const taskPool = new Map<string, CodexTask>();

function generateTaskId(): string {
    return newUuid();
}

/**
 * 清理所有运行中的 Codex 任务（进程退出时调用）
 */
export function cleanupCodexTasks(): void {
    for (const [id, task] of taskPool) {
        task.terminate("shutdown");
        task.finalize();
        taskPool.delete(id);
    }
}

/**
 * 获取活跃任务数量（供 status 工具使用）
 */
export function getCodexTaskCount(): { running: number; total: number } {
    let running = 0;
    for (const task of taskPool.values()) {
        if (task.status === "running") running++;
    }
    return { running, total: taskPool.size };
}

// ── 工具函数 ──

function parseCodexBinArgs(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
            return parsed;
        }
    } catch {
        // Fall through to whitespace split for simple local overrides.
    }
    return raw.split(/\s+/u).filter(Boolean);
}

function findBundledWindowsCodex(): string | undefined {
    const candidates = [
        path.join(os.homedir(), ".codex", "plugins", ".plugin-appserver", "codex.exe"),
        path.join(os.homedir(), ".codex", ".sandbox-bin", "codex.exe"),
        path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin", "codex.exe"),
    ];
    const appBinRoot = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
    try {
        for (const entry of fs.readdirSync(appBinRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) candidates.push(path.join(appBinRoot, entry.name, "codex.exe"));
        }
    } catch {
    }
    return candidates
        .filter(candidate => candidate && fs.existsSync(candidate))
        .map(candidate => ({ candidate, modifiedAt: fs.statSync(candidate).mtimeMs }))
        .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.candidate;
}

function resolveCodexSpawnTarget(): { command: string; argsPrefix: string[] } {
    const override = process.env.SANDBOX_CODEX_BIN?.trim();
    if (override) {
        return { command: override, argsPrefix: parseCodexBinArgs(process.env.SANDBOX_CODEX_BIN_ARGS) };
    }
    if (process.platform !== "win32") {
        return { command: "codex", argsPrefix: [] };
    }
    const bundled = findBundledWindowsCodex();
    if (bundled) return { command: bundled, argsPrefix: [] };
    const probe = spawnSync("where.exe", ["codex"], {
        windowsHide: true,
        encoding: "utf-8",
    });
    const candidates = (probe.stdout || "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const executable = candidates.find((candidate) => /\.(exe|com)$/iu.test(candidate));
    if (executable) return { command: executable, argsPrefix: [] };
    const cmdShim = candidates.find((candidate) => /\.cmd$/iu.test(candidate))
        || path.join(process.env.APPDATA || "", "npm", "codex.cmd");
    const shimDir = path.dirname(cmdShim);
    const npmCodexJs = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(npmCodexJs)) {
        const localNode = path.join(shimDir, "node.exe");
        return { command: fs.existsSync(localNode) ? localNode : process.execPath, argsPrefix: [npmCodexJs] };
    }
    return { command: "codex.exe", argsPrefix: [] };
}

function assertNoNul(name: string, value: string): string {
    if (value.includes("\0")) {
        throw new Error(`${name} 不能包含 NUL 字符`);
    }
    return value;
}

function validateSimpleCodexValue(name: string, value: string): string {
    assertNoNul(name, value);
    if (!/^[a-zA-Z0-9._-]+$/u.test(value)) {
        throw new Error(`${name} 参数格式非法: ${value}`);
    }
    return value;
}

function validateCodexConfigOverride(value: string): string {
    assertNoNul("configOverrides", value);
    if (!/^[a-zA-Z0-9_.-]+=[a-zA-Z0-9_./:@,+-]+$/u.test(value)) {
        throw new Error(`configOverrides 参数格式非法: ${value}`);
    }
    return value;
}

function validateGitRefLike(name: string, value: string): string {
    assertNoNul(name, value);
    if (!/^[a-zA-Z0-9._/@:+-]+$/u.test(value)) {
        throw new Error(`${name} 参数格式非法: ${value}`);
    }
    return value;
}

/**
 * 过滤 stderr 中的噪音行
 * Codex 的 stderr 包含：启动横幅、MCP 启动/工具调用日志、token 计数等
 * 只保留真正的错误信息
 */
function filterStderr(raw: string): string {
    const lines = raw.split("\n");
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();

        // 空行
        if (trimmed === "") return false;

        // MCP 启动/关闭/工具调用行
        if (lower.startsWith("mcp:") || lower.startsWith("mcp ") || lower.startsWith("[mcp]")) return false;
        if (lower.startsWith("mcp startup:")) return false;

        // Codex 启动横幅（OpenAI Codex v...、--------、workdir:、model: 等）
        if (lower.startsWith("openai codex v")) return false;
        if (/^-{4,}$/.test(trimmed)) return false;  // --------
        if (lower.startsWith("workdir:")) return false;
        if (lower.startsWith("model:")) return false;
        if (lower.startsWith("provider:")) return false;
        if (lower.startsWith("approval:")) return false;
        if (lower.startsWith("sandbox:")) return false;
        if (lower.startsWith("reasoning effort:")) return false;
        if (lower.startsWith("reasoning summaries:")) return false;
        if (lower.startsWith("session id:")) return false;

        // Codex 执行日志（user/codex/tool/exec 单词行 + 工具调用行）
        if (/^(user|codex|exec)$/.test(trimmed)) return false;
        if (lower.startsWith("tool ")) return false;  // tool memory-store.xxx / tool web-fetcher.xxx
        if (/succe(ss|eded) in \d+/i.test(trimmed)) return false;  // xxx succeeded in 190ms: / success in 5ms:

        // session/token 计数行
        if (lower.includes("session_id") && lower.includes("token")) return false;
        if (lower.includes("tokens:") && lower.includes("input")) return false;

        // PowerShell 执行日志（Codex 内部 PS 调用产生）
        if (lower.startsWith("powershell") || lower.startsWith("ps ")) return false;
        if (lower.includes("encoding utf8") || lower.includes("-encoding utf8")) return false;
        // failed to refresh available models（Codex 内部模型刷新超时，无害）
        if (lower.includes("failed to refresh available models")) return false;

        // MCP 工具返回的 JSON 块（以 { 开头的行，通常是 MCP 工具调用的参数/返回值）
        if (/^\{.*\}$/.test(trimmed) && trimmed.length > 20) return false;

        return true;
    });
    return filtered.join("\n");
}

/**
 * 构建完整的 Codex 结果文本
 */
function buildResultText(task: CodexTask): string {
    const elapsed = formatElapsed(Date.now() - task.startTime);
    const parts: string[] = [];

    // 缓存报告检查结果（避免多次 IO）
    const reportInfo = task.outputFile ? checkReport(task.outputFile, task.outputFileBaselineSize, task.startTime) : null;

    // 状态行
    const success = task.exitCode === 0 && (!task.outputFile || (reportInfo?.generated ?? false));
    if (success) {
        parts.push(`✅ Codex 执行成功 | ${elapsed} | 内存峰值 ${Math.round(task.peakMemoryMB)}MB`);
    } else if (task.killed) {
        const status = task.killReason === "timeout"
            ? "execution_timeout（命令已启动后运行超时）"
            : `被终止 (${task.killReason})`;
        parts.push(`💀 Codex ${status} | ${elapsed}`);
    } else {
        parts.push(`❌ Codex 执行失败 (exit ${task.exitCode}) | ${elapsed}`);
    }

    // 报告信息
    if (task.outputFile && reportInfo) {
        if (reportInfo.generated) {
            parts.push(`📄 报告已生成: ${task.outputFile} (${reportInfo.size} bytes)`);
        } else if (reportInfo.size !== null) {
            parts.push(`⚠️ 报告文件为空或过小: ${task.outputFile} (${reportInfo.size} bytes)`);
        } else {
            parts.push(`❌ 报告文件未生成: ${task.outputFile}`);
        }
    }

    const delivery = task.outputDelivery;
    const channelText = (channel: "stdout" | "stderr"): string => {
        if (!delivery) return "";
        const inline = channel === "stdout" ? delivery.stdout : delivery.stderr;
        if (inline !== undefined) return inline;
        const preview = delivery.preview?.[channel];
        if (!preview) return "";
        if (!preview.head) return preview.tail;
        if (!preview.tail || preview.tail === preview.head) return preview.head;
        return `${preview.head}\n... (完整输出见 artifact) ...\n${preview.tail}`;
    };

    const stdout = channelText("stdout");
    if (stdout.trim()) {
        parts.push("");
        parts.push("📤 stdout:");
        parts.push(stdout);
    }

    const stderr = filterStderr(channelText("stderr"));
    if (stderr.trim()) {
        parts.push("");
        parts.push("⚠️ stderr:");
        parts.push(stderr);
    }

    if (delivery?.artifact) {
        parts.push("");
        parts.push(`📦 输出交付: ${delivery.mode} | complete=${delivery.complete} | status=${delivery.status}`);
        parts.push(`  artifactId: ${delivery.artifact.artifactId}`);
        parts.push(`  manifest: ${delivery.artifact.manifestPath}`);
        parts.push(`  stdout: ${delivery.stats.stdout.rawBytes} bytes / ${delivery.stats.stdout.lines} lines / sha256=${delivery.stats.stdout.sha256}`);
        parts.push(`  stderr: ${delivery.stats.stderr.rawBytes} bytes / ${delivery.stats.stderr.lines} lines / sha256=${delivery.stats.stderr.sha256}`);
        parts.push(`  estimatedTokens: ${delivery.stats.combined.estimatedTokens} | expiresAt: ${delivery.artifact.expiresAt}`);
        if (delivery.reasons.length > 0) parts.push(`  reasons: ${delivery.reasons.join(", ")}`);
        if (delivery.readHint) parts.push(`  readHint: ${delivery.readHint}`);
    }

    // 结构化数据摘要
    parts.push("");
    parts.push(`📊 success=${success} | exitCode=${task.exitCode} | killed=${task.killed} | reportGenerated=${reportInfo?.generated ?? false}${reportInfo?.size !== null ? ` | reportSize=${reportInfo?.size}` : ""}`);

    return parts.join("\n");
}

function checkReport(outputFile: string, baselineSize: number, taskStartTime: number): { generated: boolean; size: number | null } {
    try {
        if (fs.existsSync(outputFile)) {
            const stat = fs.statSync(outputFile);
            // 判断方式：文件 mtime > 任务启动时间 且 size > 10 bytes
            // 这比纯 size 比较更可靠（新报告可能比旧文件短）
            const mtimeMs = stat.mtimeMs;
            const isNew = stat.size > 10 && mtimeMs > taskStartTime;
            return { generated: isNew, size: stat.size };
        }
    } catch { /* ignore */ }
    return { generated: false, size: null };
}

type CodexWaitOutcome = "completed" | "timeout" | "aborted";

function removeTaskResolver(task: CodexTask, resolver: (result: string) => void): void {
    const index = task.resolvers.indexOf(resolver);
    if (index !== -1) task.resolvers.splice(index, 1);
}

async function waitForCodexCompletion(task: CodexTask, waitSeconds: number, signal?: AbortSignal): Promise<CodexWaitOutcome> {
    const waitMs = Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    if (signal?.aborted) return "aborted";
    if (task.status !== "running") return "completed";
    if (waitMs <= 0) return "timeout";

    return new Promise<CodexWaitOutcome>((resolve) => {
        let done = false;
        const finish = (outcome: CodexWaitOutcome) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            removeTaskResolver(task, onTaskDone);
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
        };
        const onTaskDone = () => finish("completed");
        const onAbort = () => finish("aborted");

        const timer = setTimeout(() => finish("timeout"), waitMs);
        task.resolvers.push(onTaskDone);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer.unref?.();
    });
}

async function waitForCodexResult(
    task: CodexTask,
    signal: AbortSignal | undefined,
    terminateOnAbort: boolean,
): Promise<{ aborted: boolean; resultText: string }> {
    if (task.status !== "running") {
        return { aborted: false, resultText: buildResultText(task) };
    }

    return new Promise((resolve) => {
        let done = false;
        const finish = (aborted: boolean, resultText: string) => {
            if (done) return;
            done = true;
            removeTaskResolver(task, onTaskDone);
            signal?.removeEventListener("abort", onAbort);
            resolve({ aborted, resultText });
        };
        const onTaskDone = (resultText: string) => finish(false, resultText);
        const onAbort = () => {
            if (terminateOnAbort) {
                task.terminate("cancelled");
                return;
            }
            finish(true, `⏹️ 已取消等待任务 ${task.id}，后台任务继续运行`);
        };

        task.resolvers.push(onTaskDone);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

// ── 启动 Codex 进程 ──

async function startCodexProcess(params: {
    prompt: string;
    outputFile?: string;
    cwd?: string;
    timeout: number;
    configOverrides?: string;
    maxOutput: number;
    model?: string;
    image?: string;
    json?: boolean;
    outputSchema?: string;
    enableFeatures?: string[];
    disableFeatures?: string[];
    reviewMode?: { uncommitted?: boolean; base?: string; commit?: string; title?: string };
    ownerId?: string;
    deliveryMode?: OutputDeliveryMode;
    signal?: AbortSignal;
    admissionBudgetMs?: number;
    retryAttempt?: number;
}): Promise<CodexTask> {
    const { prompt, outputFile, cwd, timeout, configOverrides, maxOutput, model,
        image, json: jsonMode, outputSchema, enableFeatures, disableFeatures, reviewMode } = params;
    const taskId = generateTaskId();

    const codexTarget = resolveCodexSpawnTarget();
    const cmdArgs: string[] = [
        ...codexTarget.argsPrefix,
        "exec",
    ];

    // exec review 子命令
    if (reviewMode) {
        cmdArgs.push("review");
        if (reviewMode.uncommitted) cmdArgs.push("--uncommitted");
        if (reviewMode.base) cmdArgs.push("--base", validateGitRefLike("review.base", reviewMode.base));
        if (reviewMode.commit) cmdArgs.push("--commit", validateGitRefLike("review.commit", reviewMode.commit));
        if (reviewMode.title) cmdArgs.push("--title", assertNoNul("review.title", reviewMode.title));
    }

    cmdArgs.push(
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "--skip-git-repo-check",
    );

    if (model) {
        cmdArgs.push("-m", validateSimpleCodexValue("model", model));
    }

    if (configOverrides) {
        cmdArgs.push("-c", validateCodexConfigOverride(configOverrides));
    }

    // 新参数映射
    if (image) {
        if (!fs.existsSync(image)) {
            throw new Error(`图片文件不存在: ${image}`);
        }
        cmdArgs.push("-i", assertNoNul("image", image));
    }
    if (jsonMode) cmdArgs.push("--json");
    if (outputSchema) cmdArgs.push("--output-schema", assertNoNul("outputSchema", outputSchema));
    if (enableFeatures) {
        for (const f of enableFeatures) cmdArgs.push("--enable", validateSimpleCodexValue("enableFeatures", f));
    }
    if (disableFeatures) {
        for (const f of disableFeatures) cmdArgs.push("--disable", validateSimpleCodexValue("disableFeatures", f));
    }

    if (outputFile) {
        const outputDir = path.dirname(outputFile);
        if (!fs.existsSync(outputDir)) {
            try { fs.mkdirSync(outputDir, { recursive: true }); } catch { /* ignore */ }
        }
        cmdArgs.push("-o", assertNoNul("outputFile", outputFile));
    }

    // 自动附加 outputFile 提示到 prompt（减少手动重复）
    // review 模式下如果有 --uncommitted/--base/--commit 则不传 prompt（CLI 互斥）
    const hasReviewTarget = reviewMode && (reviewMode.uncommitted || reviewMode.base || reviewMode.commit);
    if (!hasReviewTarget) {
        let finalPrompt = prompt;
        if (outputFile) {
            finalPrompt += `\n\n请将报告输出保存到: ${outputFile}`;
        }
        cmdArgs.push(assertNoNul("prompt", finalPrompt));
    } else if (outputFile) {
        // review 模式下仍然需要 -o 参数，但 prompt 不传
        // outputFile 已在上面 push 过了，这里只做日志提示
    }

    // 记录 outputFile 启动前的大小（用于区分旧文件 vs 新生成）
    let outputFileBaselineSize = -1;
    if (outputFile) {
        try {
            if (fs.existsSync(outputFile)) {
                outputFileBaselineSize = fs.statSync(outputFile).size;
            }
        } catch { /* ignore */ }
    }

    const resourceLease = await acquireResourceLease({
        ownerId: params.ownerId,
        reservationMB: Number(process.env.SANDBOX_CODEX_RESERVATION_MB || 512),
        signal: params.signal,
        admissionBudgetMs: params.admissionBudgetMs,
        retryAttempt: params.retryAttempt,
    });
    if (params.signal?.aborted) {
        resourceLease.release();
        throw new CodexStartCancelledError();
    }
    let outputCollector: OutputDeliveryCollector;
    try {
        outputCollector = await createOutputDeliveryCollector({
            mode: params.deliveryMode || "auto",
            responseByteLimit: maxOutput,
        });
    } catch (error) {
        resourceLease.release();
        throw error;
    }
    if (params.signal?.aborted) {
        try {
            await outputCollector.finalize({
                status: "interrupted",
                error: "cancelled_before_spawn",
            });
        } catch {
        }
        resourceLease.release();
        throw new CodexStartCancelledError();
    }
    const startTime = Date.now();

    let proc: ChildProcess;
    try {
        proc = spawn(codexTarget.command, cmdArgs, {
            cwd: cwd || process.cwd(),
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
        });
    } catch (error) {
        await outputCollector.finalize({ status: "error", error: error instanceof Error ? error.message : String(error) });
        resourceLease.release();
        throw error;
    }

    // 🔴 修复 Codex CLI 0.124.0 stdin 挂起：新版 exec 会等待 stdin EOF
    proc.stdin?.end();

    const task: CodexTask = {
        id: taskId,
        ownerId: normalizeOwnerId(params.ownerId),
        proc,
        pid: proc.pid || 0,
        startTime,
        queueWaitMs: resourceLease.queueWaitMs,
        status: "running",
        exitCode: null,
        killed: false,
        killReason: null,
        peakMemoryMB: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutLines: 0,
        stderrLines: 0,
        outputFile,
        outputFileBaselineSize,
        maxOutput,
        deliveryMode: params.deliveryMode || "auto",
        outputCollector,
        outputDelivery: null,
        resourceLease,
        lastCheckTime: 0,
        resolvers: [],
        memoryMonitor: null,
        timeoutTimer: null,
        terminationTimer: null,
        cleanupTimer: null,
        finalized: false,
        finalizing: false,
        terminate: () => undefined,
        finalize: () => undefined,
    };

    const countNewlines = (data: Buffer): number => {
        let count = 0;
        for (const byte of data) if (byte === 0x0a) count += 1;
        return count;
    };
    proc.stdout?.on("data", (data: Buffer) => {
        task.stdoutBytes += data.length;
        task.stdoutLines += countNewlines(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
        task.stderrBytes += data.length;
        task.stderrLines += countNewlines(data);
    });
    proc.stdout?.pipe(outputCollector.stdout);
    proc.stderr?.pipe(outputCollector.stderr);

    task.finalize = () => {
        if (task.finalized || task.finalizing) return;
        task.finalizing = true;

        void (async () => {
            task.exitCode = proc.exitCode ?? task.exitCode;
            if (task.memoryMonitor) clearInterval(task.memoryMonitor);
            if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
            if (task.terminationTimer) clearTimeout(task.terminationTimer);

            try {
                task.outputDelivery = await outputCollector.finalize({
                    mode: task.deliveryMode,
                    status: task.killed ? "interrupted" : task.exitCode === 0 ? "done" : "error",
                    error: task.killed ? task.killReason || undefined : task.exitCode === 0 ? undefined : `exitCode=${task.exitCode}`,
                });
            } catch (error) {
                task.killed = true;
                task.killReason = `output_artifact_error: ${error instanceof Error ? error.message : String(error)}`;
            } finally {
                task.resourceLease.release();
            }

            const success = task.exitCode === 0 && (!outputFile || checkReport(outputFile, outputFileBaselineSize, startTime).generated);
            task.status = task.killed ? "killed" : (success ? "done" : "failed");
            task.finalized = true;
            task.finalizing = false;

            const resultText = buildResultText(task);
            const resolvers = task.resolvers.splice(0);
            for (const resolveTask of resolvers) {
                try {
                    resolveTask(resultText);
                } catch { /* ignore waiter failure */ }
            }

            if (!task.cleanupTimer) {
                task.cleanupTimer = setTimeout(() => {
                    taskPool.delete(taskId);
                }, 30 * 60 * 1000);
                task.cleanupTimer.unref?.();
            }
        })();
    };

    task.terminate = (reason: string) => {
        if (task.finalized || task.status !== "running") {
            task.finalize();
            return;
        }

        if (!task.killed) {
            task.killed = true;
            task.killReason = reason;
        }

        if (!task.terminationTimer) {
            task.terminationTimer = setTimeout(task.finalize, 1500);
            task.terminationTimer.unref?.();
        }

        try {
            if (task.pid) killProcessTree(task.pid);
        } catch (error) {
            void outputCollector.write("stderr", `\n终止进程树失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    proc.on("close", task.finalize);

    proc.on("error", (err: Error) => {
        if (!task.killed) {
            task.killed = true;
            task.killReason = "crash";
        }
        void outputCollector.write("stderr", `\n进程错误: ${err.message}`).finally(task.finalize);
    });

    // 超时管理
    if (timeout > 0) {
        task.timeoutTimer = setTimeout(() => task.terminate("timeout"), timeout);
        task.timeoutTimer.unref?.();
    }

    // 内存监控（2秒采样）
    task.memoryMonitor = setInterval(async () => {
        if (task.status !== "running" || !task.pid) return;
        try {
            const stats = await pidusage(task.pid);
            const memMB = stats.memory / (1024 * 1024);
            if (memMB > task.peakMemoryMB) {
                task.peakMemoryMB = memMB;
            }
            task.resourceLease.updateObservedMemoryMB(memMB);
        } catch { /* pidusage 可能在进程退出后失败 */ }
    }, 2000);
    task.memoryMonitor.unref?.();

    taskPool.set(taskId, task);
    return task;
}

// ── 注册 MCP 工具 ──

const CodexParamsShape = {
    prompt: z.string().optional()
        .describe("任务提示词，建议引用任务文档路径"),
    outputFile: z.string().optional()
        .describe("报告输出路径（-o 参数），不传则输出到 stdout"),
    model: z.string().optional()
        .describe("指定 Codex 模型（-m 参数）。不传使用默认模型"),
    cwd: z.string().optional()
        .describe("工作目录"),
    timeout: z.number().min(0).optional()
        .describe("超时(ms)，默认0=无超时"),
    configOverrides: z.string().optional()
        .describe("额外配置覆盖（-c 参数），如 model_reasoning_effort=high"),
    maxOutput: z.number().min(100).optional()
        .describe("兼容的内联响应预算，默认1MiB；超预算完整内容写入artifact"),
    deliveryMode: z.enum(["auto", "inline", "file", "manifest"]).optional()
        .describe("交付模式，默认auto"),
    admissionBudgetMs: z.number().min(0).optional()
        .describe("资源不足时最多等待多久"),
    retryAttempt: z.number().int().min(0).max(4).optional(),
    // 新增参数（v1.8）
    image: z.string().optional()
        .describe("图片文件路径（-i 参数），让 Codex 看截图做 UI Review 等"),
    json: z.boolean().optional()
        .describe("输出 JSONL 格式事件流（--json）"),
    outputSchema: z.string().optional()
        .describe("约束 Codex 输出为指定 JSON Schema 文件路径（--output-schema）"),
    enableFeatures: z.array(z.string()).optional()
        .describe("启用指定 feature flags（--enable）"),
    disableFeatures: z.array(z.string()).optional()
        .describe("禁用指定 feature flags（--disable）"),
    // exec review 参数
    review: z.boolean().optional()
        .describe("启用 exec review 模式（代码 Review 专用）"),
    uncommitted: z.boolean().optional()
        .describe("review: Review 未提交的变更（--uncommitted）"),
    base: z.string().optional()
        .describe("review: 对比指定 base 分支（--base）"),
    commit: z.string().optional()
        .describe("review: Review 某个特定 commit（--commit）"),
    title: z.string().optional()
        .describe("review: 给 review 加标题（--title）"),
    // 后台模式参数
    background: z.boolean().optional()
        .describe("后台模式：true=启动后立刻返回 taskId，然后用 check 定期轮询状态"),
    action: z.enum(["check", "wait", "kill"]).optional()
        .describe("管理后台任务：check=查看状态（推荐，配合 waitSeconds 使用），wait=同步等待（⚠️ 仅短任务/调试用），kill=终止"),
    taskId: z.string().optional()
        .describe("后台任务 ID（action 时必须）"),
    waitSeconds: z.number().min(1).max(300).optional()
        .describe("check 前等待秒数（1-300），避免频繁轮询。Codex 任务建议 90-120s"),
    ownerId: z.string().optional()
        .describe("任务归属 ID；未传按 global 兼容旧调用"),
};

export function registerCodex(server: McpServer): void {
    server.tool(
        "sandbox_codex",
        `调用 Codex CLI 执行任务。自动处理安全旗标、输出文件、exit code 检查。
进程树由 sandbox 托管，自动清理，无孤儿残留。
适合：代码审核、大规模重构、跨文件分析等长时间任务。

参数：
- prompt: 任务提示词（必须）
- outputFile: 报告输出路径（可选，传给 -o 参数）
- model: 指定模型名（可选，-m 参数），如 "gpt-5.4"。不传使用默认模型。⚠️ 不要拼接 reasoning effort 后缀！
- configOverrides: 覆盖配置项（-c 参数），如 model_reasoning_effort=xhigh
- timeout: 超时(ms)，默认0=无超时
- cwd: 工作目录
- maxOutput: MCP 内联响应展示预算，默认1MiB；普通小输出直接返回，超预算或中断恢复时保留完整 artifact

后台模式（推荐用于长任务）：
- background: true 启动后立刻返回 taskId，不阻塞
- action: "check" + waitSeconds=90 等待 90s 后查看状态（推荐，避免频繁轮询）
- action: "wait" 会阻塞 MCP 直到完成，⚠️ 仅短任务/调试用
- action: "kill" 终止后台任务
- waitSeconds: check 前等待的秒数（1-300），Codex 任务建议 90-120s

v1.8 新增参数：
- image: 图片文件路径（-i），让 Codex 看截图做 UI Review
- json: true 输出 JSONL 格式事件流（--json）
- outputSchema: JSON Schema 文件路径，约束 Codex 输出格式
- enableFeatures/disableFeatures: 动态控制 feature flags
- review: true 启用 exec review 模式（代码 Review 专用）
  配合 uncommitted/base/commit/title 参数使用

提示：指定 outputFile 时会自动在 prompt 末尾附加输出路径指令。${modelsDescription}`,
        CodexParamsShape,
        async (params: Record<string, unknown>, extra) => {
            const startTime = Date.now();
            touchActivity();

            const action = params.action as string | undefined;
            const taskId = params.taskId as string | undefined;
            const ownerId = normalizeOwnerId(params.ownerId);

            // ── action 模式：管理已有任务 ──
            if (action) {
                if (!taskId) {
                    return {
                        content: [{ type: "text" as const, text: "❌ action 模式需要提供 taskId 参数" }],
                    };
                }

                const task = taskPool.get(taskId);
                if (!task) {
                    // 列出可用任务帮助调试
                    const available = Array.from(taskPool.keys());
                    return {
                        content: [{
                            type: "text" as const,
                            text: `❌ 未找到任务 ${taskId}\n可用任务: ${available.length > 0 ? available.join(", ") : "(无)"}`,
                        }],
                    };
                }
                if (!hasOwnerAccess(task.ownerId, ownerId)) {
                    return {
                        content: [{ type: "text" as const, text: ownerMismatchText("Codex 任务", taskId) }],
                    };
                }

                // ── check: 查看状态 ──
                if (action === "check") {
                    const waitSeconds = (params.waitSeconds as number | undefined) || 0;

                    const waitOutcome = await waitForCodexCompletion(task, waitSeconds, extra.signal);
                    if (waitOutcome === "aborted") {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `⏹️ 已取消本次 check 等待，任务 ${taskId} 未被终止，当前状态 ${task.status}`,
                            }],
                        }, startTime);
                    }

                    const elapsed = formatElapsed(Date.now() - task.startTime);
                    if (task.status === "running") {
                        task.lastCheckTime = Date.now();
                        // 检查 outputFile 是否已开始写入
                        let outputInfo = "";
                        if (task.outputFile) {
                            try {
                                const stat = fs.statSync(task.outputFile);
                                if (stat.size > task.outputFileBaselineSize) {
                                    outputInfo = ` | 📄 报告已开始写入 (${stat.size} bytes)`;
                                }
                            } catch { /* file not yet created */ }
                        }
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `🔄 任务 ${taskId} 运行中 | owner=${task.ownerId} | ${elapsed} | PID ${task.pid}\n📊 stdout ${task.stdoutBytes} bytes/${task.stdoutLines} 行 | stderr ${task.stderrBytes} bytes/${task.stderrLines} 行 | 内存峰值 ${Math.round(task.peakMemoryMB)}MB${outputInfo}\n💡 建议 30-60s 后再次 check（stderr 静止不代表卡住，Codex 可能在思考）`,
                            }],
                        }, startTime);
                    } else {
                        // 已完成，返回完整结果
                        return appendTiming({
                            content: [{ type: "text" as const, text: buildResultText(task) }],
                        }, startTime);
                    }
                }

                // ── wait: 同步等待完成 ──
                if (action === "wait") {
                    if (task.status !== "running") {
                        // 已经完成了
                        return appendTiming({
                            content: [{ type: "text" as const, text: buildResultText(task) }],
                        }, startTime);
                    }

                    const waitResult = await waitForCodexResult(task, extra.signal, false);

                    return appendTiming({
                        content: [{ type: "text" as const, text: waitResult.resultText }],
                    }, startTime);
                }

                // ── kill: 终止任务 ──
                if (action === "kill") {
                    if (task.status !== "running") {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `⚠️ 任务 ${taskId} 已经结束 (status=${task.status})`,
                            }],
                        }, startTime);
                    }

                    task.terminate("user");

                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `🛑 已发送终止信号给任务 ${taskId} (PID ${task.pid})`,
                        }],
                    }, startTime);
                }

                return {
                    content: [{ type: "text" as const, text: `❌ 未知 action: ${action}` }],
                };
            }

            // ── 启动模式：新建 Codex 任务 ──
            const prompt = params.prompt as string | undefined;
            if (!prompt) {
                return {
                    content: [{ type: "text" as const, text: "❌ 启动模式需要提供 prompt 参数" }],
                };
            }

            const outputFile = params.outputFile as string | undefined;
            const model = params.model as string | undefined;
            const cwd = params.cwd as string | undefined;
            const timeout = (params.timeout as number | undefined) ?? 0;
            const configOverrides = params.configOverrides as string | undefined;
            const maxOutput = (params.maxOutput as number | undefined) ?? 1024 * 1024;
            const deliveryMode = params.deliveryMode as OutputDeliveryMode | undefined;
            const admissionBudgetMs = params.admissionBudgetMs as number | undefined;
            const retryAttempt = params.retryAttempt as number | undefined;
            const background = (params.background as boolean | undefined) ?? false;
            const image = params.image as string | undefined;
            const jsonMode = params.json as boolean | undefined;
            const outputSchema = params.outputSchema as string | undefined;
            const enableFeatures = params.enableFeatures as string[] | undefined;
            const disableFeatures = params.disableFeatures as string[] | undefined;
            const review = params.review as boolean | undefined;
            const uncommitted = params.uncommitted as boolean | undefined;
            const base = params.base as string | undefined;
            const commit = params.commit as string | undefined;
            const title = params.title as string | undefined;

            if (extra.signal.aborted) {
                return appendTiming({
                    content: [{ type: "text" as const, text: "⏹️ Codex 调用已取消，任务未启动" }],
                }, startTime);
            }

            let task: CodexTask;
            try {
                task = await startCodexProcess({
                    prompt, outputFile, cwd, timeout, configOverrides, maxOutput, model,
                    image, json: jsonMode,
                    outputSchema, enableFeatures, disableFeatures,
                    reviewMode: review ? { uncommitted, base, commit, title } : undefined,
                    ownerId,
                    deliveryMode,
                    signal: extra.signal,
                    admissionBudgetMs,
                    retryAttempt,
                });
            } catch (error) {
                if (error instanceof CodexStartCancelledError) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "⏹️ Codex 调用已取消，任务未启动" }],
                    }, startTime);
                }
                const admissionError = serializeResourceAdmissionError(error);
                if (admissionError) {
                    return {
                        isError: true,
                        structuredContent: { error: admissionError },
                        content: [{ type: "text" as const, text: `❌ ${admissionError.type}: Codex 尚未启动；等待 ${admissionError.queueWaitMs}ms 后仍无资源，建议 ${admissionError.retryAfterMs}ms 后重试` }],
                    };
                }
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `❌ Codex 启动失败: ${error instanceof Error ? error.message : String(error)}` }],
                };
            }

            // ── 后台模式：立刻返回 taskId ──
            if (background) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `🚀 Codex 任务已在后台启动\n📋 taskId: ${task.id}\n👤 ownerId: ${task.ownerId}\n📂 PID: ${task.pid}\n${outputFile ? `📄 输出文件: ${outputFile}\n` : ""}⏱ 超时: ${timeout > 0 ? formatElapsed(timeout) : "无限制"}\n\n💡 用法:\n  sandbox_codex(action="check", taskId="${task.id}")  — 查看状态\n  sandbox_codex(action="wait",  taskId="${task.id}")  — 等待完成\n  sandbox_codex(action="kill",  taskId="${task.id}")  — 终止任务`,
                    }],
                }, startTime);
            }

            const waitResult = await waitForCodexResult(task, extra.signal, true);

            return appendTiming({
                content: [{ type: "text" as const, text: waitResult.resultText }],
            }, startTime);
        }
    );
}

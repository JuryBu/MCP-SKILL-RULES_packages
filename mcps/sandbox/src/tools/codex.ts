import { spawn, spawnSync, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { killProcessTree, processOutput } from "../executor.js";
import { touchActivity, appendTiming, formatElapsed } from "../lifecycle.js";
import pidusage from "pidusage";
import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "../owner.js";

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
    status: "running" | "done" | "failed" | "killed";
    exitCode: number | null;
    killed: boolean;
    killReason: string | null;
    peakMemoryMB: number;
    stdoutBuf: string;
    stderrBuf: string;
    outputFile?: string;
    outputFileBaselineSize: number; // 启动前文件大小（-1=不存在）
    maxOutput: number;
    lastCheckTime: number; // 上次 check 的时间戳（节流用）
    // 完成时的 Promise resolve
    resolvers: Array<(result: string) => void>;
    memoryMonitor: NodeJS.Timeout;
    timeoutTimer: NodeJS.Timeout | null;
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
        if (task.status === "running" && task.pid) {
            try {
                killProcessTree(task.pid);
            } catch { /* ignore */ }
        }
        clearInterval(task.memoryMonitor);
        if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
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

function resolveCodexSpawnTarget(): { command: string; argsPrefix: string[] } {
    const override = process.env.SANDBOX_CODEX_BIN?.trim();
    if (override) {
        return { command: override, argsPrefix: parseCodexBinArgs(process.env.SANDBOX_CODEX_BIN_ARGS) };
    }
    if (process.platform !== "win32") {
        return { command: "codex", argsPrefix: [] };
    }
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
        parts.push(`💀 Codex 被终止 (${task.killReason}) | ${elapsed}`);
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

    // stdout — 上下文保护：有报告文件时压缩显示
    const shouldCompressStdout = reportInfo?.generated && task.stdoutBuf.length > 500;

    if (shouldCompressStdout) {
        const lines = task.stdoutBuf.split("\n");
        const preview = lines.slice(0, 5).join("\n");
        parts.push("");
        parts.push(`📤 stdout (已压缩，完整内容在报告文件中，共 ${task.stdoutBuf.length} 字符):`);
        parts.push(preview);
        if (lines.length > 5) {
            parts.push(`... (省略 ${lines.length - 5} 行)`);
        }
    } else if (task.stdoutBuf.trim()) {
        const stdoutResult = processOutput(task.stdoutBuf, "full", task.maxOutput, 20);
        parts.push("");
        parts.push("📤 stdout:");
        parts.push(stdoutResult.text);
    }

    // stderr — 成功任务如果报告已生成，跳过 stderr（节省上下文）
    // 失败任务始终显示 stderr 用于调试
    if (!success) {
        const filteredStderr = filterStderr(task.stderrBuf);
        if (filteredStderr.trim()) {
            const stderrResult = processOutput(filteredStderr, "full", 2000, 20);
            parts.push("");
            parts.push("⚠️ stderr:");
            parts.push(stderrResult.text);
        }
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

async function waitForCodexCompletion(task: CodexTask, waitSeconds: number): Promise<void> {
    const waitMs = Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    if (waitMs <= 0 || task.status !== "running") return;

    await new Promise<void>((resolve) => {
        let done = false;
        let timer: NodeJS.Timeout;
        let interval: NodeJS.Timeout;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearInterval(interval);
            resolve();
        };

        timer = setTimeout(finish, waitMs);
        interval = setInterval(() => {
            if (task.status !== "running") finish();
        }, 2000);
        timer.unref?.();
        interval.unref?.();
    });
}

// ── 启动 Codex 进程 ──

function startCodexProcess(params: {
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
}): CodexTask {
    const { prompt, outputFile, cwd, timeout, configOverrides, maxOutput, model,
        image, json: jsonMode, outputSchema, enableFeatures, disableFeatures, reviewMode } = params;
    const taskId = generateTaskId();
    const startTime = Date.now();

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

    // 启动进程
    const proc = spawn(codexTarget.command, cmdArgs, {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
    });

    // 🔴 修复 Codex CLI 0.124.0 stdin 挂起：新版 exec 会等待 stdin EOF
    proc.stdin?.end();

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");

    const task: CodexTask = {
        id: taskId,
        ownerId: normalizeOwnerId(params.ownerId),
        proc,
        pid: proc.pid || 0,
        startTime,
        status: "running",
        exitCode: null,
        killed: false,
        killReason: null,
        peakMemoryMB: 0,
        stdoutBuf: "",
        stderrBuf: "",
        outputFile,
        outputFileBaselineSize,
        maxOutput,
        lastCheckTime: 0,
        resolvers: [],
        memoryMonitor: null as unknown as NodeJS.Timeout, // 下方赋值
        timeoutTimer: null,
    };

    // 收集输出（带缓冲上限 512KB 防止内存爆炸）
    const MAX_BUF = 512 * 1024; // 512KB
    proc.stdout?.on("data", (data: Buffer) => {
        if (task.stdoutBuf.length < MAX_BUF) {
            task.stdoutBuf += stdoutDecoder.write(data);
        }
    });

    proc.stderr?.on("data", (data: Buffer) => {
        if (task.stderrBuf.length < MAX_BUF) {
            task.stderrBuf += stderrDecoder.write(data);
        }
    });

    // 进程退出处理
    const finalize = () => {
        if (task.status !== "running") return;

        task.exitCode = proc.exitCode;
        const success = task.exitCode === 0 && (!outputFile || checkReport(outputFile, outputFileBaselineSize, startTime).generated);
        task.status = task.killed ? "killed" : (success ? "done" : "failed");

        clearInterval(task.memoryMonitor);
        if (task.timeoutTimer) clearTimeout(task.timeoutTimer);

        // 通知所有等待者
        const resultText = buildResultText(task);
        for (const resolve of task.resolvers) {
            resolve(resultText);
        }
        task.resolvers = [];

        // 清理已完成任务（保留 30 分钟后自动移除，unref 不阻止进程退出）
        const cleanupTimer = setTimeout(() => {
            taskPool.delete(taskId);
        }, 30 * 60 * 1000);
        cleanupTimer.unref();
    };

    proc.on("exit", () => {
        setTimeout(finalize, 100);
    });

    proc.on("error", (err: Error) => {
        task.stderrBuf += `\n进程错误: ${err.message}`;
        task.killed = true;
        task.killReason = "crash";
        finalize();
    });

    // 超时管理
    if (timeout > 0) {
        task.timeoutTimer = setTimeout(() => {
            if (task.status === "running" && task.pid) {
                task.killed = true;
                task.killReason = "timeout";
                killProcessTree(task.pid);
                setTimeout(finalize, 300);
            }
        }, timeout);
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
    timeout: z.number().min(0).max(1800000).optional()
        .describe("超时(ms)，默认0=无超时，最大1800000(30分钟)"),
    configOverrides: z.string().optional()
        .describe("额外配置覆盖（-c 参数），如 model_reasoning_effort=high"),
    maxOutput: z.number().min(100).max(50000).optional()
        .describe("输出截断上限（字符），默认10000"),
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
- maxOutput: 输出截断上限，默认10000

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
        async (params: Record<string, unknown>) => {
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

                    // 主动等待：如果指定了 waitSeconds 且任务还在运行，先 sleep
                    await waitForCodexCompletion(task, waitSeconds);

                    const elapsed = formatElapsed(Date.now() - task.startTime);
                    if (task.status === "running") {
                        task.lastCheckTime = Date.now();
                        const stdoutLines = task.stdoutBuf.trim() ? task.stdoutBuf.split("\n").length : 0;
                        const stderrLines = task.stderrBuf.trim() ? task.stderrBuf.split("\n").length : 0;
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
                                text: `🔄 任务 ${taskId} 运行中 | owner=${task.ownerId} | ${elapsed} | PID ${task.pid}\n📊 stdout ${stdoutLines} 行 | stderr ${stderrLines} 行 | 内存峰值 ${Math.round(task.peakMemoryMB)}MB${outputInfo}\n💡 建议 30-60s 后再次 check（stderr 静止不代表卡住，Codex 可能在思考）`,
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

                    // 等待完成
                    const resultText = await new Promise<string>((resolve) => {
                        task.resolvers.push(resolve);
                    });

                    return appendTiming({
                        content: [{ type: "text" as const, text: resultText }],
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

                    task.killed = true;
                    task.killReason = "user";
                    if (task.pid) {
                        killProcessTree(task.pid);
                    }

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
            const maxOutput = (params.maxOutput as number | undefined) ?? 10000;
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

            const task = startCodexProcess({
                prompt, outputFile, cwd, timeout, configOverrides, maxOutput, model,
                image, json: jsonMode,
                outputSchema, enableFeatures, disableFeatures,
                reviewMode: review ? { uncommitted, base, commit, title } : undefined,
                ownerId,
            });

            // ── 后台模式：立刻返回 taskId ──
            if (background) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `🚀 Codex 任务已在后台启动\n📋 taskId: ${task.id}\n👤 ownerId: ${task.ownerId}\n📂 PID: ${task.pid}\n${outputFile ? `📄 输出文件: ${outputFile}\n` : ""}⏱ 超时: ${timeout > 0 ? formatElapsed(timeout) : "无限制"}\n\n💡 用法:\n  sandbox_codex(action="check", taskId="${task.id}")  — 查看状态\n  sandbox_codex(action="wait",  taskId="${task.id}")  — 等待完成\n  sandbox_codex(action="kill",  taskId="${task.id}")  — 终止任务`,
                    }],
                }, startTime);
            }

            // ── 同步模式（向后兼容）：等待完成 ──
            const resultText = await new Promise<string>((resolve) => {
                task.resolvers.push(resolve);
            });

            return appendTiming({
                content: [{ type: "text" as const, text: resultText }],
            }, startTime);
        }
    );
}

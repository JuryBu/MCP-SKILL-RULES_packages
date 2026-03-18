import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { killProcessTree, processOutput } from "../executor.js";
import { touchActivity, appendTiming, formatElapsed } from "../lifecycle.js";
import pidusage from "pidusage";
// ── 模型列表缓存（启动时从 Codex CLI 缓存文件读取一次） ──
let modelsDescription = "";
try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    if (fs.existsSync(cachePath)) {
        const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        const visible = (raw.models || [])
            .filter((m) => m.visibility === "list")
            .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
            .map((m) => ({
            slug: m.slug,
            levels: (m.supported_reasoning_levels || []).map((l) => l.effort),
        }));
        if (visible.length > 0) {
            modelsDescription = "\n\n可用模型（从 ~/.codex/models_cache.json 动态加载，Codex CLI 自动更新）:\n" +
                visible.map((m) => `  - ${m.slug} (${m.levels.join("/")})`).join("\n");
        }
    }
}
catch { /* models_cache.json 不存在或格式异常，模型列表为空但 model 参数仍可用 */ }
// ── 任务池 ──
const taskPool = new Map();
let taskCounter = 0;
function generateTaskId() {
    taskCounter++;
    return `codex-${String(taskCounter).padStart(3, "0")}`;
}
/**
 * 清理所有运行中的 Codex 任务（进程退出时调用）
 */
export function cleanupCodexTasks() {
    for (const [id, task] of taskPool) {
        if (task.status === "running" && task.pid) {
            try {
                killProcessTree(task.pid);
            }
            catch { /* ignore */ }
        }
        clearInterval(task.memoryMonitor);
        if (task.timeoutTimer)
            clearTimeout(task.timeoutTimer);
        taskPool.delete(id);
    }
}
/**
 * 获取活跃任务数量（供 status 工具使用）
 */
export function getCodexTaskCount() {
    let running = 0;
    for (const task of taskPool.values()) {
        if (task.status === "running")
            running++;
    }
    return { running, total: taskPool.size };
}
// ── 工具函数 ──
/**
 * 在 cmd.exe shell 中安全引用参数
 * 双引号包裹，内部双引号转义为两个双引号
 */
function shellQuote(arg) {
    // 1. % → %% 防止 cmd.exe 变量展开（如 %CD% → 实际目录）
    // 2. 双引号 → 两个双引号
    return `"${arg.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}
/**
 * 过滤 stderr 中的噪音行
 * Codex 的 stderr 包含：启动横幅、MCP 启动/工具调用日志、token 计数等
 * 只保留真正的错误信息
 */
function filterStderr(raw) {
    const lines = raw.split("\n");
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();
        // 空行
        if (trimmed === "")
            return false;
        // MCP 启动/关闭/工具调用行
        if (lower.startsWith("mcp:") || lower.startsWith("mcp ") || lower.startsWith("[mcp]"))
            return false;
        if (lower.startsWith("mcp startup:"))
            return false;
        // Codex 启动横幅（OpenAI Codex v...、--------、workdir:、model: 等）
        if (lower.startsWith("openai codex v"))
            return false;
        if (/^-{4,}$/.test(trimmed))
            return false; // --------
        if (lower.startsWith("workdir:"))
            return false;
        if (lower.startsWith("model:"))
            return false;
        if (lower.startsWith("provider:"))
            return false;
        if (lower.startsWith("approval:"))
            return false;
        if (lower.startsWith("sandbox:"))
            return false;
        if (lower.startsWith("reasoning effort:"))
            return false;
        if (lower.startsWith("reasoning summaries:"))
            return false;
        if (lower.startsWith("session id:"))
            return false;
        // Codex 执行日志（user/codex/tool/exec 单词行 + 工具调用行）
        if (/^(user|codex|exec)$/.test(trimmed))
            return false;
        if (lower.startsWith("tool "))
            return false; // tool memory-store.xxx / tool web-fetcher.xxx
        if (/succe(ss|eded) in \d+/i.test(trimmed))
            return false; // xxx succeeded in 190ms: / success in 5ms:
        // session/token 计数行
        if (lower.includes("session_id") && lower.includes("token"))
            return false;
        if (lower.includes("tokens:") && lower.includes("input"))
            return false;
        // PowerShell 执行日志（Codex 内部 PS 调用产生）
        if (lower.startsWith("powershell") || lower.startsWith("ps "))
            return false;
        if (lower.includes("encoding utf8") || lower.includes("-encoding utf8"))
            return false;
        // failed to refresh available models（Codex 内部模型刷新超时，无害）
        if (lower.includes("failed to refresh available models"))
            return false;
        // MCP 工具返回的 JSON 块（以 { 开头的行，通常是 MCP 工具调用的参数/返回值）
        if (/^\{.*\}$/.test(trimmed) && trimmed.length > 20)
            return false;
        return true;
    });
    return filtered.join("\n");
}
/**
 * 构建完整的 Codex 结果文本
 */
function buildResultText(task) {
    const elapsed = formatElapsed(Date.now() - task.startTime);
    const parts = [];
    // 缓存报告检查结果（避免多次 IO）
    const reportInfo = task.outputFile ? checkReport(task.outputFile, task.outputFileBaselineSize, task.startTime) : null;
    // 状态行
    const success = task.exitCode === 0 && (!task.outputFile || (reportInfo?.generated ?? false));
    if (success) {
        parts.push(`✅ Codex 执行成功 | ${elapsed} | 内存峰值 ${Math.round(task.peakMemoryMB)}MB`);
    }
    else if (task.killed) {
        parts.push(`💀 Codex 被终止 (${task.killReason}) | ${elapsed}`);
    }
    else {
        parts.push(`❌ Codex 执行失败 (exit ${task.exitCode}) | ${elapsed}`);
    }
    // 报告信息
    if (task.outputFile && reportInfo) {
        if (reportInfo.generated) {
            parts.push(`📄 报告已生成: ${task.outputFile} (${reportInfo.size} bytes)`);
        }
        else if (reportInfo.size !== null) {
            parts.push(`⚠️ 报告文件为空或过小: ${task.outputFile} (${reportInfo.size} bytes)`);
        }
        else {
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
    }
    else if (task.stdoutBuf.trim()) {
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
function checkReport(outputFile, baselineSize, taskStartTime) {
    try {
        if (fs.existsSync(outputFile)) {
            const stat = fs.statSync(outputFile);
            // 判断方式：文件 mtime > 任务启动时间 且 size > 10 bytes
            // 这比纯 size 比较更可靠（新报告可能比旧文件短）
            const mtimeMs = stat.mtimeMs;
            const isNew = stat.size > 10 && mtimeMs > taskStartTime;
            return { generated: isNew, size: stat.size };
        }
    }
    catch { /* ignore */ }
    return { generated: false, size: null };
}
// ── 启动 Codex 进程 ──
function startCodexProcess(params) {
    const { prompt, outputFile, cwd, timeout, configOverrides, maxOutput, model } = params;
    const taskId = generateTaskId();
    const startTime = Date.now();
    // 构建命令字符串
    const cmdParts = [
        "codex", "exec",
        "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (model) {
        cmdParts.push("-m", shellQuote(model));
    }
    if (configOverrides) {
        cmdParts.push("-c", shellQuote(configOverrides));
    }
    if (outputFile) {
        const outputDir = path.dirname(outputFile);
        if (!fs.existsSync(outputDir)) {
            try {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            catch { /* ignore */ }
        }
        cmdParts.push("-o", shellQuote(outputFile));
    }
    // 自动附加 outputFile 提示到 prompt（减少手动重复）
    let finalPrompt = prompt;
    if (outputFile) {
        finalPrompt += `\n\n请将报告输出保存到: ${outputFile}`;
    }
    cmdParts.push(shellQuote(finalPrompt));
    // 记录 outputFile 启动前的大小（用于区分旧文件 vs 新生成）
    let outputFileBaselineSize = -1;
    if (outputFile) {
        try {
            if (fs.existsSync(outputFile)) {
                outputFileBaselineSize = fs.statSync(outputFile).size;
            }
        }
        catch { /* ignore */ }
    }
    // 启动进程
    const proc = spawn(cmdParts.join(" "), [], {
        cwd: cwd || process.cwd(),
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: true,
    });
    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");
    const task = {
        id: taskId,
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
        memoryMonitor: null, // 下方赋值
        timeoutTimer: null,
    };
    // 收集输出（带缓冲上限 512KB 防止内存爆炸）
    const MAX_BUF = 512 * 1024; // 512KB
    proc.stdout?.on("data", (data) => {
        if (task.stdoutBuf.length < MAX_BUF) {
            task.stdoutBuf += stdoutDecoder.write(data);
        }
    });
    proc.stderr?.on("data", (data) => {
        if (task.stderrBuf.length < MAX_BUF) {
            task.stderrBuf += stderrDecoder.write(data);
        }
    });
    // 进程退出处理
    const finalize = () => {
        if (task.status !== "running")
            return;
        task.exitCode = proc.exitCode;
        const success = task.exitCode === 0 && (!outputFile || checkReport(outputFile, outputFileBaselineSize, startTime).generated);
        task.status = task.killed ? "killed" : (success ? "done" : "failed");
        clearInterval(task.memoryMonitor);
        if (task.timeoutTimer)
            clearTimeout(task.timeoutTimer);
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
    proc.on("error", (err) => {
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
    }
    // 内存监控（2秒采样）
    task.memoryMonitor = setInterval(async () => {
        if (task.status !== "running" || !task.pid)
            return;
        try {
            const stats = await pidusage(task.pid);
            const memMB = stats.memory / (1024 * 1024);
            if (memMB > task.peakMemoryMB) {
                task.peakMemoryMB = memMB;
            }
        }
        catch { /* pidusage 可能在进程退出后失败 */ }
    }, 2000);
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
    // 后台模式参数
    background: z.boolean().optional()
        .describe("后台模式：true=启动后立刻返回 taskId，然后用 check 定期轮询状态"),
    action: z.enum(["check", "wait", "kill"]).optional()
        .describe("管理后台任务：check=查看状态（推荐，配合 waitSeconds 使用），wait=同步等待（⚠️ 仅短任务/调试用），kill=终止"),
    taskId: z.string().optional()
        .describe("后台任务 ID（action 时必须）"),
    waitSeconds: z.number().min(1).max(300).optional()
        .describe("check 前等待秒数（1-300），避免频繁轮询。Codex 任务建议 90-120s"),
};
export function registerCodex(server) {
    server.tool("sandbox_codex", `调用 Codex CLI 执行任务。自动处理安全旗标、输出文件、exit code 检查。
进程树由 sandbox 托管，自动清理，无孤儿残留。
适合：代码审核、大规模重构、跨文件分析等长时间任务。

参数：
- prompt: 任务提示词（必须）
- outputFile: 报告输出路径（可选，传给 -o 参数）
- model: 指定模型（可选，-m 参数），不传使用默认模型
- timeout: 超时(ms)，默认0=无超时
- cwd: 工作目录
- configOverrides: 额外 -c 配置
- maxOutput: 输出截断上限，默认10000

后台模式（推荐用于长任务）：
- background: true 启动后立刻返回 taskId，不阻塞
- action: "check" + waitSeconds=90 等待 90s 后查看状态（推荐，避免频繁轮询）
- action: "kill" 终止后台任务
- waitSeconds: check 前等待的秒数（1-300），Codex 任务建议 90-120s

提示：指定 outputFile 时会自动在 prompt 末尾附加输出路径指令。
⚠️ action="wait" 会阻塞 MCP 直到完成，仅限短任务/调试。${modelsDescription}`, CodexParamsShape, async (params) => {
        const startTime = Date.now();
        touchActivity();
        const action = params.action;
        const taskId = params.taskId;
        // ── action 模式：管理已有任务 ──
        if (action) {
            if (!taskId) {
                return {
                    content: [{ type: "text", text: "❌ action 模式需要提供 taskId 参数" }],
                };
            }
            const task = taskPool.get(taskId);
            if (!task) {
                // 列出可用任务帮助调试
                const available = Array.from(taskPool.keys());
                return {
                    content: [{
                            type: "text",
                            text: `❌ 未找到任务 ${taskId}\n可用任务: ${available.length > 0 ? available.join(", ") : "(无)"}`,
                        }],
                };
            }
            // ── check: 查看状态 ──
            if (action === "check") {
                const waitSeconds = params.waitSeconds || 0;
                // 主动等待：如果指定了 waitSeconds 且任务还在运行，先 sleep
                if (waitSeconds > 0 && task.status === "running") {
                    await new Promise((resolve) => {
                        const timer = setTimeout(resolve, waitSeconds * 1000);
                        // 如果任务在等待期间完成，提前结束等待
                        const checkInterval = setInterval(() => {
                            if (task.status !== "running") {
                                clearTimeout(timer);
                                clearInterval(checkInterval);
                                resolve();
                            }
                        }, 2000); // 每 2s 检查一次是否完成
                        // 等待结束后清理
                        timer.unref?.();
                    });
                }
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
                        }
                        catch { /* file not yet created */ }
                    }
                    return appendTiming({
                        content: [{
                                type: "text",
                                text: `🔄 任务 ${taskId} 运行中 | ${elapsed} | PID ${task.pid}\n📊 stdout ${stdoutLines} 行 | stderr ${stderrLines} 行 | 内存峰值 ${Math.round(task.peakMemoryMB)}MB${outputInfo}\n💡 建议 30-60s 后再次 check（stderr 静止不代表卡住，Codex 可能在思考）`,
                            }],
                    }, startTime);
                }
                else {
                    // 已完成，返回完整结果
                    return appendTiming({
                        content: [{ type: "text", text: buildResultText(task) }],
                    }, startTime);
                }
            }
            // ── wait: 同步等待完成 ──
            if (action === "wait") {
                if (task.status !== "running") {
                    // 已经完成了
                    return appendTiming({
                        content: [{ type: "text", text: buildResultText(task) }],
                    }, startTime);
                }
                // 等待完成
                const resultText = await new Promise((resolve) => {
                    task.resolvers.push(resolve);
                });
                return appendTiming({
                    content: [{ type: "text", text: resultText }],
                }, startTime);
            }
            // ── kill: 终止任务 ──
            if (action === "kill") {
                if (task.status !== "running") {
                    return appendTiming({
                        content: [{
                                type: "text",
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
                            type: "text",
                            text: `🛑 已发送终止信号给任务 ${taskId} (PID ${task.pid})`,
                        }],
                }, startTime);
            }
            return {
                content: [{ type: "text", text: `❌ 未知 action: ${action}` }],
            };
        }
        // ── 启动模式：新建 Codex 任务 ──
        const prompt = params.prompt;
        if (!prompt) {
            return {
                content: [{ type: "text", text: "❌ 启动模式需要提供 prompt 参数" }],
            };
        }
        const outputFile = params.outputFile;
        const model = params.model;
        const cwd = params.cwd;
        const timeout = params.timeout ?? 0;
        const configOverrides = params.configOverrides;
        const maxOutput = params.maxOutput ?? 10000;
        const background = params.background ?? false;
        const task = startCodexProcess({
            prompt, outputFile, cwd, timeout, configOverrides, maxOutput, model,
        });
        // ── 后台模式：立刻返回 taskId ──
        if (background) {
            return appendTiming({
                content: [{
                        type: "text",
                        text: `🚀 Codex 任务已在后台启动\n📋 taskId: ${task.id}\n📂 PID: ${task.pid}\n${outputFile ? `📄 输出文件: ${outputFile}\n` : ""}⏱ 超时: ${timeout > 0 ? formatElapsed(timeout) : "无限制"}\n\n💡 用法:\n  sandbox_codex(action="check", taskId="${task.id}")  — 查看状态\n  sandbox_codex(action="wait",  taskId="${task.id}")  — 等待完成\n  sandbox_codex(action="kill",  taskId="${task.id}")  — 终止任务`,
                    }],
            }, startTime);
        }
        // ── 同步模式（向后兼容）：等待完成 ──
        const resultText = await new Promise((resolve) => {
            task.resolvers.push(resolve);
        });
        return appendTiming({
            content: [{ type: "text", text: resultText }],
        }, startTime);
    });
}
//# sourceMappingURL=codex.js.map
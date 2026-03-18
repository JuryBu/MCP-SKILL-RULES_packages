#!/usr/bin/env node
/**
 * MCP Sandbox Server v1.5
 * 
 * 代码执行沙箱，解决 Antigravity IDE 中 run_command 的痛点。
 * 
 * 6 个 MCP 工具：
 *   - sandbox_exec: 执行代码片段或系统命令（硬超时、内存限制、输出截断）
 *   - sandbox_session: 持久 REPL 会话（变量状态跨调用保持）
 *   - sandbox_batch: 一次调用并行执行多任务
 *   - sandbox_status: 查看系统状态（环境、GPU、资源、会话）
 *   - sandbox_codex: Codex CLI 专用调用（后台模式、报告检查、进程树清理）
 *   - sandbox_launch: 长任务脱离执行（模型训练、大规模数据处理，进程独立于 MCP）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isParentAlive, logStdinEvent, touchActivity } from "./lifecycle.js";
import { ensureDataDirs, cleanOldTempFiles } from "./temp-store.js";
import { detectEnvironment } from "./env-detector.js";
import { closeAllSessions } from "./session-manager.js";

// 工具注册
import { registerExec } from "./tools/exec.js";
import { registerSession } from "./tools/session.js";
import { registerBatch } from "./tools/batch.js";
import { registerStatus } from "./tools/status.js";
import { registerCodex, cleanupCodexTasks } from "./tools/codex.js";
import { registerLaunch } from "./tools/launch.js";

// === 进程生命周期 ===
// ppid 绑定：与父 LS 进程同生共死（每 30s 检测一次）

// 创建 MCP Server 实例
const server = new McpServer({
    name: "sandbox-mcp-server",
    version: "1.5.0",
});

// 注册所有 6 个工具
registerExec(server);
registerSession(server);
registerBatch(server);
registerStatus(server);
registerCodex(server);
registerLaunch(server);

// === 使用指南 Resource ===
server.resource(
    "guide",
    "sandbox://guide",
    {
        description: "MCP Sandbox 完整使用指南",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [
            {
                uri: "sandbox://guide",
                text: `# MCP Sandbox v1.5 使用指南

## 核心优势（vs run_command）
| 功能 | run_command | sandbox |
|------|-----------|---------|
| 执行代码 | 需写临时文件 | 直接传 code 字符串 |
| 超时处理 | 可能卡死 | 硬超时自动杀进程树 |
| 内存保护 | 无 | 自动监控+超限杀 |
| 输出管理 | 全量返回 | 截断/tail/head/silent |
| 大输出 | 爆上下文 | 自动写临时文件 |
| 多任务 | 逐个调用 | batch 一次并行 |
| 有状态 | 无 | REPL 会话 |
| 失败原因 | 不清晰 | killed + killReason |

## 快速上手

### 执行代码（最常用）
sandbox_exec(code="print('hello')")
sandbox_exec(code="console.log(1+1)", language="node")

### 执行系统命令
sandbox_exec(command="pip install pandas")
sandbox_exec(command="dir /s", timeout=60000)

### 持久 REPL 会话
sandbox_session(action="start") → 得到 sessionId
sandbox_session(sessionId="py-001", code="x = 42")
sandbox_session(sessionId="py-001", code="print(x)")  # 输出 42

### 并行执行
sandbox_batch(tasks=[
  {code: "print(1+1)"},
  {code: "console.log(2+2)", language: "node"},
  {command: "echo hello"}
])

## 6 个工具详细参数

### sandbox_exec — 执行代码/命令
| 参数 | 默认 | 说明 |
|------|------|------|
| code | - | 代码字符串（和 command 二选一） |
| command | - | 系统命令（和 code 二选一） |
| language | python | python/node/powershell/cmd/bash(需GitBash) |
| cwd | 当前目录 | 工作目录 |
| env | - | conda:名称 / venv:路径 |
| timeout | 30000 | 硬超时(ms)，最大300000(5分钟) |
| maxMemoryMB | 256 | 内存软限制(MB)，2s采样检测超限自动杀进程，实际峰值可能短暂超出 |
| maxOutput | 8000 | 输出截断上限(字符) |
| outputMode | full | full/tail/head/silent |
| tailLines | 20 | tail/head 取多少行 |
| maxLines | - | 输出行数上限，超过时保留头尾折叠中间 |
| gpu | false | 允许GPU（设置CUDA_VISIBLE_DEVICES） |

### sandbox_session — 持久 REPL
| action | 说明 |
|------|------|
| start | 创建会话（返回 sessionId） |
| exec | 执行代码（需 sessionId + code） |
| status | 查看会话内存/运行时间 |
| close | 关闭会话 |
| list | 列出所有活跃会话 |
限制: 最多3并发，空闲5分钟自动关闭，单会话最大512MB

### sandbox_batch — 并行执行
- tasks: 最多5个，每个含独立的 code/command/timeout/maxMemoryMB
- parallel: true(默认)/false
- maxParallel: 默认3
每个任务独立计时、独立超时、独立内存限制，某任务失败不影响其他

### sandbox_status — 系统状态
- overview: CPU/RAM/VRAM + 活跃会话 + 临时文件
- envs: Python/Node/conda/bash/CUDA 环境列表
- gpu: GPU/CUDA/DirectML 详情
- gc: 清理临时文件

## 返回值关键字段
| 字段 | 含义 |
|------|------|
| exitCode | 退出码（0=成功） |
| elapsed | 执行耗时 |
| killed | 是否被强制杀 |
| killReason | timeout/memory/vram/crash |
| peakMemoryMB | 内存峰值（短进程<200ms可能为0） |
| truncated | 输出是否被截断 |
| tempFile | 截断时完整输出的临时文件路径 |

## 使用技巧
1. **sandbox 可替代 run_command**：sandbox_exec(command=...) 可执行所有非交互式命令，自动继承 PowerShell 环境，且有超时保护、内存限制、输出截断。解决了 Antigravity 中 run_command 的输出检测不到问题
2. 需要装包后立即用：用 sandbox_session 保持环境
3. 同时装多个依赖：用 sandbox_batch 并行
4. 大量输出：设 outputMode="tail" + tailLines=10
5. 只关心成功/失败：设 outputMode="silent"
6. 编码安全：自动设置 PYTHONIOENCODING=utf-8，中文/emoji 无忧
7. 调用 Codex CLI：用 sandbox_codex，支持后台模式不阻塞
8. **输出去重**：连续重复的 stderr/stdout 块自动折叠为 [× N 重复]，节省上下文
9. **行数限制**：设 maxLines=30 控制输出行数，超过时保留头尾、折叠中间
10. **外部命令（pip/git/npm 等）**：如遇 PS NativeCommandError，设 language="cmd" 可避免
11. **PowerShell 兼容性**：PS 5.x 不支持 &&（用 ; 替代），& 需转义或设 language="cmd"

## sandbox_codex — Codex CLI 专用调用

调用 Codex CLI 执行审核/生成/重构等长时间任务。

**核心优势**：
- 后台模式（background=true）：启动后立刻返回 taskId，不阻塞
- 自动处理 --dangerously-bypass-approvals-and-sandbox
- 自动检查报告文件生成状态
- stderr 智能过滤（去除 MCP 调试日志）
- 上下文保护（有报告文件时压缩 stdout）
- 进程树自动清理，无孤儿残留

**同步模式**（短任务/向后兼容）：
sandbox_codex(prompt="简单任务", outputFile="报告.md")

**后台模式**（推荐，长任务不阻塞）：
sandbox_codex(prompt="请阅读 任务.md 并执行", outputFile="报告.md", background=true)
→ 返回 taskId，然后：
sandbox_codex(action="check", taskId="codex-001", waitSeconds=90)  — 等 90s 后查看（推荐）
sandbox_codex(action="kill",  taskId="codex-001")  — 终止任务
⚠️ action="wait" 会阻塞MCP直到完成，仅限短任务/调试

**参数说明**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| prompt | (启动时必须) | 任务提示词 |
| outputFile | 无 | 报告输出路径 |
| background | false | 后台模式，立刻返回 taskId |
| action | 无 | check（推荐）/wait（⚠️阻塞）/kill |
| taskId | 无 | 后台任务 ID（action 时必须） |
| **waitSeconds** | 无 | **check 前等待秒数（1-300），Codex 建议 90-120s** |
| cwd | 当前目录 | 工作目录 |
| timeout | 0(无超时) | 超时(ms)，最大1800000 |
| model | 无 | 指定模型（-m 参数），不传使用默认 |
| configOverrides | 无 | -c 配置覆盖 |
| maxOutput | 10000 | 输出截断上限 |

## sandbox_launch — 长任务脱离执行

适合模型训练、大规模数据处理等需要数小时~数天的任务。
进程完全独立于 MCP，关闭 IDE、换对话、MCP 重启都不影响。

**启动**：
sandbox_launch(command="python train.py --epochs 100", cwd="D:/Projects/MyModel")
→ 返回 taskId + PID + 日志路径

**查看进度**（配合 waitSeconds 避免频繁轮询）：
sandbox_launch(action="status", taskId="launch-001", tailLines=5, waitSeconds=60)
→ 等 60s 后返回日志尾部（任务完成时提前返回）

**其他操作**：
sandbox_launch(action="kill", taskId="launch-001")  — 终止
sandbox_launch(action="list")  — 列出所有任务
sandbox_launch(action="clean")  — 清理已完成任务

**参数说明**：
| 参数 | 默认值 | 说明 |
|------|--------|------|
| command | (启动时必须) | 要执行的命令 |
| cwd | 当前目录 | 工作目录 |
| logDir | sandbox-data/launches/ | 日志存放目录 |
| action | 无 | status/kill/list/clean |
| taskId | 无 | 任务 ID（status/kill 时使用） |
| tailLines | 10 | status 显示日志尾部行数 |
| waitSeconds | 无 | status 前等待秒数（1-300） |

**与 sandbox_codex 的区别**：
| | sandbox_codex | sandbox_launch |
|--|---------------|----------------|
| 适用 | Codex CLI（≤30min） | 任意长任务（无限制） |
| 进程归属 | MCP 子进程 | OS 独立进程 |
| 注册表 | 内存态（MCP 重启丢失） | 磁盘 JSON（持久化） |
| 输出 | 内存缓冲 | 日志文件 |

## 进程生命周期（v1.5+）

MCP 进程与父 LS 进程绑定（ppid），与窗口同生共死：
- **不再有超时自杀**：只要窗口开着，sandbox 就永远不会自行退出
- **窗口关闭时自动清理**：30s 内检测到父 LS 消失，自动 cleanup + exit
- 双保险：stdin 管道断裂（秒级）+ ppid 轮询检测（30s 兜底）
- launch 任务不受影响：进程独立于 MCP，窗口重启后可用 list 找回`,
                mimeType: "text/plain",
            },
        ],
    })
);

// === stdin 断开检测 ===
process.stdin.on("end", async () => {
    logStdinEvent("stdin END event — 对话可能已关闭");
    await cleanup();
    process.exit(0);
});

process.stdin.on("close", async () => {
    logStdinEvent("stdin CLOSE event");
    await cleanup();
    process.exit(0);
});

process.stdin.on("error", async (err) => {
    logStdinEvent(`stdin ERROR: ${err.message}`);
    await cleanup();
    process.exit(0);
});

// === 心跳检测：父 LS 进程存活检测 ===
const heartbeatInterval = setInterval(async () => {
    if (!isParentAlive()) {
        logStdinEvent(`父 LS (PID=${process.ppid}) 已消失，MCP 退出`);
        console.error(`[sandbox] 父 LS 进程 (PID=${process.ppid}) 已消失，自动退出`);
        await cleanup();
        process.exit(0);
    }
}, 30000);

heartbeatInterval.unref();

// === 启动 ===
async function main(): Promise<void> {
    console.error(`[sandbox] MCP Server v1.5.0 启动中... (ppid=${process.ppid})`);
    logStdinEvent("STARTED");

    // 初始化数据目录
    ensureDataDirs();

    // 清理过期临时文件
    cleanOldTempFiles();

    // 环境探测（异步，不阻塞启动）
    detectEnvironment().catch((err) => {
        console.error(`[sandbox] 环境探测失败: ${err}`);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[sandbox] MCP Server v1.5.0 已启动，绑定父 LS PID=${process.ppid}`);
    logStdinEvent(`BOUND to parent LS PID=${process.ppid}`);
}

main().catch((error) => {
    console.error("[sandbox] 启动失败:", error);
    process.exit(1);
});

// === 优雅关闭 ===
let isClosing = false;
const cleanup = async () => {
    if (isClosing) return;
    isClosing = true;
    console.error("[sandbox] 正在关闭...");
    clearInterval(heartbeatInterval);
    closeAllSessions(); // 关闭所有 REPL 会话和子进程
    cleanupCodexTasks(); // 清理所有后台 Codex 任务
};

process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
});

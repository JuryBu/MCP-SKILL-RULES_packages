import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { getCachedEnvInfo, detectEnvironment } from "../env-detector.js";
import { listSessions, closeSession, getActiveSessionCount } from "../session-manager.js";
import { cleanOldTempFiles, getTempStats } from "../temp-store.js";
import os from "os";

/**
 * sandbox_status 工具 — 系统状态
 */

const StatusParamsSchema = z.object({
    action: z.enum(["overview", "envs", "gpu", "gc"]).optional()
        .describe("操作：overview(默认)/envs/gpu/gc"),
});

export function registerStatus(server: McpServer): void {
    server.tool(
        "sandbox_status",
        `查看沙箱系统状态。包括可用环境列表、CUDA 信息、资源占用、活跃会话列表。

action:
- overview (默认): 系统资源 + 活跃会话 + 临时文件
- envs: 可用语言环境列表（Python/Node/conda/bash）
- gpu: GPU/CUDA/DirectML 详细信息
- gc: 清理过期临时文件；空闲会话由 idle checker 自动关闭`,
        StatusParamsSchema.shape,
        async (params) => {
            const startTime = Date.now();
            touchActivity();

            const parsed = StatusParamsSchema.safeParse(params);
            if (!parsed.success) {
                return {
                    content: [{ type: "text" as const, text: `❌ 参数错误: ${parsed.error.message}` }],
                };
            }

            const { action = "overview" } = parsed.data;

            try {
                switch (action) {
                    case "overview":
                        return appendTiming(await buildOverview(), startTime);
                    case "envs":
                        return appendTiming(await buildEnvs(), startTime);
                    case "gpu":
                        return appendTiming(await buildGpu(), startTime);
                    case "gc":
                        return appendTiming(await buildGc(), startTime);
                    default:
                        return {
                            content: [{ type: "text" as const, text: `❌ 未知操作: ${action}` }],
                        };
                }
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: `❌ 异常: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        }
    );
}

async function buildOverview() {
    const envInfo = getCachedEnvInfo();
    const sessions = await listSessions();
    const tempStats = getTempStats();

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuInfo = os.cpus();
    const cpuModel = cpuInfo[0]?.model || "Unknown";
    const cpuCores = cpuInfo.length;

    const cpuLoad = process.platform === "win32" ? "N/A(Win)" : (os.loadavg()[0]?.toFixed(1) || "N/A");

    const lines = [
        "🖥️ 沙箱系统状态",
        "",
        "系统资源:",
        `  CPU: ${cpuModel} (${cpuCores}线程) | 负载: ${cpuLoad}`,
        `  内存: ${formatMB(usedMem)}/${formatMB(totalMem)} (${Math.round(usedMem / totalMem * 100)}%) | 可用: ${formatMB(freeMem)}`,
    ];

    if (envInfo?.cuda?.available) {
        lines.push(`  GPU: VRAM ${envInfo.cuda.vramUsedMB}/${envInfo.cuda.vramTotalMB} MB | CUDA ${envInfo.cuda.version}`);
    }

    lines.push("");
    lines.push(`活跃会话: ${sessions.length}/3`);
    if (sessions.length > 0) {
        for (const s of sessions) {
            lines.push(`  ${s.id} | ${s.language} | ${s.memoryMB}MB | 运行 ${s.uptime} | 执行 ${s.execCount} 次`);
        }
    }

    lines.push("");
    lines.push(`临时文件: ${tempStats.count} 个 | ${formatBytes(tempStats.totalBytes)}`);

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

async function buildEnvs() {
    const envInfo = getCachedEnvInfo() || await detectEnvironment();

    const lines = [];

    // Python
    lines.push("🐍 Python:");
    if (envInfo.python.available) {
        lines.push(`  系统: Python ${envInfo.python.version} | ${envInfo.python.path}`);
    } else {
        lines.push("  ❌ 未检测到");
    }

    // conda
    if (envInfo.conda.available && envInfo.conda.envs.length > 0) {
        lines.push("");
        lines.push("🐍 Conda 环境:");
        for (const env of envInfo.conda.envs) {
            lines.push(`  conda:${env.name} | Python ${env.pythonVersion} | ${env.path}`);
        }
    }

    // Node.js
    lines.push("");
    lines.push("📦 Node.js:");
    if (envInfo.node.available) {
        lines.push(`  v${envInfo.node.version} | ${envInfo.node.path}`);
    } else {
        lines.push("  ❌ 未检测到");
    }

    // Bash
    lines.push("");
    lines.push("🐚 Bash:");
    if (envInfo.bash.available) {
        lines.push(`  ✅ 可用 | ${envInfo.bash.path}`);
    } else {
        lines.push("  ❌ 未检测到（Windows 需安装 Git Bash）");
    }

    // CUDA
    lines.push("");
    lines.push("🎮 CUDA:");
    if (envInfo.cuda.available) {
        lines.push(`  版本: ${envInfo.cuda.version} | VRAM: ${envInfo.cuda.vramTotalMB}MB | 驱动: ${envInfo.cuda.driverVersion}`);
    } else {
        lines.push("  ❌ 未检测到");
    }

    if (envInfo.directML) {
        lines.push("");
        lines.push("💠 DirectML: ✅ 可用");
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

async function buildGpu() {
    const envInfo = getCachedEnvInfo() || await detectEnvironment();

    if (!envInfo.cuda.available) {
        return {
            content: [{ type: "text" as const, text: "🎮 GPU/CUDA: 未检测到 NVIDIA GPU" }],
        };
    }

    const lines = [
        "🎮 GPU 详细信息",
        "",
        `  CUDA 版本: ${envInfo.cuda.version}`,
        `  驱动版本: ${envInfo.cuda.driverVersion}`,
        `  VRAM 总量: ${envInfo.cuda.vramTotalMB} MB`,
        `  VRAM 已用: ${envInfo.cuda.vramUsedMB} MB`,
        `  VRAM 可用: ${envInfo.cuda.vramTotalMB - envInfo.cuda.vramUsedMB} MB`,
        `  DirectML: ${envInfo.directML ? "✅ 可用" : "❌ 不可用"}`,
    ];

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

async function buildGc() {
    const cleaned = cleanOldTempFiles();
    const sessions = await listSessions();

    // gc 只清理临时文件
    // 空闲会话由 idle checker 自动处理

    const lines = [
        "🧹 清理完成",
        `  临时文件清理: ${cleaned} 个`,
        `  活跃会话: ${sessions.length} 个（由空闲超时自动管理）`,
    ];

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

function formatMB(bytes: number): string {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * WSF 本地 .pb 兜底（叶子模块）
 *
 * 数据源：~/.codeium/windsurf/cascade/<cascadeId>.pb（扁平、protobuf）
 * 严格约束（见蓝图步骤 3）：只判存在 / 列候选 / 取 mtime，绝不解析 .pb 正文。
 *
 * 用途：所有活跃 WSF LS 都不持有某 cascadeId 时，若本地 .pb 存在，
 * 由 loadWindsurfConversation 返回 partial:true 空壳明确提示「窗口已关、对话曾存在」，
 * 而非静默返空伪装成功（见失败路径 ⑥-a）。
 */

const WINDSURF_CASCADE_DIR = path.join(os.homedir(), ".codeium", "windsurf", "cascade");

/** 测试注入的目录覆盖（null=用真实目录） */
let cascadeDirOverride: string | null = null;

/**
 * 测试专用：覆盖本地 .pb 目录，避免污染真实 ~/.codeium 目录。生产代码不调用。
 */
export function __setWindsurfCascadeDirForTest(dir: string | null): void {
    cascadeDirOverride = dir;
}

function cascadeDir(): string {
    return cascadeDirOverride ?? WINDSURF_CASCADE_DIR;
}

/** cascadeId → 安全文件名（防路径穿越） */
function safeCascadeFile(cascadeId: string): string {
    const safe = cascadeId.replace(/[^a-zA-Z0-9_-]/g, "");
    return `${safe}.pb`;
}

/** 该 cascadeId 的本地 .pb 是否存在 */
export function windsurfCascadeExistsLocally(cascadeId: string): boolean {
    if (!cascadeId) return false;
    try {
        return fs.existsSync(path.join(cascadeDir(), safeCascadeFile(cascadeId)));
    } catch {
        return false;
    }
}

/** 列出本地全部 cascadeId 候选（含 mtime，按 mtime 降序） */
export function listLocalWindsurfCascadeIds(): { cascadeId: string; mtimeMs: number }[] {
    const dir = cascadeDir();
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => f.endsWith(".pb"))
            .map(f => {
                const cascadeId = f.replace(/\.pb$/u, "");
                let mtimeMs = 0;
                try {
                    mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs;
                } catch { /* stat 失败视为 0 */ }
                return { cascadeId, mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
        return [];
    }
}

/** 猜当前 WSF 对话 cascadeId（取 mtime 最新的本地 .pb，纯兜底） */
export function guessCurrentWindsurfCascadeId(): string | null {
    const all = listLocalWindsurfCascadeIds();
    return all.length > 0 ? all[0].cascadeId : null;
}

import path from "path";
import os from "os";
import fs from "fs";

/**
 * MCP Memory Store 临时文件管理器
 * 
 * 用途：
 * - memory_read 全文输出写临时文件（不占对话上下文）
 * - memory_query(depth=full) 批量输出写临时文件
 * 
 * 策略：
 * - 存放在 memory-store/temp/ 目录（非 OS 临时目录，随数据走）
 * - 1 小时过期自动清理
 * - 启动时清理所有过期文件
 * - 文件名含时间戳避免冲突
 */

// 数据根目录（与 store.ts 共享）
const DATA_ROOT = process.env.MEMORY_STORE_DATA_ROOT
    || (process.env.CODEX_TOOLKIT_DATA_ROOT
        ? path.join(process.env.CODEX_TOOLKIT_DATA_ROOT, "memory-store")
        : path.join(os.homedir(), ".codex-toolkit", "memory-store"));
export const TEMP_DIR = path.join(DATA_ROOT, "temp");

// 文件最大存活时间
const MAX_AGE_MS = 60 * 60 * 1000; // 1 小时

/**
 * 确保临时目录存在
 */
export function ensureTempDir(): void {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

/**
 * 生成临时文件名（含时间戳，避免冲突）
 * @param prefix 前缀标识（如 "mem", "query"）
 * @param slug 短标识（如记忆 ID 中的 slug 部分）
 */
function generateTempFilename(prefix: string, slug: string): string {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    // 清理 slug 中的特殊字符
    const safeSlug = slug.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "").slice(0, 30);
    return `${prefix}_${ts}_${safeSlug}.md`;
}

/**
 * 保存内容到临时文件
 * @returns 文件绝对路径
 */
export function saveTempFile(prefix: string, slug: string, content: string): string {
    ensureTempDir();
    const filename = generateTempFilename(prefix, slug);
    const filePath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
}

/**
 * 清理过期临时文件
 */
export function cleanOldTempFiles(): void {
    if (!fs.existsSync(TEMP_DIR)) return;

    const now = Date.now();
    let cleaned = 0;

    const cleanDir = (dir: string): boolean => {
        let hasLiveEntries = false;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            try {
                if (entry.isDirectory()) {
                    const empty = cleanDir(entryPath);
                    if (empty) {
                        fs.rmdirSync(entryPath);
                    } else {
                        hasLiveEntries = true;
                    }
                    continue;
                }
                const stat = fs.statSync(entryPath);
                if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
                    fs.unlinkSync(entryPath);
                    cleaned++;
                } else {
                    hasLiveEntries = true;
                }
            } catch {
                hasLiveEntries = true;
            }
        }
        return !hasLiveEntries && dir !== TEMP_DIR;
    };

    try {
        cleanDir(TEMP_DIR);
    } catch { /* 忽略目录读取错误 */ }

    if (cleaned > 0) {
        console.error(`[memory-store] 清理了 ${cleaned} 个过期临时文件`);
    }
}

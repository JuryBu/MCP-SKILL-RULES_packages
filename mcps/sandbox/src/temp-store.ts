import path from "path";
import os from "os";
import fs from "fs";

/**
 * MCP Sandbox 临时文件管理器
 * 
 * 用途：
 * - 代码执行时的临时脚本文件（exec 模式）
 * - 大输出写临时文件（防上下文爆炸）
 * 
 * 策略：
 * - 存放在 sandbox-data/temp/ 目录
 * - 1 小时过期自动清理
 * - 启动时清理所有过期文件
 * - 脚本执行完立即删除，输出文件保留到过期
 */

// 数据根目录
export const DATA_ROOT = path.resolve(process.env.SANDBOX_DATA_ROOT || path.join(process.cwd(), "sandbox-data"));
export const TEMP_DIR = path.join(DATA_ROOT, "temp");

// 文件最大存活时间
const MAX_AGE_MS = 60 * 60 * 1000; // 1 小时

/**
 * 确保数据目录存在
 */
export function ensureDataDirs(): void {
    if (!fs.existsSync(DATA_ROOT)) {
        fs.mkdirSync(DATA_ROOT, { recursive: true });
    }
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

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
 */
function generateTempFilename(prefix: string, ext: string): string {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${prefix}_${ts}_${rand}.${ext}`;
}

/**
 * 保存临时脚本文件（用于 code 模式执行）
 * @returns 文件绝对路径
 */
export function saveTempScript(language: string, code: string): string {
    ensureTempDir();
    const extMap: Record<string, string> = {
        python: "py",
        node: "js",
        powershell: "ps1",
        cmd: "bat",
        bash: "sh",
    };
    const ext = extMap[language] || "txt";
    const filename = generateTempFilename("exec", ext);
    const filePath = path.join(TEMP_DIR, filename);

    // PowerShell 5.1 读 .ps1 文件默认用系统编码(GBK)，必须加 UTF-8 BOM 才能正确解析
    if (language === "powershell") {
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const content = Buffer.from(code, "utf-8");
        fs.writeFileSync(filePath, Buffer.concat([bom, content]));
    } else {
        fs.writeFileSync(filePath, code, "utf-8");
    }

    return filePath;
}

/**
 * 保存大输出到临时文件（防上下文爆炸）
 * @returns 文件绝对路径
 */
export function saveTempOutput(content: string): string {
    ensureTempDir();
    const filename = generateTempFilename("out", "txt");
    const filePath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
}

/**
 * 删除临时文件（脚本执行完后调用）
 */
export function removeTempFile(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch { /* 删除失败不影响运行 */ }
}

/**
 * 清理过期临时文件
 */
export function cleanOldTempFiles(): number {
    if (!fs.existsSync(TEMP_DIR)) return 0;

    const now = Date.now();
    let cleaned = 0;

    try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
            } catch { /* 忽略单个文件错误 */ }
        }
    } catch { /* 忽略目录读取错误 */ }

    if (cleaned > 0) {
        console.error(`[sandbox] 清理了 ${cleaned} 个过期临时文件`);
    }
    return cleaned;
}

/**
 * 获取临时文件统计
 */
export function getTempStats(): { count: number; totalBytes: number } {
    if (!fs.existsSync(TEMP_DIR)) return { count: 0, totalBytes: 0 };

    let count = 0;
    let totalBytes = 0;

    try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const file of files) {
            try {
                const stat = fs.statSync(path.join(TEMP_DIR, file));
                if (stat.isFile()) {
                    count++;
                    totalBytes += stat.size;
                }
            } catch { /* skip */ }
        }
    } catch { /* skip */ }

    return { count, totalBytes };
}

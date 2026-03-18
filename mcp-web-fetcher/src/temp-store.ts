import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

/**
 * MCP Web Fetcher 临时文件管理器
 * - 统一管理截图、转换PDF、录屏等临时文件
 * - 缓存命中机制避免重复工作
 * - 启动时自动清理过时文件
 */

// 临时文件根目录
const TEMP_ROOT = path.join(os.tmpdir(), "mcp-web-fetcher");

// 子目录分类
export const TEMP_DIRS = {
    screenshots: path.join(TEMP_ROOT, "screenshots"),
    converted: path.join(TEMP_ROOT, "converted"),
    recordings: path.join(TEMP_ROOT, "recordings"),
    pages: path.join(TEMP_ROOT, "pages"),
    downloads: path.join(TEMP_ROOT, "downloads"),
} as const;

export type TempCategory = keyof typeof TEMP_DIRS;

// 文件最大存活时间（毫秒）
const MAX_AGE_MS = 60 * 60 * 1000; // 1 小时

/**
 * 生成缓存 key（sha256 前 12 位）
 */
export function generateCacheKey(...parts: (string | number | boolean | undefined)[]): string {
    const raw = parts.filter(p => p !== undefined).join("|");
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/**
 * 确保临时目录存在
 */
export function ensureTempDirs(): void {
    for (const dir of Object.values(TEMP_DIRS)) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * 保存临时文件
 * @returns 文件绝对路径
 */
export function saveTempFile(
    category: TempCategory,
    key: string,
    ext: string,
    data: Buffer | string
): string {
    ensureTempDirs();
    const filename = `${key}${ext}`;
    const filePath = path.join(TEMP_DIRS[category], filename);
    fs.writeFileSync(filePath, data);
    return filePath;
}

/**
 * 查找缓存文件（命中则返回路径，未命中返回 null）
 */
export function getTempFile(category: TempCategory, key: string, ext: string): string | null {
    const filePath = path.join(TEMP_DIRS[category], `${key}${ext}`);
    if (fs.existsSync(filePath)) {
        // 检查是否过期
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs < MAX_AGE_MS) {
            return filePath;
        }
        // 过期了，删除
        fs.unlinkSync(filePath);
    }
    return null;
}

/**
 * 启动时清理过期临时文件
 */
export function cleanOldTempFiles(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const dir of Object.values(TEMP_DIRS)) {
        if (!fs.existsSync(dir)) continue;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (now - stat.mtimeMs > MAX_AGE_MS) {
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                } catch { /* 忽略单个文件错误 */ }
            }
        } catch { /* 忽略目录读取错误 */ }
    }

    if (cleaned > 0) {
        console.error(`[web-fetcher] 清理了 ${cleaned} 个过期临时文件`);
    }
}

/**
 * 生成本地文件的缓存 key（基于路径 + 修改时间 + 文件大小）
 */
export function fileHashKey(filePath: string): string {
    try {
        const stat = fs.statSync(filePath);
        return generateCacheKey(filePath, stat.mtimeMs, stat.size);
    } catch {
        return generateCacheKey(filePath, Date.now());
    }
}

// ========== 大图自动分片 ==========
// IDE 后端 API 限制图片任何维度不能超过 8000px
// 阈值 1600px（大模型视觉最佳输入范围 200~1568px/边），重叠 300px
// 这样每片大约是 1920×1600，比例约 1.2:1，各家模型都能很好理解

const SPLIT_THRESHOLD = 1600;
const SPLIT_OVERLAP = 300;

export interface SplitResult {
    /** 是否发生了分片 */
    wasSplit: boolean;
    /** 分片文件路径列表（未分片时只有一个元素） */
    paths: string[];
    /** 各分片大小（KB） */
    sizes: string[];
    /** 原始图片尺寸 */
    originalWidth: number;
    originalHeight: number;
    /** 人类可读的描述 */
    description: string;
}

/**
 * 检测图片是否超过 IDE 尺寸限制，超过则自动分片保存
 * @param buffer 原始截图 Buffer
 * @param category 临时文件分类
 * @param baseKey 缓存 key 基础值
 * @param ext 文件扩展名
 * @returns SplitResult
 */
export async function splitOversizedImage(
    buffer: Buffer,
    category: TempCategory,
    baseKey: string,
    ext: string = ".jpg",
): Promise<SplitResult> {
    let sharp: typeof import("sharp");
    try {
        sharp = (await import("sharp")).default;
    } catch {
        // sharp 不可用，直接保存原图
        const filePath = saveTempFile(category, baseKey, ext, buffer);
        const sizeKB = (buffer.length / 1024).toFixed(1);
        return {
            wasSplit: false,
            paths: [filePath],
            sizes: [sizeKB],
            originalWidth: 0,
            originalHeight: 0,
            description: `(${sizeKB} KB)`,
        };
    }

    const metadata = await sharp(buffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    // 不超限，直接保存
    if (width <= SPLIT_THRESHOLD && height <= SPLIT_THRESHOLD) {
        const filePath = saveTempFile(category, baseKey, ext, buffer);
        const sizeKB = (buffer.length / 1024).toFixed(1);
        return {
            wasSplit: false,
            paths: [filePath],
            sizes: [sizeKB],
            originalWidth: width,
            originalHeight: height,
            description: `(${sizeKB} KB)`,
        };
    }

    // 需要分片
    console.error(`[web-fetcher] 图片尺寸 ${width}×${height} 超限，自动分片 (阈值 ${SPLIT_THRESHOLD}px, 重叠 ${SPLIT_OVERLAP}px)`);

    const paths: string[] = [];
    const sizes: string[] = [];

    if (height > SPLIT_THRESHOLD) {
        // 沿高度方向分片（最常见：fullPage 截图）
        const sliceHeight = SPLIT_THRESHOLD;
        let top = 0;
        let sliceIndex = 0;

        while (top < height) {
            const actualHeight = Math.min(sliceHeight, height - top);
            const sliceBuffer = await sharp(buffer)
                .extract({ left: 0, top, width, height: actualHeight })
                .toBuffer();

            const sliceKey = `${baseKey}_s${sliceIndex}`;
            const filePath = saveTempFile(category, sliceKey, ext, sliceBuffer);
            const sizeKB = (sliceBuffer.length / 1024).toFixed(1);

            paths.push(filePath);
            sizes.push(sizeKB);
            sliceIndex++;

            // 下一片起始位置（减去重叠区域）
            top += sliceHeight - SPLIT_OVERLAP;
        }
    } else {
        // 沿宽度方向分片（极少见但防御性处理）
        const sliceWidth = SPLIT_THRESHOLD;
        let left = 0;
        let sliceIndex = 0;

        while (left < width) {
            const actualWidth = Math.min(sliceWidth, width - left);
            const sliceBuffer = await sharp(buffer)
                .extract({ left, top: 0, width: actualWidth, height })
                .toBuffer();

            const sliceKey = `${baseKey}_s${sliceIndex}`;
            const filePath = saveTempFile(category, sliceKey, ext, sliceBuffer);
            const sizeKB = (sliceBuffer.length / 1024).toFixed(1);

            paths.push(filePath);
            sizes.push(sizeKB);
            sliceIndex++;

            left += sliceWidth - SPLIT_OVERLAP;
        }
    }

    const totalSizeKB = sizes.reduce((sum, s) => sum + parseFloat(s), 0).toFixed(1);
    const description = `原图 ${width}×${height}px 超限，已自动分为 ${paths.length} 片 (共 ${totalSizeKB} KB, 重叠 ${SPLIT_OVERLAP}px)`;

    console.error(`[web-fetcher] ${description}`);

    return {
        wasSplit: true,
        paths,
        sizes,
        originalWidth: width,
        originalHeight: height,
        description,
    };
}

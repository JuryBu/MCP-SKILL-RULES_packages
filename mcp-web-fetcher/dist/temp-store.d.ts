export declare const TEMP_DIRS: {
    readonly screenshots: string;
    readonly converted: string;
    readonly recordings: string;
    readonly pages: string;
    readonly downloads: string;
};
export type TempCategory = keyof typeof TEMP_DIRS;
/**
 * 生成缓存 key（sha256 前 12 位）
 */
export declare function generateCacheKey(...parts: (string | number | boolean | undefined)[]): string;
/**
 * 确保临时目录存在
 */
export declare function ensureTempDirs(): void;
/**
 * 保存临时文件
 * @returns 文件绝对路径
 */
export declare function saveTempFile(category: TempCategory, key: string, ext: string, data: Buffer | string): string;
/**
 * 查找缓存文件（命中则返回路径，未命中返回 null）
 */
export declare function getTempFile(category: TempCategory, key: string, ext: string): string | null;
/**
 * 启动时清理过期临时文件
 */
export declare function cleanOldTempFiles(): void;
/**
 * 生成本地文件的缓存 key（基于路径 + 修改时间 + 文件大小）
 */
export declare function fileHashKey(filePath: string): string;
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
export declare function splitOversizedImage(buffer: Buffer, category: TempCategory, baseKey: string, ext?: string): Promise<SplitResult>;
//# sourceMappingURL=temp-store.d.ts.map
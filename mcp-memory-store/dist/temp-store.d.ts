export declare const TEMP_DIR: string;
/**
 * 确保临时目录存在
 */
export declare function ensureTempDir(): void;
/**
 * 保存内容到临时文件
 * @returns 文件绝对路径
 */
export declare function saveTempFile(prefix: string, slug: string, content: string): string;
/**
 * 清理过期临时文件
 */
export declare function cleanOldTempFiles(): void;
//# sourceMappingURL=temp-store.d.ts.map
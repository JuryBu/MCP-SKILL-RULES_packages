export declare const TEMP_DIR: string;
/**
 * 确保数据目录存在
 */
export declare function ensureDataDirs(): void;
/**
 * 确保临时目录存在
 */
export declare function ensureTempDir(): void;
/**
 * 保存临时脚本文件（用于 code 模式执行）
 * @returns 文件绝对路径
 */
export declare function saveTempScript(language: string, code: string): string;
/**
 * 保存大输出到临时文件（防上下文爆炸）
 * @returns 文件绝对路径
 */
export declare function saveTempOutput(content: string): string;
/**
 * 删除临时文件（脚本执行完后调用）
 */
export declare function removeTempFile(filePath: string): void;
/**
 * 清理过期临时文件
 */
export declare function cleanOldTempFiles(): number;
/**
 * 获取临时文件统计
 */
export declare function getTempStats(): {
    count: number;
    totalBytes: number;
};
//# sourceMappingURL=temp-store.d.ts.map
/**
 * 清除缓存（LS 可能已重启）
 */
export declare function clearLsCache(): void;
/**
 * 调用 LS 的 GetModelResponse API 直接调用模型
 *
 * @param prompt 用户 prompt
 * @param model 模型编码，默认 Gemini 3 Flash
 * @param timeoutMs 超时时间，默认 30s（摘要可能较长）
 * @returns 模型响应文本，或 null（LS 不可用时）
 */
export declare function callGetModelResponse(prompt: string, model?: string, timeoutMs?: number): Promise<string | null>;
/**
 * 检查 LS 是否可用（用于判断是否能使用 AI Summary）
 */
export declare function isLsAvailable(): Promise<boolean>;
/**
 * 获取 LS 状态信息（用于调试/日志）
 */
export declare function getLsStatus(): {
    available: boolean;
    pid?: number;
    port?: number;
};
//# sourceMappingURL=ls-client.d.ts.map
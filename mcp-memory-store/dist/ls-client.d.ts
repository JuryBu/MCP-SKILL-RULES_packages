/**
 * Language Server connect-rpc 客户端
 *
 * v1.6 重构：ppid 直连 + 注册表加速 + 三步查找
 *
 * 路由层（本次重构）：
 *   parentLs 体系取代旧 cachedLsInfo 体系
 *   fetchTrajectory 三步查找：父 LS → 注册表 → PowerShell 兜底
 *
 * 数据层（不变）：
 *   fetchAllStepsPaged / fetchStepsIncremental / verifyTail / rpcCall
 */
export interface LsProcessInfo {
    pid: number;
    csrfToken: string;
    workspaceId: string;
    ports: number[];
}
/** 父 LS 已确认的连接信息（含验证后的 HTTP 端口） */
interface ParentLsConnection {
    info: LsProcessInfo;
    port: number;
}
/**
 * 获取已缓存的父 LS 连接（未就绪返回 null）
 */
export declare function getParentLs(): ParentLsConnection | null;
/**
 * 异步初始化父 LS 连接（不阻塞工具注册，带重试）
 * 在 index.ts 的 main() 中调用
 */
export declare function initParentLs(): Promise<void>;
/**
 * 发现所有 LS 进程（PowerShell 全量扫描）
 * v1.6: 降级为三步查找的 Step 3 兜底手段
 */
export declare function discoverLsProcesses(): LsProcessInfo[];
/**
 * 获取指定对话的完整 trajectory 数据
 *
 * v1.6 三步查找策略：
 * Step 1: 父 LS（ppid 直连，0 发现开销）→ 大多数场景直接命中
 * Step 2: 注册表中其他 LS（~5ms）→ 跨窗口对话
 * Step 3: PowerShell 全量发现（极罕见兜底）→ 刚开的窗口未注册时
 *
 * 数据获取策略（在找到 LS 后）：
 * 1. 轻量 check → stepCount 没变 → 用缓存
 * 2. stepCount 变了 → 增量 + 尾部校验
 * 3. 回溯或校验失败 → 并行分页全量重拉
 */
export declare function fetchTrajectory(cascadeId: string, forceRefresh?: boolean): Promise<{
    trajectory: any;
    fromCache: boolean;
} | null>;
/**
 * 获取当前对话的 cascadeId
 * v1.6: 从父 LS 热列表获取（精确），兜底用 .pb 修改时间猜测
 */
export declare function getCurrentCascadeId(): Promise<string | null>;
/**
 * 列出所有可获取的对话 ID（从 conversations 目录）
 */
export declare function listConversationIds(): string[];
/**
 * 检查 LS 是否可用于 AI 摘要功能
 * v1.6: 直接检查 parentLs
 */
export declare function isLsAvailable(): Promise<boolean>;
/**
 * 调用 LS GetModelResponse 生成 AI 回复
 * v1.6: 直接用 parentLs，不走全量发现
 */
export declare function callGetModelResponse(model: string, prompt: string): Promise<string | null>;
/**
 * 使用 LS Flash 模型生成 auto summary
 * LS 不可用时返回 null，调用方应 fallback 到手动摘要
 */
export declare function generateAutoSummary(title: string, tags: string[], content: string): Promise<string | null>;
export {};
//# sourceMappingURL=ls-client.d.ts.map
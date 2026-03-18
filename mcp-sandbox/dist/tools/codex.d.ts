import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * 清理所有运行中的 Codex 任务（进程退出时调用）
 */
export declare function cleanupCodexTasks(): void;
/**
 * 获取活跃任务数量（供 status 工具使用）
 */
export declare function getCodexTaskCount(): {
    running: number;
    total: number;
};
export declare function registerCodex(server: McpServer): void;
//# sourceMappingURL=codex.d.ts.map
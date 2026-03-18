import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * memory_write — 写入新记忆
 * 自动检测相似记忆并提醒（不阻止写入）
 * v1.5: 写入后异步调用 Flash 生成 autoSummary
 */
export declare function registerWrite(server: McpServer): void;
//# sourceMappingURL=write.d.ts.map
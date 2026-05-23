import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    findMemoryById,
    deleteMemoryFile,
    readWorkspaceIndex,
    writeWorkspaceIndex,
    syncGlobalIndexForWorkspace,
} from "../store.js";

/**
 * memory_delete — 删除记忆
 */
export function registerDelete(server: McpServer): void {
    server.tool(
        "memory_delete",
        "删除一条记忆。",
        {
            id: z.string().describe("记忆 ID"),
        },
        async ({ id }) => {
            touchActivity();
            const startTime = Date.now();

            try {
                const found = findMemoryById(id);
                if (!found) {
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `❌ 记忆不存在: ${id}`,
                        }],
                    }, startTime);
                }

                const { hash, entry } = found;

                // 删除文件
                deleteMemoryFile(hash, id);

                // 更新索引
                const wsIndex = readWorkspaceIndex(hash);
                wsIndex.entries = wsIndex.entries.filter(e => e.id !== id);
                writeWorkspaceIndex(hash, wsIndex);
                syncGlobalIndexForWorkspace(hash);

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `🗑️ 已删除记忆: [${id}] "${entry.title}"`,
                    }],
                }, startTime);
            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `❌ 删除失败: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                }, startTime);
            }
        }
    );
}

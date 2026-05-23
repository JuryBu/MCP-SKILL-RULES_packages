import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { readMemoryFile, findMemoryById } from "../store.js";
import { saveTempFile } from "../temp-store.js";

/**
 * memory_read — 读取单条记忆
 * 支持行范围读取，无范围时写临时文件
 */
export function registerRead(server: McpServer): void {
    server.tool(
        "memory_read",
        "读取一条记忆的完整内容。支持行范围读取（startLine/endLine）。无范围时写临时文件返回路径。",
        {
            id: z.string().describe("记忆 ID"),
            startLine: z.number().optional().describe("起始行（1-indexed）"),
            endLine: z.number().optional().describe("结束行（1-indexed）"),
        },
        async ({ id, startLine, endLine }) => {
            touchActivity();
            const startTime = Date.now();

            try {
                // 查找记忆所在的工作区
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
                const content = readMemoryFile(hash, id);
                if (!content) {
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `❌ 记忆文件已丢失: ${id}（索引存在但文件不存在）`,
                        }],
                    }, startTime);
                }

                // 有范围参数 → 直接返回指定行
                if (startLine !== undefined || endLine !== undefined) {
                    const lines = content.split(/\r?\n/);
                    const start = Math.max(1, startLine || 1);
                    const end = Math.min(lines.length, endLine || lines.length);

                    const rangeContent = lines.slice(start - 1, end).join("\n");

                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `📄 [${id}] "${entry.title}" 第 ${start}-${end} 行（共 ${lines.length} 行）\n\n${rangeContent}`,
                        }],
                    }, startTime);
                }

                // 无范围 → 写临时文件
                const lines = content.split(/\r?\n/);
                const tempPath = saveTempFile("mem", id, content);
                const sizeKB = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `📄 记忆已导出到临时文件\n路径: ${tempPath}\n标题: ${entry.title}\n总行数: ${lines.length}\n大小: ${sizeKB} KB\n用 view_file 读取即可`,
                    }],
                }, startTime);
            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `❌ 读取失败: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                }, startTime);
            }
        }
    );
}

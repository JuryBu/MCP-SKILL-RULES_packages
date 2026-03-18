import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    ensureWorkspace,
    generateMemoryId,
    buildMemoryFile,
    writeMemoryFile,
    readMemoryFile,
    readWorkspaceIndex,
    writeWorkspaceIndex,
    syncGlobalIndexForWorkspace,
    findMemoryById,
    deleteMemoryFile,
    parseMemoryFile,
    countLines,
    readConfig,
    findWorkspaceHash,
    readGeneralIndex,
    type MemoryFrontmatter,
} from "../store.js";
import { type MemoryIndexEntry } from "../cache.js";
import { saveTempFile } from "../temp-store.js";
import { fuseSearch, grepInEntries } from "../search.js";

/**
 * memory_batch — 批量操作
 * 一次调用执行多个记忆操作（最多 20 个）
 */

/** 单个操作的类型 */
const OperationSchema = z.object({
    action: z.enum(["write", "read", "query", "update", "delete"]),
    // write 参数
    title: z.string().optional(),
    content: z.string().optional(),
    searchSummary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    workspace: z.string().optional(),
    category: z.enum(["problem-solution", "technical-note", "conversation", "general"]).optional(),
    conversationId: z.string().optional(),
    // read/update/delete 参数
    id: z.string().optional(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    append: z.string().optional(),
    // query 参数
    query: z.string().optional(),
    grep: z.string().optional(),
    depth: z.enum(["index", "summary", "full"]).optional(),
    limit: z.number().optional(),
    // pinned 参数
    pinned: z.boolean().optional(),
});

export function registerBatch(server: McpServer): void {
    server.tool(
        "memory_batch",
        "一次调用执行多个记忆操作。适用于批量导入、链式查询、多条更新。最多 20 个操作。",
        {
            operations: z.array(OperationSchema).max(20).describe("操作列表（最多 20 个）"),
            workspace: z.string().optional().describe("统一工作区（可被单个操作覆盖）"),
        },
        async ({ operations, workspace }) => {
            touchActivity();
            const startTime = Date.now();

            const results: string[] = [];
            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < operations.length; i++) {
                const op = operations[i];
                const opWorkspace = op.workspace || workspace || "general";

                try {
                    let result = "";

                    switch (op.action) {
                        case "write": {
                            if (!op.title || !op.content || !op.searchSummary || !op.tags) {
                                result = `❌ write 缺少必须参数 (title/content/searchSummary/tags)`;
                                failCount++;
                                break;
                            }
                            const config = readConfig();
                            if (Buffer.byteLength(op.content, "utf-8") > config.maxEntrySize) {
                                result = `❌ 内容过大`;
                                failCount++;
                                break;
                            }

                            let hash: string;
                            if (opWorkspace === "general") {
                                hash = "general";
                            } else {
                                const ws = ensureWorkspace(opWorkspace);
                                hash = ws.hash;
                            }

                            const id = generateMemoryId(op.title);
                            const now = new Date().toISOString();
                            const fm: MemoryFrontmatter = {
                                id,
                                title: op.title,
                                tags: op.tags,
                                category: op.category || "general",
                                created: now,
                                updated: now,
                                workspace: opWorkspace,
                                conversationId: op.conversationId,
                                searchSummary: op.searchSummary,
                                pinned: op.pinned,
                            };
                            const fileContent = buildMemoryFile(fm, op.content);
                            writeMemoryFile(hash, id, fileContent);

                            const wsIndex = readWorkspaceIndex(hash);
                            wsIndex.entries.push({
                                id, title: op.title, searchSummary: op.searchSummary,
                                tags: op.tags, category: op.category || "general",
                                createdAt: now, updatedAt: now, lastAccessed: now,
                                sizeBytes: Buffer.byteLength(fileContent, "utf-8"),
                                lineCount: countLines(fileContent),
                                conversationId: op.conversationId,
                                pinned: op.pinned,
                            });
                            writeWorkspaceIndex(hash, wsIndex);
                            syncGlobalIndexForWorkspace(hash);

                            result = `✅ write: [${id}] "${op.title}"`;
                            successCount++;
                            break;
                        }

                        case "read": {
                            if (!op.id) { result = `❌ read 缺少 id`; failCount++; break; }
                            const found = findMemoryById(op.id);
                            if (!found) { result = `❌ read: 记忆不存在 ${op.id}`; failCount++; break; }
                            const content = readMemoryFile(found.hash, op.id);
                            if (!content) { result = `❌ read: 文件丢失 ${op.id}`; failCount++; break; }

                            if (op.startLine || op.endLine) {
                                const lines = content.split(/\r?\n/);
                                const s = Math.max(1, op.startLine || 1);
                                const e = Math.min(lines.length, op.endLine || lines.length);
                                result = `📄 [${op.id}] 第 ${s}-${e} 行:\n${lines.slice(s - 1, e).join("\n")}`;
                            } else {
                                const tempPath = saveTempFile("batch", op.id, content);
                                result = `📄 [${op.id}] → ${tempPath}`;
                            }
                            successCount++;
                            break;
                        }

                        case "delete": {
                            if (!op.id) { result = `❌ delete 缺少 id`; failCount++; break; }
                            const found = findMemoryById(op.id);
                            if (!found) { result = `❌ delete: 不存在 ${op.id}`; failCount++; break; }
                            deleteMemoryFile(found.hash, op.id);
                            const wsIndex = readWorkspaceIndex(found.hash);
                            wsIndex.entries = wsIndex.entries.filter(e => e.id !== op.id);
                            writeWorkspaceIndex(found.hash, wsIndex);
                            syncGlobalIndexForWorkspace(found.hash);
                            result = `🗑️ delete: [${op.id}]`;
                            successCount++;
                            break;
                        }

                        case "query": {
                            // grep 模式
                            if (op.grep) {
                                let hash = "general";
                                if (opWorkspace !== "general") {
                                    hash = findWorkspaceHash(opWorkspace) || "general";
                                }
                                const grepResults = grepInEntries(hash, op.grep, op.limit || 5);
                                if (grepResults.length === 0) {
                                    result = `🔍 grep "${op.grep}" 无结果`;
                                } else {
                                    const parts = grepResults.map(r =>
                                        `  [${r.memoryId}] ${r.title} (L${r.lineNumber}): ${r.lineContent.trim()}`
                                    );
                                    result = `🔍 grep "${op.grep}" 找到 ${grepResults.length} 处:\n${parts.join("\n")}`;
                                }
                                successCount++;
                                break;
                            }

                            // fuse.js 搜索
                            if (op.query) {
                                let hash = "general";
                                if (opWorkspace !== "general") {
                                    hash = findWorkspaceHash(opWorkspace) || "general";
                                }
                                const wsIdx = hash === "general" ? readGeneralIndex() : readWorkspaceIndex(hash);
                                const searchResults = fuseSearch(wsIdx.entries, op.query, op.limit || 5);
                                if (searchResults.length === 0) {
                                    result = `🔍 "${op.query}" 无结果`;
                                } else {
                                    const parts = searchResults.map(r =>
                                        `  [${r.entry.id}] ${r.entry.title} (${(1 - r.score).toFixed(2)})`
                                    );
                                    result = `🔍 "${op.query}" 找到 ${searchResults.length} 条:\n${parts.join("\n")}`;
                                }
                                successCount++;
                                break;
                            }

                            result = `❌ query 需要 query 或 grep 参数`;
                            failCount++;
                            break;
                        }

                        case "update": {
                            if (!op.id) { result = `❌ update 缺少 id`; failCount++; break; }
                            const found = findMemoryById(op.id);
                            if (!found) { result = `❌ update: 不存在 ${op.id}`; failCount++; break; }

                            const content = readMemoryFile(found.hash, op.id);
                            if (!content) { result = `❌ update: 文件丢失 ${op.id}`; failCount++; break; }

                            const parsed = parseMemoryFile(content);
                            if (!parsed) { result = `❌ update: 格式异常 ${op.id}`; failCount++; break; }

                            let body = parsed.body;
                            if (op.content) body = op.content;
                            if (op.append) body += `\n\n---\n**追加于 ${new Date().toLocaleString("zh-CN")}**\n\n${op.append}`;

                            const fm = parsed.frontmatter;
                            if (op.title) fm.title = op.title;
                            if (op.searchSummary) fm.searchSummary = op.searchSummary;
                            if (op.tags) {
                                const existing = Array.isArray(fm.tags) ? fm.tags as string[] : [];
                                fm.tags = [...new Set([...existing, ...op.tags])];
                            }
                            if (op.pinned !== undefined) {
                                fm.pinned = op.pinned;
                            }
                            fm.updated = new Date().toISOString();

                            const newFm: MemoryFrontmatter = {
                                id: String(fm.id || op.id),
                                title: String(fm.title || found.entry.title),
                                tags: (Array.isArray(fm.tags) ? fm.tags : found.entry.tags) as string[],
                                category: String(fm.category || found.entry.category),
                                created: String(fm.created || found.entry.createdAt),
                                updated: String(fm.updated),
                                workspace: String(fm.workspace || "general"),
                                conversationId: fm.conversationId ? String(fm.conversationId) : undefined,
                                searchSummary: String(fm.searchSummary || found.entry.searchSummary),
                                pinned: fm.pinned !== undefined ? Boolean(fm.pinned) : found.entry.pinned,
                            };

                            const newContent = buildMemoryFile(newFm, body);
                            writeMemoryFile(found.hash, op.id, newContent);

                            const wsIdx = readWorkspaceIndex(found.hash);
                            const ie = wsIdx.entries.find(e => e.id === op.id);
                            if (ie) {
                                if (op.title) ie.title = op.title;
                                if (op.searchSummary) ie.searchSummary = op.searchSummary;
                                if (op.tags) ie.tags = [...new Set([...ie.tags, ...op.tags])];
                                if (op.pinned !== undefined) ie.pinned = op.pinned;
                                ie.updatedAt = String(fm.updated);
                                ie.sizeBytes = Buffer.byteLength(newContent, "utf-8");
                                ie.lineCount = countLines(newContent);
                            }
                            writeWorkspaceIndex(found.hash, wsIdx);
                            syncGlobalIndexForWorkspace(found.hash);

                            result = `✅ update: [${op.id}]`;
                            successCount++;
                            break;
                        }

                        default:
                            result = `❌ 不支持的 batch action: ${op.action}`;
                            failCount++;
                    }

                    results.push(`${i + 1}. ${result}`);
                } catch (error) {
                    results.push(`${i + 1}. ❌ ${op.action} 失败: ${error instanceof Error ? error.message : String(error)}`);
                    failCount++;
                }
            }

            return appendTiming({
                content: [{
                    type: "text" as const,
                    text: `📋 批量操作完成: ${successCount} 成功, ${failCount} 失败\n\n${results.join("\n")}`,
                }],
            }, startTime);
        }
    );
}

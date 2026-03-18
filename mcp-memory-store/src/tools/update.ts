import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    findMemoryById,
    readMemoryFile,
    writeMemoryFile,
    readWorkspaceIndex,
    writeWorkspaceIndex,
    syncGlobalIndexForWorkspace,
    parseMemoryFile,
    buildMemoryFile,
    countLines,
    readConfig,
    type MemoryFrontmatter,
} from "../store.js";
import { generateAutoSummary } from "../ls-client.js";

/**
 * memory_update — 更新/追加记忆
 * 支持 content 替换 / append 追加 / title/searchSummary/tags 更新
 */
export function registerUpdate(server: McpServer): void {
    server.tool(
        "memory_update",
        "更新已有记忆的内容、标题、标签、分类或搜索摘要。支持追加模式（append）。",
        {
            id: z.string().describe("记忆 ID"),
            content: z.string().optional().describe("替换全部正文"),
            append: z.string().optional().describe("追加到正文末尾（自动加时间戳分隔）"),
            title: z.string().optional().describe("更新标题"),
            searchSummary: z.string().optional().describe("更新搜索摘要"),
            tags: z.array(z.string()).optional().describe("新增标签（合并到已有，不覆盖）"),
            removeTags: z.array(z.string()).optional().describe("移除指定标签"),
            category: z.enum(["problem-solution", "technical-note", "conversation", "general"]).optional().describe("更新分类"),
            pinned: z.boolean().optional().describe("设置/取消置顶"),
        },
        async ({ id, content, append, title, searchSummary, tags, removeTags, category, pinned }) => {
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
                const fileContent = readMemoryFile(hash, id);
                if (!fileContent) {
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `❌ 记忆文件已丢失: ${id}`,
                        }],
                    }, startTime);
                }

                // 解析现有文件
                const parsed = parseMemoryFile(fileContent);
                if (!parsed) {
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `❌ 记忆文件格式异常，无法解析: ${id}`,
                        }],
                    }, startTime);
                }

                const fm = parsed.frontmatter;
                let body = parsed.body;
                const now = new Date().toISOString();
                const changes: string[] = [];

                // 检查大小（提前读取配置，避免双重调用 M7）
                const config = readConfig();

                if (content !== undefined) {
                    if (Buffer.byteLength(content, "utf-8") > config.maxEntrySize) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `❌ 内容过大（上限 ${(config.maxEntrySize / 1024).toFixed(1)} KB）`,
                            }],
                        }, startTime);
                    }
                    body = content;
                    changes.push("正文已替换");
                }

                // 追加正文
                if (append !== undefined) {
                    const conversationId = fm.conversationId || "";
                    const appendBlock = `\n\n---\n**追加于 ${new Date().toLocaleString("zh-CN")}**${conversationId ? ` (对话 ${String(conversationId).slice(0, 8)})` : ""}\n\n${append}`;
                    body = body + appendBlock;

                    // 检查追加后大小（复用已读取的 config）
                    if (Buffer.byteLength(body, "utf-8") > config.maxEntrySize) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `❌ 追加后内容过大（上限 ${(config.maxEntrySize / 1024).toFixed(1)} KB）`,
                            }],
                        }, startTime);
                    }
                    changes.push("已追加内容");
                }

                // 更新 frontmatter 字段
                if (title !== undefined) {
                    fm.title = title;
                    changes.push(`标题更新为: ${title}`);
                }
                if (searchSummary !== undefined) {
                    fm.searchSummary = searchSummary;
                    changes.push("搜索摘要已更新");
                }
                if (tags && tags.length > 0) {
                    const existingTags = Array.isArray(fm.tags) ? fm.tags as string[] : [];
                    const mergedTags = [...new Set([...existingTags, ...tags])];
                    fm.tags = mergedTags;
                    changes.push(`标签新增: [${tags.join(", ")}]`);
                }
                if (removeTags && removeTags.length > 0) {
                    const existingTags = Array.isArray(fm.tags) ? fm.tags as string[] : [];
                    fm.tags = existingTags.filter(t => !removeTags.includes(t));
                    changes.push(`标签移除: [${removeTags.join(", ")}]`);
                }
                if (category !== undefined) {
                    fm.category = category;
                    changes.push(`分类更新为: ${category}`);
                }
                if (pinned !== undefined) {
                    fm.pinned = pinned;
                    changes.push(pinned ? "📌 已置顶" : "已取消置顶");
                }

                fm.updated = now;

                // 重建文件
                const contentChanged = (content !== undefined) || (append !== undefined);
                const newFrontmatter: MemoryFrontmatter = {
                    id: String(fm.id || id),
                    title: String(fm.title || entry.title),
                    tags: (Array.isArray(fm.tags) ? fm.tags : entry.tags) as string[],
                    category: String(fm.category || entry.category),
                    created: String(fm.created || entry.createdAt),
                    updated: now,
                    workspace: String(fm.workspace || "general"),
                    conversationId: fm.conversationId ? String(fm.conversationId) : undefined,
                    searchSummary: String(fm.searchSummary || entry.searchSummary),
                    autoSummary: contentChanged ? undefined : (fm.autoSummary ? String(fm.autoSummary) : entry.autoSummary),
                    pinned: fm.pinned !== undefined ? Boolean(fm.pinned) : entry.pinned,
                };

                const newContent = buildMemoryFile(newFrontmatter, body);
                writeMemoryFile(hash, id, newContent);

                // 更新索引
                const wsIndex = readWorkspaceIndex(hash);
                const indexEntry = wsIndex.entries.find(e => e.id === id);
                if (indexEntry) {
                    if (title !== undefined) indexEntry.title = title;
                    if (searchSummary !== undefined) indexEntry.searchSummary = searchSummary;
                    if (tags !== undefined) indexEntry.tags = [...new Set([...indexEntry.tags, ...tags])];
                    if (removeTags !== undefined) indexEntry.tags = indexEntry.tags.filter(t => !removeTags.includes(t));
                    if (category !== undefined) indexEntry.category = category;
                    if (pinned !== undefined) indexEntry.pinned = pinned;
                    indexEntry.updatedAt = now;
                    indexEntry.lastAccessed = now;
                    indexEntry.sizeBytes = Buffer.byteLength(newContent, "utf-8");
                    indexEntry.lineCount = countLines(newContent);
                }
                writeWorkspaceIndex(hash, wsIndex);
                syncGlobalIndexForWorkspace(hash);

                // v1.5: 内容变化时重新生成 autoSummary
                if (contentChanged) {
                    changes.push("🤖 autoSummary 正在后台重新生成...");
                    triggerAutoSummaryUpdate(hash, id, newFrontmatter.title, (Array.isArray(newFrontmatter.tags) ? newFrontmatter.tags : []) as string[], body).catch(() => {});
                }

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `✅ 记忆已更新: [${id}] "${newFrontmatter.title}"\n${changes.join("\n")}`,
                    }],
                }, startTime);
            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `❌ 更新失败: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                }, startTime);
            }
        }
    );
}

/**
 * 异步触发 autoSummary 重新生成（update 内容变化后）
 */
async function triggerAutoSummaryUpdate(
    hash: string,
    memoryId: string,
    title: string,
    tags: string[],
    body: string
): Promise<void> {
    try {
        const summary = await generateAutoSummary(title, tags, body);
        if (!summary) return;

        // 读取当前文件并重建
        const fileContent = readMemoryFile(hash, memoryId);
        if (!fileContent) return;

        const parsed = parseMemoryFile(fileContent);
        if (!parsed) return;

        const fm = parsed.frontmatter;
        const newFrontmatter: MemoryFrontmatter = {
            id: String(fm.id || memoryId),
            title: String(fm.title || title),
            tags: (Array.isArray(fm.tags) ? fm.tags : tags) as string[],
            category: String(fm.category || "general"),
            created: String(fm.created || new Date().toISOString()),
            updated: String(fm.updated || new Date().toISOString()),
            workspace: String(fm.workspace || "general"),
            conversationId: fm.conversationId ? String(fm.conversationId) : undefined,
            searchSummary: String(fm.searchSummary || ""),
            autoSummary: summary,
            pinned: fm.pinned === true ? true : undefined,
        };

        const newContent = buildMemoryFile(newFrontmatter, parsed.body);
        writeMemoryFile(hash, memoryId, newContent);

        // 更新索引
        const wsIndex = readWorkspaceIndex(hash);
        const indexEntry = wsIndex.entries.find(e => e.id === memoryId);
        if (indexEntry) {
            indexEntry.autoSummary = summary;
            indexEntry.sizeBytes = Buffer.byteLength(newContent, "utf-8");
            writeWorkspaceIndex(hash, wsIndex);
        }

        console.error(`[memory-store] ✅ autoSummary 已重新生成: ${memoryId} (${summary.length}字)`);
    } catch (err) {
        console.error(`[memory-store] autoSummary 重新生成失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}

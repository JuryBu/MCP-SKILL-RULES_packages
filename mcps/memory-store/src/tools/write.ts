import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    ensureWorkspace,
    generateMemoryId,
    buildMemoryFile,
    writeMemoryFile,
    mutateWorkspaceIndex,
    syncGlobalIndexForWorkspace,
    countLines,
    readConfig,
    type MemoryFrontmatter,
} from "../store.js";
import { type MemoryIndexEntry } from "../cache.js";
import { checkDuplicates } from "../search.js";
import {
    captureAutoSummarySnapshot,
    generateAutoSummary,
    writeAutoSummaryIfUnchanged,
    type AutoSummarySnapshot,
} from "../auto-summary.js";
import { resolveModelOnlyChainSplit, type Chain } from "../chain.js";
import { formatToolError } from "../error-format.js";
import { modelChainInputSchema } from "./schema-utils.js";

/**
 * memory_write — 写入新记忆
 * 自动检测相似记忆并提醒（不阻止写入）
 * v1.5: 写入后异步调用 Flash 生成 autoSummary
 */
export function registerWrite(server: McpServer): void {
    server.tool(
        "memory_write",
        "写入一条新的记忆。自动检测当前工作区下是否有相似记忆并提醒。searchSummary 可选（v1.5+），系统会自动用 Flash 生成 autoSummary 补充。",
        {
            title: z.string().describe("简短标题（建议 < 50 字）"),
            content: z.string().describe("markdown 格式正文（上限 15KB）"),
            searchSummary: z.string().optional().describe("AI 撰写的搜索优化摘要（可选，Flash 会自动生成 autoSummary 补充）"),
            tags: z.array(z.string()).describe("标签数组"),
            workspace: z.string().optional().describe("工作区路径，不传使用 general"),
            category: z.enum(["problem-solution", "technical-note", "conversation", "general"]).optional().describe("分类，默认 general"),
            conversationId: z.string().optional().describe("来源对话 ID"),
            pinned: z.boolean().optional().describe("是否置顶（每个工作区/general 建议最多 3 条）"),
            modelChain: modelChainInputSchema("modelChain", "autoSummary 模型链路；未填回退到 chain，再默认 auto"),
            chain: modelChainInputSchema("chain", "兼容旧参数：autoSummary 模型链路，modelChain 未填时使用"),
        },
        async ({ title, content, searchSummary, tags, workspace, category, conversationId, pinned, chain, modelChain }) => {
            touchActivity();
            const startTime = Date.now();

            try {
                // 内容大小检查
                const config = readConfig();
                const contentSize = Buffer.byteLength(content, "utf-8");
                if (contentSize > config.maxEntrySize) {
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `❌ 内容过大: ${(contentSize / 1024).toFixed(1)} KB（上限 ${(config.maxEntrySize / 1024).toFixed(1)} KB）\n请精简内容后重试。`,
                        }],
                    }, startTime);
                }

                // 确定目标工作区
                const wsPath = workspace || "general";
                let hash: string;

                if (wsPath === "general") {
                    hash = "general";
                } else {
                    const ws = ensureWorkspace(wsPath);
                    hash = ws.hash;
                }

                // 生成 ID
                const id = generateMemoryId(title);

                // 构建 frontmatter（searchSummary 默认空字符串）
                const now = new Date().toISOString();
                const actualSearchSummary = searchSummary || "";
                const frontmatter: MemoryFrontmatter = {
                    id,
                    title,
                    tags,
                    category: category || "general",
                    created: now,
                    updated: now,
                    workspace: wsPath,
                    conversationId,
                    searchSummary: actualSearchSummary,
                    pinned,
                };

                // 构建并写入文件
                const fileContent = buildMemoryFile(frontmatter, content);
                writeMemoryFile(hash, id, fileContent);
                const autoSummarySnapshot = captureAutoSummarySnapshot({
                    title: frontmatter.title,
                    tags: frontmatter.tags,
                    updated: frontmatter.updated,
                    body: content,
                });

                // 更新索引（串行化读改写，防并发丢条目）
                const indexEntry: MemoryIndexEntry = {
                    id,
                    title,
                    searchSummary: actualSearchSummary,
                    tags,
                    category: category || "general",
                    createdAt: now,
                    updatedAt: now,
                    lastAccessed: now,
                    sizeBytes: Buffer.byteLength(fileContent, "utf-8"),
                    lineCount: countLines(fileContent),
                    conversationId,
                    pinned,
                };
                let existingEntries: MemoryIndexEntry[] = [];
                await mutateWorkspaceIndex(hash, (wsIndex) => {
                    wsIndex.entries.push(indexEntry);
                    existingEntries = wsIndex.entries.filter(e => e.id !== id); // 去重检测基线
                });

                // 同步全局索引（在 per-hash 锁外、用独立全局锁串行化，避免锁嵌套死锁）
                await syncGlobalIndexForWorkspace(hash);

                // 去重检测
                let dedupWarning = "";
                const duplicates = checkDuplicates(existingEntries, title, actualSearchSummary);
                if (duplicates.length > 0) {
                    dedupWarning = "\n\n⚠️ 发现相似记忆：\n" +
                        duplicates.slice(0, 3).map(d =>
                            `- [${d.entry.id}] "${d.entry.title}" (相似度: ${d.score.toFixed(2)})\n  如需合并请用 memory_update(id="${d.entry.id}", append="...")`
                        ).join("\n");
                }

                const wsName = wsPath === "general" ? "通用记忆" : `${path.basename(wsPath)} (${hash})`;
                const pinnedMark = pinned ? " 📌" : "";
                const searchSummaryNote = actualSearchSummary ? "" : "\n🤖 autoSummary 正在后台生成...";

                // v1.5: 异步生成 autoSummary（不阻塞返回）
                triggerAutoSummary(hash, id, autoSummarySnapshot, resolveModelOnlyChainSplit({ chain, modelChain }).modelChain).catch(() => {});

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `✅ 记忆已保存${pinnedMark}\nID: ${id}\n标题: ${title}\n工作区: ${wsName}\n大小: ${(contentSize / 1024).toFixed(1)} KB | ${indexEntry.lineCount} 行${searchSummaryNote}${dedupWarning}`,
                    }],
                }, startTime);
            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: formatToolError("memory_write", error, { workspace, category }),
                    }],
                }, startTime);
            }
        }
    );
}

/**
 * 异步触发 autoSummary 生成（写入后台火并忘）
 * 成功后更新记忆文件和索引
 */
async function triggerAutoSummary(
    hash: string,
    memoryId: string,
    snapshot: AutoSummarySnapshot,
    chain: Chain
): Promise<void> {
    try {
        const summary = await generateAutoSummary(snapshot.title, snapshot.tags, snapshot.body, chain);
        if (!summary) return; // LS 不可用，静默跳过

        const result = await writeAutoSummaryIfUnchanged({
            hash,
            memoryId,
            summary,
            expectedFingerprint: snapshot.fingerprint,
            fallbackTitle: snapshot.title,
            fallbackTags: snapshot.tags,
        });
        if (result === "written") {
            console.error(`[memory-store] ✅ autoSummary 已生成: ${memoryId} (${summary.length}字)`);
            return;
        }

        if (result !== "existing") {
            console.error(`[memory-store] autoSummary 已跳过: ${memoryId} (${result})`);
        }
    } catch (err) {
        console.error(`[memory-store] autoSummary 生成失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}


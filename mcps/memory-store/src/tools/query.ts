import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "path";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    readGlobalIndex,
    readWorkspaceIndex,
    readGeneralIndex,
    readMemoryFile,
    readWorkspaceMeta,
    findWorkspaceHash,
    listWorkspaceHashes,
    type GlobalIndex,
} from "../store.js";
import { indexCache, type MemoryIndexEntry } from "../cache.js";
import { saveTempFile } from "../temp-store.js";
import { fuseSearch, grepInEntries, grepGlobal } from "../search.js";
import { countRecords } from "../record-store.js";
import { resolveModelOnlyChainSplit } from "../chain.js";
import { formatToolError } from "../error-format.js";
import type { SearchMode } from "../search-engine.js";
import { modelChainInputSchema } from "./schema-utils.js";

/** 携带来源 hash 的条目（用于全局查询） */
interface EntryWithSource extends MemoryIndexEntry {
    _sourceHash?: string;
}

/** 搜索时每条记忆正文截断上限（字符），控内存与 token 成本 */
const BODY_SNIPPET_LIMIT = 3000;

/**
 * memory_query — 查询记忆
 * 支持三档深度控制、标签过滤、全文搜索
 * 无参调用返回当前工作区概览
 */
export function registerQuery(server: McpServer): void {
    server.tool(
        "memory_query",
        "查询记忆。支持三档深度控制、标签过滤、全文搜索、时间范围过滤。无参调用返回当前工作区概览。",
        {
            query: z.string().optional().describe("自然语言查询（搜索 title + searchSummary + tags）"),
            grep: z.string().optional().describe("正文全文搜索（精确匹配，类似 grep）"),
            scope: z.enum(["workspace", "global"]).optional().describe("搜索范围：workspace（默认）/ global"),
            workspace: z.string().optional().describe("工作区路径"),
            depth: z.enum(["index", "summary", "full"]).optional().describe("返回深度：index（默认）/ summary / full"),
            mode: z.enum(["auto", "exact", "fuzzy", "smart"]).optional().describe("query 搜索模式：auto/exact/fuzzy/smart，默认 auto"),
            modelChain: modelChainInputSchema("modelChain", "smart 搜索使用的模型链路；未填回退到 chain，再默认 auto"),
            chain: modelChainInputSchema("chain", "兼容旧参数：smart 搜索使用的模型链路，modelChain 未填时使用"),
            tags: z.array(z.string()).optional().describe("按标签过滤"),
            category: z.string().optional().describe("按类别过滤"),
            after: z.string().optional().describe("时间过滤：只返回此时间之后更新的记忆（ISO格式或 YYYY-MM-DD）"),
            before: z.string().optional().describe("时间过滤：只返回此时间之前更新的记忆（ISO格式或 YYYY-MM-DD）"),
            limit: z.number().optional().describe("返回条数，默认 10"),
        },
        async ({ query, grep, scope, workspace, depth, mode, chain, modelChain, tags, category, after, before, limit }) => {
            touchActivity();
            const startTime = Date.now();

            try {
                const depthMode = depth || "index";
                const maxResults = limit || 10;
                const searchScope = scope || "workspace";
                const chains = resolveModelOnlyChainSplit({ chain, modelChain });

                // grep 模式
                if (grep) {
                    return handleGrep(grep, searchScope, workspace, maxResults);
                }

                // 确定工作区
                const wsPath = workspace || "general";
                let hash: string;

                // scope=global 且无 query/grep/filter/时间 → 全局概览
                if (searchScope === "global" && !query && !tags && !category && !after && !before) {
                    return appendTiming(handleGlobalOverview(), startTime);
                }

                if (wsPath === "general") {
                    hash = "general";
                } else {
                    const found = findWorkspaceHash(wsPath);
                    if (!found) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: `❌ 工作区不存在: ${wsPath}\n使用 memory_query(scope="global") 查看所有工作区`,
                            }],
                        };
                    }
                    hash = found;
                }

                // 无参调用 → 当前工作区概览（但有时间过滤时不走概览）
                if (!query && !tags && !category && !after && !before) {
                    return appendTiming(handleOverview(hash, wsPath), startTime);
                }

                // 有 query → 搜索
                let entries: MemoryIndexEntry[];
                if (searchScope === "global") {
                    entries = getAllEntries();
                } else {
                    const wsIndex = hash === "general" ? readGeneralIndex() : readWorkspaceIndex(hash);
                    entries = wsIndex.entries;
                }

                // 应用过滤
                if (tags && tags.length > 0) {
                    entries = entries.filter(e =>
                        tags.some(t => e.tags.includes(t))
                    );
                }
                if (category) {
                    entries = entries.filter(e => e.category === category);
                }

                // 时间范围过滤
                if (after) {
                    const afterTime = new Date(after).getTime();
                    entries = entries.filter(e => new Date(e.updatedAt).getTime() >= afterTime);
                }
                if (before) {
                    const beforeTime = new Date(before).getTime();
                    entries = entries.filter(e => new Date(e.updatedAt).getTime() <= beforeTime);
                }

                // 搜索
                let results: Array<{ entry: MemoryIndexEntry; score?: number }>;
                if (query) {
                    const requestedMode = (mode || "auto") as SearchMode;
                    if (requestedMode === "auto" && entries.length > 0) {
                        const { search: engineSearch } = await import("../search-engine.js");
                        const blocks = entries.map(e => {
                            const srcHash = (e as EntryWithSource)._sourceHash || hash;
                            const body = (readMemoryFile(srcHash, e.id) || "").slice(0, BODY_SNIPPET_LIMIT);
                            return {
                                id: e.id,
                                title: e.title,
                                content: `${e.title}\n${e.searchSummary || ""}\n${(e as any).autoSummary || ""}\n${e.tags.join(" ")}\n${body}`,
                                tags: e.tags,
                                metadata: { updatedAt: e.updatedAt }, // B2: smart 缓存指纹含版本，防脏读
                            };
                        });
                        let engineResults = await engineSearch(blocks, query, {
                            mode: "auto",
                            limit: maxResults,
                            modelChain: chains.modelChain,
                        });
                        if (engineResults.length === 0) {
                            engineResults = await engineSearch(blocks, query, {
                                mode: "smart",
                                limit: maxResults,
                                modelChain: chains.modelChain,
                            });
                        }
                        results = engineResults.map(sr => ({
                            entry: entries.find(e => e.id === sr.id)!,
                            score: sr.score,
                        })).filter(r => r.entry);
                    } else if (entries.length > 0) {
                        try {
                            const { search: engineSearch } = await import("../search-engine.js");
                            const blocks = entries.map(e => {
                                const srcHash = (e as EntryWithSource)._sourceHash || hash;
                                const body = (readMemoryFile(srcHash, e.id) || "").slice(0, BODY_SNIPPET_LIMIT);
                                return {
                                    id: e.id,
                                    title: e.title,
                                    content: `${e.title}\n${e.searchSummary || ""}\n${(e as any).autoSummary || ""}\n${e.tags.join(" ")}\n${body}`,
                                    tags: e.tags,
                                    metadata: { updatedAt: e.updatedAt }, // B2: smart 缓存指纹含版本，防脏读
                                };
                            });
                            const engineResults = await engineSearch(blocks, query, {
                                mode: requestedMode,
                                limit: maxResults,
                                modelChain: chains.modelChain,
                            });
                            results = engineResults.map(sr => ({
                                entry: entries.find(e => e.id === sr.id)!,
                                score: sr.score,
                            })).filter(r => r.entry);
                        } catch {
                            results = fuseSearch(entries, query, maxResults);
                        }
                    } else {
                        results = [];
                    }
                } else {
                    // 无 query 但有 filter → 按时间排序
                    results = entries
                        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                        .slice(0, maxResults)
                        .map(e => ({ entry: e }));
                }

                // 格式化输出
                return appendTiming(formatResults(results, depthMode, hash, searchScope === "global"), startTime);
            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: formatToolError("memory_query", error, { query, scope, workspace, mode, limit }),
                    }],
                }, startTime);
            }
        }
    );
}

// === 概览模式 ===
function handleOverview(hash: string, wsPath: string) {
    const wsIndex = hash === "general" ? readGeneralIndex() : readWorkspaceIndex(hash);
    const globalIndex = readGlobalIndex();

    const count = wsIndex.entries.length;
    const isHot = indexCache.has(hash);

    // 工作区名称
    const wsName = wsPath === "general"
        ? "通用记忆 (general)"
        : `${path.basename(wsPath)} (${hash})`;

    // 标签统计
    const tagCount = new Map<string, number>();
    for (const entry of wsIndex.entries) {
        for (const tag of entry.tags) {
            tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
        }
    }
    const topTags = Array.from(tagCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([tag, n]) => `${tag}(${n})`)
        .join("  ");

    // 分离 pinned 和 normal
    const pinnedEntries = wsIndex.entries
        .filter(e => e.pinned === true)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const normalEntries = wsIndex.entries
        .filter(e => !e.pinned)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    // 条数分配：pinned 最多 3 条，总上限 10 条
    const MAX_PINNED = 3;
    const MAX_TOTAL = 10;
    const displayPinned = pinnedEntries.slice(0, MAX_PINNED);
    const displayNormal = normalEntries.slice(0, MAX_TOTAL - displayPinned.length);

    // 构建输出
    const recordCount = countRecords(hash);
    const recordHint = recordCount > 0 ? `, ${recordCount} 份对话记录` : "";
    let body = `📚 工作区: ${wsName} (${count} 条记忆${recordHint})\n` +
        `状态: ${isHot ? "🔥已缓存" : "📦未缓存"}\n` +
        (topTags ? `热门标签: ${topTags}\n` : "");

    // 📌 置顶记忆区域
    if (displayPinned.length > 0) {
        const pinnedList = displayPinned.map((e, i) =>
            `  ${i + 1}. [${e.id}] ${e.title} [${e.tags.join(",")}]`
        ).join("\n");
        body += `\n📌 置顶记忆 (${displayPinned.length} 条):\n${pinnedList}\n`;
    }

    // 🕐 最近记忆区域
    const recentList = displayNormal.map((e, i) =>
        `  ${i + 1}. [${e.id}] ${e.title} [${e.tags.join(",")}]`
    ).join("\n");
    body += `\n🕐 最近 ${displayNormal.length} 条:\n${recentList || "  (暂无记忆)"}\n`;

    // 全局统计
    const wsCount = Object.keys(globalIndex.workspaces).length;
    const totalMemories = Object.values(globalIndex.workspaces).reduce((sum, ws) => sum + ws.memoryCount, 0) + globalIndex.generalCount;
    body += `\n—\n全局统计: ${wsCount} 个工作区, 共 ${totalMemories} 条记忆\n`;

    // 跨域推荐（仅当不在 general 时）
    if (hash !== "general") {
        const generalIndex = readGeneralIndex();
        const generalPinnedCount = generalIndex.entries.filter(e => e.pinned === true).length;
        if (generalPinnedCount > 0) {
            body += `\n💡 general 有 ${generalPinnedCount} 条置顶记忆，用 scope=global 查看`;
        }
    }

    body += `\n💡 可用参数: query(模糊搜索) | grep(正文精确搜索) | depth=summary/full | scope=global | tags=[] | category | after/before(时间过滤)`;

    return {
        content: [{ type: "text" as const, text: body }],
    };
}

// === 全局概览模式（scope=global 无参调用）===
function handleGlobalOverview() {
    const globalIndex = readGlobalIndex();
    const generalIndex = readGeneralIndex();

    const wsCount = Object.keys(globalIndex.workspaces).length;
    const totalMemories = Object.values(globalIndex.workspaces).reduce((sum, ws) => sum + ws.memoryCount, 0) + generalIndex.entries.length;

    const lines: string[] = [];
    lines.push(`📊 全局记忆概览: ${wsCount} 个工作区, ${totalMemories} 条记忆\n`);

    // 通用记忆
    if (generalIndex.entries.length > 0) {
        const generalPinned = generalIndex.entries.filter(e => e.pinned === true).length;
        const pinnedHint = generalPinned > 0 ? ` (📌${generalPinned})` : "";
        lines.push(`  📁 通用记忆 (general): ${generalIndex.entries.length} 条${pinnedHint}`);
    }

    // 各工作区
    const hashes = listWorkspaceHashes();
    for (const hash of hashes) {
        const meta = readWorkspaceMeta(hash);
        const wsIndex = readWorkspaceIndex(hash);
        const isHot = indexCache.has(hash);
        const wsName = meta?.originalPath ? path.basename(meta.originalPath) : hash;
        const pinnedCount = wsIndex.entries.filter(e => e.pinned === true).length;
        const pinnedHint = pinnedCount > 0 ? ` (📌${pinnedCount})` : "";

        lines.push(`  📁 ${wsName} (${hash}): ${wsIndex.entries.length} 条${pinnedHint} ${isHot ? "🔥" : "📦"}`);
    }

    lines.push(`\n💡 用 memory_query(workspace="路径") 查看特定工作区详情`);

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

// === grep 模式 ===
function handleGrep(pattern: string, scope: string, workspace: string | undefined, limit: number) {
    if (scope === "global") {
        const allResults = grepGlobal(pattern, limit);
        if (allResults.length === 0) {
            return {
                content: [{ type: "text" as const, text: `🔍 全局搜索 "${pattern}" 无结果` }],
            };
        }

        let totalMatches = 0;
        const parts: string[] = [];

        for (const { hash, results } of allResults) {
            totalMatches += results.length;
            for (const r of results) {
                parts.push(`[${r.memoryId}] ${r.title} (第 ${r.lineNumber} 行)\n  > ${r.lineContent.trim()}`);
            }
        }

        return {
            content: [{
                type: "text" as const,
                text: `🔍 全局搜索 "${pattern}" 找到 ${totalMatches} 处匹配:\n\n${parts.join("\n\n")}`,
            }],
        };
    }

    // 工作区内 grep
    const wsPath = workspace || "general";
    let hash: string;
    if (wsPath === "general") {
        hash = "general";
    } else {
        const found = findWorkspaceHash(wsPath);
        if (!found) {
            return {
                content: [{ type: "text" as const, text: `❌ 工作区不存在: ${wsPath}` }],
            };
        }
        hash = found;
    }

    const results = grepInEntries(hash, pattern, limit);
    if (results.length === 0) {
        return {
            content: [{ type: "text" as const, text: `🔍 在工作区中搜索 "${pattern}" 无结果\n💡 可用 scope="global" 搜索全局记忆` }],
        };
    }

    const parts = results.map(r =>
        `[${r.memoryId}] ${r.title} (第 ${r.lineNumber} 行)\n  > ${r.lineContent.trim()}`
    );

    return {
        content: [{
            type: "text" as const,
            text: `🔍 在 ${results.length} 处找到 "${pattern}":\n\n${parts.join("\n\n")}`,
        }],
    };
}

// === 格式化结果 ===
function formatResults(
    results: Array<{ entry: EntryWithSource; score?: number }>,
    depth: string,
    hash: string,
    isGlobal: boolean = false
) {
    if (results.length === 0) {
        const hint = isGlobal ? '' : '\n💡 可用 scope="global" 搜索全局记忆';
        return {
            content: [{ type: "text" as const, text: `🔍 未找到匹配的记忆${hint}` }],
        };
    }

    if (depth === "full") {
        // full 模式：写临时文件
        const parts: string[] = [];
        for (const { entry } of results) {
            const sourceHash = (entry as EntryWithSource)._sourceHash || hash;
            const content = readMemoryFile(sourceHash, entry.id);
            if (content) {
                parts.push(`# ${entry.title}\nID: ${entry.id}\n\n${content}\n`);
            }
        }

        const fullContent = parts.join("\n---\n\n");
        const tempPath = saveTempFile("query", `${results.length}条`, fullContent);

        return {
            content: [{
                type: "text" as const,
                text: `📄 ${results.length} 条记忆已导出到临时文件\n路径: ${tempPath}\n用 view_file 读取即可`,
            }],
        };
    }

    // index / summary 模式
    const lines = results.map((r, i) => {
        const e = r.entry;
        const scoreStr = r.score !== undefined ? ` (匹配: ${Math.min(1, Math.max(0, r.score)).toFixed(2)})` : "";

        if (depth === "summary") {
            const catStr = e.category ? ` | ${e.category}` : "";
            const dateStr = e.updatedAt ? ` | ${e.updatedAt.slice(0, 10)}` : "";
            return `${i + 1}. [${e.id}] ${e.title}${scoreStr}\n` +
                `   标签: [${e.tags.join(", ")}]${catStr}${dateStr} | ${e.lineCount}行 | ${(e.sizeBytes / 1024).toFixed(1)}KB`;
        }

        // index 模式（默认）
        return `${i + 1}. [${e.id}] ${e.title} [${e.tags.join(",")}]${scoreStr}`;
    });

    return {
        content: [{
            type: "text" as const,
            text: `🔍 找到 ${results.length} 条记忆:\n\n${lines.join("\n")}`,
        }],
    };
}

// === 获取所有工作区的条目 ===
function getAllEntries(): EntryWithSource[] {
    const all: EntryWithSource[] = [];

    // general
    const generalIndex = readGeneralIndex();
    for (const e of generalIndex.entries) {
        all.push({ ...e, _sourceHash: "general" });
    }

    // 各工作区
    const hashes = listWorkspaceHashes();
    for (const hash of hashes) {
        const wsIndex = readWorkspaceIndex(hash);
        for (const e of wsIndex.entries) {
            all.push({ ...e, _sourceHash: hash });
        }
    }

    return all;
}

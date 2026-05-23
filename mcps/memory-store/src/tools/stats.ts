import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import { gzipSync, gunzipSync } from "zlib";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    DATA_ROOT,
    WORKSPACES_DIR,
    GENERAL_DIR,
    readGlobalIndex,
    writeGlobalIndex,
    readWorkspaceIndex,
    writeWorkspaceIndex,
    readWorkspaceMeta,
    writeWorkspaceMeta,
    listWorkspaceHashes,
    syncGlobalIndexForWorkspace,
    workspaceHash,
    parseMemoryFile,
    ensureDataDirs,
    writeJsonAtomic,
    buildMemoryFile,
} from "../store.js";
import { indexCache } from "../cache.js";
import { cleanOldTempFiles, TEMP_DIR } from "../temp-store.js";
import { generateAutoSummary } from "../auto-summary.js";
import { CHAIN_INPUT_VALUES, resolveChainSplit, type Chain } from "../chain.js";

/**
 * 校验导入/解归档的文件名是否安全（防路径遍历攻击）
 * - 不允许 .. / \ 路径分隔符
 * - 只允许 .md 扩展名
 * - resolve 后必须仍在目标目录内
 */
function isSafeFilename(entriesDir: string, filename: string): boolean {
    // 层1: 黑名单字符检查
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
    if (!filename.endsWith('.md')) return false;
    // 层2: resolve 后确认仍在目标目录内（防止未知编码绕过）
    const resolved = path.resolve(entriesDir, filename);
    const normalizedDir = path.resolve(entriesDir) + path.sep;
    return resolved.startsWith(normalizedDir);
}

/**
 * memory_stats — 统计和管理
 * overview / detail / gc / archive / unarchive / export / import
 */
export function registerStats(server: McpServer): void {
    server.tool(
        "memory_stats",
        "查看记忆系统统计信息，管理冷热归档，导出/导入记忆。",
        {
            action: z.enum(["overview", "detail", "gc", "archive", "unarchive", "export", "import", "enhance"]).optional()
                .describe("操作类型，默认 overview。enhance: 批量为缺少 autoSummary 的记忆生成摘要"),
            workspace: z.string().optional().describe("指定工作区（detail/archive/unarchive/export/enhance 时使用）"),
            ids: z.array(z.string()).optional().describe("指定记忆 ID 列表（export 时使用）"),
            savePath: z.string().optional().describe("导出文件保存路径（export 时必须）"),
            zipPath: z.string().optional().describe("导入文件路径（import 时必须）"),
            modelChain: z.enum(CHAIN_INPUT_VALUES).optional().describe("enhance 生成 autoSummary 时使用的模型链路；未填回退到 chain，再默认 auto"),
            chain: z.enum(CHAIN_INPUT_VALUES).optional().describe("兼容旧参数：enhance 生成 autoSummary 时使用的模型链路"),
        },
        async ({ action, workspace, ids, savePath, zipPath, chain, modelChain }) => {
            touchActivity();
            const startTime = Date.now();

            try {
                switch (action || "overview") {
                    case "overview":
                        return appendTiming(handleOverview(), startTime);
                    case "detail":
                        return appendTiming(handleDetail(workspace), startTime);
                    case "gc":
                        return appendTiming(handleGc(), startTime);
                    case "archive":
                        return appendTiming(handleArchive(workspace), startTime);
                    case "unarchive":
                        return appendTiming(handleUnarchive(workspace), startTime);
                    case "export":
                        return appendTiming(handleExport(workspace, ids, savePath), startTime);
                    case "import":
                        return appendTiming(handleImport(zipPath), startTime);
                    case "enhance":
                        return appendTiming(await handleEnhance(workspace, resolveChainSplit({ chain, modelChain }).modelChain), startTime);
                    default:
                        return appendTiming({ content: [{ type: "text" as const, text: `❌ 未知 action` }] }, startTime);
                }
            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `❌ stats 操作失败: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                }, startTime);
            }
        }
    );
}

// === overview ===
function handleOverview() {
    const globalIndex = readGlobalIndex();
    const cacheStats = indexCache.getStats();

    const wsEntries = Object.entries(globalIndex.workspaces);
    const totalMemories = wsEntries.reduce((sum, [, ws]) => sum + ws.memoryCount, 0) + globalIndex.generalCount;
    const totalSize = wsEntries.reduce((sum, [, ws]) => sum + ws.totalSizeBytes, 0);

    let wsLines = "";
    if (wsEntries.length > 0) {
        wsLines = wsEntries
            .sort((a, b) => new Date(b[1].lastAccessed).getTime() - new Date(a[1].lastAccessed).getTime())
            .map(([hash, ws]) => {
                const isHot = cacheStats.keys.includes(hash);
                const isArchived = ws.isArchived;
                const sizeStr = ws.totalSizeBytes > 1024
                    ? `${(ws.totalSizeBytes / 1024).toFixed(0)} KB`
                    : `${ws.totalSizeBytes} B`;
                const ageStr = getRelativeTime(ws.lastAccessed);
                const status = isArchived ? "📦已归档" : (isHot ? "🔥已缓存" : "📦未缓存");
                return `  ${ws.name.padEnd(20)} | ${String(ws.memoryCount).padStart(3)} 条 | ${sizeStr.padStart(8)} | ${status} | 最近: ${ageStr}`;
            })
            .join("\n");
    }

    // 临时文件统计
    let tempCount = 0;
    let tempSize = 0;
    if (fs.existsSync(TEMP_DIR)) {
        const tempFiles = fs.readdirSync(TEMP_DIR);
        tempCount = tempFiles.length;
        for (const f of tempFiles) {
            try { tempSize += fs.statSync(path.join(TEMP_DIR, f)).size; } catch { }
        }
    }

    const text = `📊 记忆系统统计\n\n` +
        `全局: ${wsEntries.length} 个工作区, ${totalMemories} 条记忆, ${(totalSize / 1024).toFixed(1)} KB\n` +
        `LRU 缓存: ${cacheStats.size}/${cacheStats.maxSize} 热\n\n` +
        `工作区列表:\n${wsLines || "  (暂无工作区)"}\n\n` +
        `通用记忆: ${globalIndex.generalCount} 条\n` +
        `临时文件: ${tempCount} 个 | ${(tempSize / 1024).toFixed(1)} KB`;

    return { content: [{ type: "text" as const, text }] };
}

// === detail ===
function handleDetail(workspace?: string) {
    if (!workspace) {
        return { content: [{ type: "text" as const, text: "❌ detail 需要指定 workspace" }] };
    }

    const hash = workspaceHash(workspace);
    const meta = readWorkspaceMeta(hash);
    if (!meta) {
        return { content: [{ type: "text" as const, text: `❌ 工作区不存在: ${workspace}` }] };
    }

    const wsIndex = readWorkspaceIndex(hash);

    const entries = wsIndex.entries
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .map((e, i) => `  ${i + 1}. [${e.id}] ${e.title} [${e.tags.join(",")}] ${(e.sizeBytes / 1024).toFixed(1)}KB | ${e.updatedAt.slice(0, 10)}`)
        .join("\n");

    return {
        content: [{
            type: "text" as const,
            text: `📚 工作区详情: ${meta.name} (${hash})\n` +
                `原始路径: ${meta.originalPath}\n` +
                `创建时间: ${meta.createdAt}\n` +
                `最后访问: ${meta.lastAccessed}\n` +
                `归档状态: ${meta.isArchived ? "📦已归档" : "活跃"}\n` +
                `记忆数量: ${wsIndex.entries.length}\n\n` +
                `所有记忆:\n${entries || "  (暂无)"}`,
        }],
    };
}

// === gc ===
function handleGc() {
    // 清理临时文件
    cleanOldTempFiles();

    // 卸载冷索引缓存
    const before = indexCache.getStats().size;
    indexCache.clear();
    const cleared = before;

    let text = `🧹 GC 完成\n已清理临时文件 + 卸载 ${cleared} 个索引缓存`;

    // === 孤儿工作区检测 ===
    const orphans: Array<{
        hash: string;
        name: string;
        originalPath: string;
        memoryCount: number;
        sizeKB: number;
        lastAccessed: string;
    }> = [];

    const hashes = listWorkspaceHashes();
    for (const hash of hashes) {
        const meta = readWorkspaceMeta(hash);
        if (!meta || !meta.originalPath) continue;

        // 跳过 "general"（无原始路径）
        if (meta.originalPath === "general") continue;

        if (!fs.existsSync(meta.originalPath)) {
            const wsIndex = readWorkspaceIndex(hash);
            const totalSize = wsIndex.entries.reduce((sum, e) => sum + e.sizeBytes, 0);
            orphans.push({
                hash,
                name: meta.name || hash,
                originalPath: meta.originalPath,
                memoryCount: wsIndex.entries.length,
                sizeKB: Math.round(totalSize / 1024),
                lastAccessed: meta.lastAccessed || "未知",
            });
        }
    }

    // 追加孤儿检测结果
    if (orphans.length > 0) {
        text += `\n\n⚠️ 发现 ${orphans.length} 个孤儿工作区（原路径已不存在）:\n`;
        orphans.forEach((o, i) => {
            text += `  ${i + 1}. ${o.name} (${o.hash}) | ${o.memoryCount} 条 | ${o.sizeKB} KB\n`;
            text += `     原路径: ${o.originalPath}\n`;
        });
        text += `\n💡 处理建议:\n`;
        text += `  - 归档: memory_stats(action="archive", workspace="原路径")\n`;
        text += `  - 导出: memory_stats(action="export", workspace="原路径", savePath="xxx.gz")\n`;
        text += `  - 确认不需要可手动删除 memory-store/workspaces/{hash}/ 目录`;
    }

    return {
        content: [{ type: "text" as const, text }],
    };
}

// === archive ===
function handleArchive(workspace?: string) {
    if (!workspace) return { content: [{ type: "text" as const, text: "❌ archive 需要指定 workspace" }] };

    const hash = workspaceHash(workspace);
    const wsDir = path.join(WORKSPACES_DIR, hash);
    const entriesDir = path.join(wsDir, "entries");
    const archivePath = path.join(wsDir, "_archive.gz");

    if (!fs.existsSync(entriesDir)) {
        return { content: [{ type: "text" as const, text: "❌ 工作区不存在" }] };
    }

    // 读取所有 .md 文件，打包为一个 JSON 然后 gzip
    const files = fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"));
    if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "⚠️ 工作区无记忆文件可归档" }] };
    }

    const archive: Record<string, string> = {};
    for (const file of files) {
        archive[file] = fs.readFileSync(path.join(entriesDir, file), "utf-8");
    }

    const archiveData = JSON.stringify(archive);
    const compressed = gzipSync(Buffer.from(archiveData, "utf-8"));
    fs.writeFileSync(archivePath, compressed);

    // 删除原文件
    for (const file of files) {
        fs.unlinkSync(path.join(entriesDir, file));
    }

    // 更新 meta
    const meta = readWorkspaceMeta(hash);
    if (meta) {
        meta.isArchived = true;
        writeWorkspaceMeta(hash, meta);
    }

    // 从缓存驱逐
    indexCache.evict(hash);
    syncGlobalIndexForWorkspace(hash);

    const ratio = ((1 - compressed.length / Buffer.byteLength(archiveData)) * 100).toFixed(1);

    return {
        content: [{
            type: "text" as const,
            text: `📦 归档完成: ${files.length} 个文件 → _archive.gz (${(compressed.length / 1024).toFixed(1)} KB, 压缩率 ${ratio}%)`,
        }],
    };
}

// === unarchive ===
function handleUnarchive(workspace?: string) {
    if (!workspace) return { content: [{ type: "text" as const, text: "❌ unarchive 需要指定 workspace" }] };

    const hash = workspaceHash(workspace);
    const wsDir = path.join(WORKSPACES_DIR, hash);
    const archivePath = path.join(wsDir, "_archive.gz");
    const entriesDir = path.join(wsDir, "entries");

    if (!fs.existsSync(archivePath)) {
        return { content: [{ type: "text" as const, text: "❌ 未找到归档文件" }] };
    }

    const compressed = fs.readFileSync(archivePath);
    const decompressed = gunzipSync(compressed).toString("utf-8");
    const archive: Record<string, string> = JSON.parse(decompressed);

    fs.mkdirSync(entriesDir, { recursive: true });
    let restored = 0;
    let unsafeSkipped = 0;
    for (const [filename, content] of Object.entries(archive)) {
        if (!isSafeFilename(entriesDir, filename)) {
            unsafeSkipped++;
            continue;
        }
        fs.writeFileSync(path.join(entriesDir, filename), content, "utf-8");
        restored++;
    }

    // 删除归档文件
    fs.unlinkSync(archivePath);

    // 更新 meta
    const meta = readWorkspaceMeta(hash);
    if (meta) {
        meta.isArchived = false;
        writeWorkspaceMeta(hash, meta);
    }

    syncGlobalIndexForWorkspace(hash);

    return {
        content: [{
            type: "text" as const,
            text: `📂 解归档完成: 恢复 ${restored} 个文件${unsafeSkipped > 0 ? ` | ⚠️ 跳过 ${unsafeSkipped} 个不安全文件名` : ''}`,
        }],
    };
}

// === export ===
function handleExport(workspace?: string, ids?: string[], savePath?: string) {
    if (!savePath) return { content: [{ type: "text" as const, text: "❌ export 需要指定 savePath" }] };

    // 简化版导出：将数据目录结构打包为 JSON 再 gzip
    // （完整 ZIP 支持需要额外依赖，这里用 .gz 保持零依赖）
    const exportData: {
        _export_meta: { exportedAt: string; version: number; hostname: string };
        workspaces: Record<string, {
            meta: unknown;
            index: unknown;
            entries: Record<string, string>;
        }>;
        general: {
            index: unknown;
            entries: Record<string, string>;
        };
    } = {
        _export_meta: {
            exportedAt: new Date().toISOString(),
            version: 1,
            hostname: os.hostname(),
        },
        workspaces: {},
        general: { index: null, entries: {} },
    };

    let totalEntries = 0;
    const hashes = workspace ? [workspaceHash(workspace)] : listWorkspaceHashes();

    for (const hash of hashes) {
        const wsDir = path.join(WORKSPACES_DIR, hash);
        if (!fs.existsSync(wsDir)) continue;

        const metaPath = path.join(wsDir, "_meta.json");
        const indexPath = path.join(wsDir, "_index.json");
        const entriesDir = path.join(wsDir, "entries");

        const wsData: { meta: unknown; index: unknown; entries: Record<string, string> } = {
            meta: fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : null,
            index: fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf-8")) : null,
            entries: {},
        };

        if (fs.existsSync(entriesDir)) {
            const files = fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"));
            for (const file of files) {
                const memId = file.replace(/\.md$/, "");
                // 如果指定了 ids，只导出指定的
                if (ids && ids.length > 0 && !ids.includes(memId)) continue;
                wsData.entries[file] = fs.readFileSync(path.join(entriesDir, file), "utf-8");
                totalEntries++;
            }
        }

        // H4: 已归档工作区 — 从 _archive.gz 解压内容纳入导出
        const archivePath = path.join(wsDir, "_archive.gz");
        if (Object.keys(wsData.entries).length === 0 && fs.existsSync(archivePath)) {
            try {
                const compressed = fs.readFileSync(archivePath);
                const archive: Record<string, string> = JSON.parse(gunzipSync(compressed).toString("utf-8"));
                for (const [filename, content] of Object.entries(archive)) {
                    const memId = filename.replace(/\.md$/, "");
                    if (ids && ids.length > 0 && !ids.includes(memId)) continue;
                    wsData.entries[filename] = content;
                    totalEntries++;
                }
            } catch { /* 归档文件损坏则跳过 */ }
        }

        if (Object.keys(wsData.entries).length > 0 || !ids) {
            exportData.workspaces[hash] = wsData;
        }
    }

    // general 区域
    if (!workspace) {
        const generalIndexPath = path.join(GENERAL_DIR, "_index.json");
        const generalEntriesDir = path.join(GENERAL_DIR, "entries");

        exportData.general.index = fs.existsSync(generalIndexPath)
            ? JSON.parse(fs.readFileSync(generalIndexPath, "utf-8")) : null;

        if (fs.existsSync(generalEntriesDir)) {
            const files = fs.readdirSync(generalEntriesDir).filter(f => f.endsWith(".md"));
            for (const file of files) {
                const memId = file.replace(/\.md$/, "");
                if (ids && ids.length > 0 && !ids.includes(memId)) continue;
                exportData.general.entries[file] = fs.readFileSync(path.join(generalEntriesDir, file), "utf-8");
                totalEntries++;
            }
        }
    }

    const jsonStr = JSON.stringify(exportData, null, 2);
    const exportCompressed = gzipSync(Buffer.from(jsonStr, "utf-8"));

    // 确保目标目录存在
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, exportCompressed);

    return {
        content: [{
            type: "text" as const,
            text: `📦 记忆已导出\n路径: ${savePath}\n包含: ${Object.keys(exportData.workspaces).length} 个工作区, ${totalEntries} 条记忆\n大小: ${(exportCompressed.length / 1024).toFixed(1)} KB`,
        }],
    };
}

// === import ===
function handleImport(zipPath?: string) {
    if (!zipPath) return { content: [{ type: "text" as const, text: "❌ import 需要指定 zipPath" }] };
    if (!fs.existsSync(zipPath)) return { content: [{ type: "text" as const, text: `❌ 文件不存在: ${zipPath}` }] };

    // 确保数据目录存在
    ensureDataDirs();

    const importCompressed = fs.readFileSync(zipPath);
    const decompressed = gunzipSync(importCompressed).toString("utf-8");
    const importData = JSON.parse(decompressed);

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let newWorkspaces = 0;

    // 导入工作区
    if (importData.workspaces) {
        for (const [hash, wsData] of Object.entries(importData.workspaces) as any[]) {
            const wsDir = path.join(WORKSPACES_DIR, hash);
            const entriesDir = path.join(wsDir, "entries");
            const isNew = !fs.existsSync(wsDir);

            fs.mkdirSync(entriesDir, { recursive: true });

            if (isNew) newWorkspaces++;

            // 写入 meta
            if (wsData.meta) {
                const metaPath = path.join(wsDir, "_meta.json");
                if (!fs.existsSync(metaPath)) {
                    writeJsonAtomic(metaPath, wsData.meta);
                }
            }

            // 合并记忆
            let unsafeFiles = 0;
            for (const [filename, content] of Object.entries(wsData.entries) as [string, string][]) {
                if (!isSafeFilename(entriesDir, filename)) {
                    unsafeFiles++;
                    continue;
                }
                const targetPath = path.join(entriesDir, filename);
                if (fs.existsSync(targetPath)) {
                    // 已存在 → 比较 updatedAt
                    const existing = parseMemoryFile(fs.readFileSync(targetPath, "utf-8"));
                    const incoming = parseMemoryFile(content as string);

                    if (existing?.frontmatter?.updated && incoming?.frontmatter?.updated) {
                        if (new Date(String(incoming.frontmatter.updated)) > new Date(String(existing.frontmatter.updated))) {
                            fs.writeFileSync(targetPath, content, "utf-8");
                            updated++;
                        } else {
                            skipped++;
                        }
                    } else {
                        skipped++;
                    }
                } else {
                    fs.writeFileSync(targetPath, content, "utf-8");
                    added++;
                }
            }

            // 重建索引
            rebuildWorkspaceIndex(hash);
        }
    }

    // 导入 general
    if (importData.general?.entries) {
        const entriesDir = path.join(GENERAL_DIR, "entries");
        fs.mkdirSync(entriesDir, { recursive: true });

        for (const [filename, content] of Object.entries(importData.general.entries) as [string, string][]) {
            if (!isSafeFilename(entriesDir, filename)) {
                skipped++;
                continue;
            }
            const targetPath = path.join(entriesDir, filename);
            if (fs.existsSync(targetPath)) {
                // 与工作区导入保持一致：比较 updatedAt
                const existing = parseMemoryFile(fs.readFileSync(targetPath, "utf-8"));
                const incoming = parseMemoryFile(content as string);

                if (existing?.frontmatter?.updated && incoming?.frontmatter?.updated) {
                    if (new Date(String(incoming.frontmatter.updated)) > new Date(String(existing.frontmatter.updated))) {
                        fs.writeFileSync(targetPath, content, "utf-8");
                        updated++;
                    } else {
                        skipped++;
                    }
                } else {
                    skipped++;
                }
            } else {
                fs.writeFileSync(targetPath, content, "utf-8");
                added++;
            }
        }

        rebuildWorkspaceIndex("general");
    }

    return {
        content: [{
            type: "text" as const,
            text: `📥 记忆导入完成\n来源: ${path.basename(zipPath)}\n新增: ${added} 条 | 更新: ${updated} 条 | 跳过（已是最新）: ${skipped} 条\n新工作区: ${newWorkspaces} 个`,
        }],
    };
}

// === enhance ===
async function handleEnhance(workspace?: string, chain: Chain = "auto") {
    // 收集需要增强的记忆
    const targets: Array<{ hash: string; entry: { id: string; title: string; tags: string[] } }> = [];
    let skipped = 0;

    const hashList = workspace
        ? [workspace === "general" ? "general" : workspaceHash(workspace)]
        : ["general", ...listWorkspaceHashes()];

    for (const hash of hashList) {
        const wsIndex = readWorkspaceIndex(hash);
        for (const entry of wsIndex.entries) {
            if (entry.autoSummary) {
                skipped++;
            } else {
                targets.push({ hash, entry: { id: entry.id, title: entry.title, tags: entry.tags } });
            }
        }
    }

    if (targets.length === 0) {
        return { content: [{ type: "text" as const, text: `✅ 无需增强，所有 ${skipped} 条记忆已有 autoSummary` }] };
    }

    let success = 0;
    let failed = 0;

    for (const target of targets) {
        try {
            // 读取记忆文件正文
            const entriesDir = target.hash === "general"
                ? path.join(GENERAL_DIR, "entries")
                : path.join(WORKSPACES_DIR, target.hash, "entries");
            const filePath = path.join(entriesDir, `${target.entry.id}.md`);
            if (!fs.existsSync(filePath)) { failed++; continue; }

            const fileContent = fs.readFileSync(filePath, "utf-8");
            const parsed = parseMemoryFile(fileContent);
            if (!parsed) { failed++; continue; }

            const summary = await generateAutoSummary(target.entry.title, target.entry.tags, parsed.body, chain);
            if (!summary) { failed++; continue; }

            // 重建文件
            const fm = parsed.frontmatter;
            const newFm: any = {
                id: String(fm.id || target.entry.id),
                title: String(fm.title || target.entry.title),
                tags: Array.isArray(fm.tags) ? fm.tags : target.entry.tags,
                category: String(fm.category || "general"),
                created: String(fm.created || new Date().toISOString()),
                updated: String(fm.updated || new Date().toISOString()),
                workspace: String(fm.workspace || "general"),
                conversationId: fm.conversationId ? String(fm.conversationId) : undefined,
                searchSummary: String(fm.searchSummary || ""),
                autoSummary: summary,
                pinned: fm.pinned === true ? true : undefined,
            };

            const newContent = buildMemoryFile(newFm, parsed.body);
            fs.writeFileSync(filePath, newContent, "utf-8");

            // 更新索引
            const wsIndex = readWorkspaceIndex(target.hash);
            const indexEntry = wsIndex.entries.find(e => e.id === target.entry.id);
            if (indexEntry) {
                indexEntry.autoSummary = summary;
                indexEntry.sizeBytes = Buffer.byteLength(newContent, "utf-8");
            }
            writeWorkspaceIndex(target.hash, wsIndex);

            success++;
            console.error(`[memory-store] enhance: ${target.entry.id} ✅`);
        } catch {
            failed++;
        }
    }

    return {
        content: [{
            type: "text" as const,
            text: `🔄 增强完成: 成功 ${success} / 跳过 ${skipped} (已有) / 失败 ${failed}`,
        }],
    };
}

/**
 * 从 entries 目录重建工作区索引
 */
function rebuildWorkspaceIndex(hash: string): void {
    const dir = hash === "general" ? GENERAL_DIR : path.join(WORKSPACES_DIR, hash);
    const entriesDir = path.join(dir, "entries");


    if (!fs.existsSync(entriesDir)) return;

    const files = fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"));
    const entries: Array<{
        id: string; title: string; searchSummary: string; autoSummary?: string;
        tags: string[]; category: string; createdAt: string;
        updatedAt: string; lastAccessed: string; sizeBytes: number;
        lineCount: number; conversationId?: string; pinned?: boolean;
    }> = [];

    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(entriesDir, file), "utf-8");
            const parsed = parseMemoryFile(content);
            if (!parsed) continue;

            const fm = parsed.frontmatter;
            entries.push({
                id: String(fm.id || file.replace(/\.md$/, "")),
                title: String(fm.title || ""),
                searchSummary: String(fm.searchSummary || ""),
                tags: Array.isArray(fm.tags) ? fm.tags : [],
                category: String(fm.category || "general"),
                createdAt: String(fm.created || new Date().toISOString()),
                updatedAt: String(fm.updated || new Date().toISOString()),
                lastAccessed: String(fm.updated || new Date().toISOString()),
                sizeBytes: Buffer.byteLength(content, "utf-8"),
                lineCount: content.split(/\r?\n/).length,
                conversationId: fm.conversationId ? String(fm.conversationId) : undefined,
                pinned: fm.pinned === true ? true : undefined,
                autoSummary: fm.autoSummary ? String(fm.autoSummary) : undefined,
            });
        } catch { /* skip */ }
    }

    writeWorkspaceIndex(hash, { version: 1, entries });
    syncGlobalIndexForWorkspace(hash);
}

// === 辅助 ===
function getRelativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

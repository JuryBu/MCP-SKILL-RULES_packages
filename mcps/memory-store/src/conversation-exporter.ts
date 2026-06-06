import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DATA_ROOT, writeJsonAtomic, writeTextAtomic } from "./store.js";
import {
    formatOverview,
    formatRound,
    searchInRounds,
    type CompactionMode,
    type ConversationRound,
    type Depth,
    type ExtraType,
} from "./trajectory.js";
import { materializeRoundAttachments, type ConversationAttachment } from "./conversation-attachments.js";
import { renderConversationPdf } from "./conversation-pdf.js";
import type { ResolvedConversationChain } from "./conversation-bridge.js";
import type { SearchMode } from "./search-engine.js";

export type ConversationExportFormat = "markdown" | "pdf" | "both";
export type ConversationExportScope = "full" | "rounds" | "search";
export type PdfEmbedAttachmentsMode = "off" | "auto" | "force";

export interface ConversationExportOptions {
    conversationId: string;
    chainUsed: ResolvedConversationChain;
    rounds: ConversationRound[];
    totalSteps: number;
    expandedChildren?: Array<{ thread: { id: string; title: string }; rounds: ConversationRound[] }>;
    childDiagnostics?: Array<{ threadId: string; nickname?: string; reason: string; detail: string }>;
    partialWarning?: string;
    scope?: ConversationExportScope;
    query?: string;
    startRound?: number;
    endRound?: number;
    contextRounds?: number;
    limit?: number;
    mode?: SearchMode;
    depth?: Depth;
    extraTypes?: ExtraType[];
    compactionMode?: CompactionMode;
    outputDir?: string;
    overwrite?: boolean;
    format?: ConversationExportFormat;
    includeAssets?: boolean;
    pdfEmbedAttachments?: PdfEmbedAttachmentsMode;
}

export interface ConversationExportAsset {
    roundIndex: number;
    kind: "image" | "file";
    source: string;
    displayName: string;
    originalPath?: string;
    exportPath?: string;
    relativePath?: string;
    sizeBytes?: number;
    sha256?: string;
    warning?: string;
}

export interface ConversationExportResult {
    success: boolean;
    conversationId: string;
    chainUsed: ResolvedConversationChain;
    exportDir: string;
    markdownPath?: string;
    pdfPath?: string;
    htmlPath?: string;
    manifestPath: string;
    warnings: string[];
    stats: {
        roundsExported: number;
        totalRounds: number;
        totalSteps: number;
        markdownChars: number;
        assetsCopied: number;
        assetsSkipped: number;
        embeddedPdfAttachments: number;
    };
}

const DEFAULT_MAX_EXPORT_CHARS = 5_000_000;
const DEFAULT_MAX_ASSETS = 200;
const DEFAULT_MAX_ASSET_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ASSET_BYTES = 250 * 1024 * 1024;

function timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

function safeSegment(input: string): string {
    const cleaned = input.replace(/[^a-zA-Z0-9\u4e00-\u9fff_.-]/gu, "_").replace(/_+/gu, "_").slice(0, 96);
    return cleaned || "conversation";
}

function atomicWriteText(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextAtomic(filePath, content);
}

function resolveExportDirectory(options: ConversationExportOptions): string {
    const folder = `conversation_${safeSegment(options.conversationId.slice(0, 8))}_${timestamp()}`;
    if (options.outputDir?.trim()) {
        const base = path.resolve(options.outputDir.trim());
        fs.mkdirSync(base, { recursive: true });
        if (options.overwrite) return base;
        const target = path.join(base, folder);
        fs.mkdirSync(target, { recursive: true });
        return target;
    }
    const base = path.join(DATA_ROOT, "exports", "conversations", options.chainUsed, safeSegment(options.conversationId));
    const target = path.join(base, folder);
    fs.mkdirSync(target, { recursive: true });
    return target;
}

function cloneRound(round: ConversationRound): ConversationRound {
    return {
        ...round,
        mediaAttachments: [...(round.mediaAttachments || [])],
        attachments: round.attachments ? round.attachments.map(item => ({ ...item })) : undefined,
        aiResponses: round.aiResponses.map(item => ({
            ...item,
            toolCalls: item.toolCalls.map(tc => ({ ...tc })),
        })),
        toolCalls: round.toolCalls.map(item => ({ ...item })),
        taskBoundaries: round.taskBoundaries.map(item => ({ ...item })),
        codeActions: round.codeActions.map(item => ({
            ...item,
            diffs: item.diffs.map(diff => ({ ...diff })),
        })),
        subagentSummaries: round.subagentSummaries.map(item => ({ ...item })),
        fileViews: round.fileViews?.map(item => ({ ...item })),
        compactionSummaries: round.compactionSummaries?.map(item => ({ ...item })),
    };
}

function buildSearchBlockContent(round: ConversationRound): string {
    return [
        round.userMessage,
        ...round.aiResponses.map(item => item.response),
    ].filter(Boolean).join("\n");
}

async function selectRounds(options: ConversationExportOptions): Promise<{ rounds: ConversationRound[]; warnings: string[]; rangeLabel: string }> {
    const scope = options.scope || "full";
    const warnings: string[] = [];
    if (scope === "search") {
        if (!options.query?.trim()) {
            warnings.push("scope=search 未提供 query，已导出空范围");
            return { rounds: [], warnings, rangeLabel: "search(empty)" };
        }
        const exactMatches = searchInRounds(options.rounds, options.query, options.limit || 8);
        let roundIndices = exactMatches.map(item => item.roundIndex);
        if (roundIndices.length === 0 && options.mode !== "exact") {
            const { search } = await import("./search-engine.js");
            const blocks = options.rounds.map(round => ({
                id: String(round.roundIndex),
                title: `轮次 ${round.roundIndex}`,
                content: buildSearchBlockContent(round),
                tags: [] as string[],
            }));
            const requestedMode = options.mode === "smart" ? "fuzzy" : (options.mode === "auto" ? "fuzzy" : options.mode || "fuzzy");
            if (options.mode === "smart") warnings.push("export scope=search 不默认调用模型，smart 已降级为 fuzzy");
            const fuzzy = await search(blocks, options.query, { mode: requestedMode, limit: options.limit || 8 });
            roundIndices = fuzzy.map(item => Number(item.id)).filter(Number.isFinite);
        }
        const context = Math.max(0, options.contextRounds ?? 2);
        const selected = new Set<number>();
        for (const index of roundIndices) {
            for (let current = Math.max(1, index - context); current <= Math.min(options.rounds.length, index + context); current++) {
                selected.add(current);
            }
        }
        const rounds = [...selected].sort((a, b) => a - b).map(index => options.rounds[index - 1]).filter(Boolean);
        return { rounds, warnings, rangeLabel: `search(${options.query})` };
    }
    if (scope === "rounds") {
        const start = Math.max(1, options.startRound || 1);
        const end = Math.min(options.rounds.length, options.endRound || options.rounds.length);
        if (start > end || start > options.rounds.length) return { rounds: [], warnings: [`轮次范围 ${start}-${end} 为空`], rangeLabel: `${start}-${end}` };
        return { rounds: options.rounds.slice(start - 1, end), warnings, rangeLabel: `${start}-${end}` };
    }
    return { rounds: options.rounds, warnings, rangeLabel: `1-${options.rounds.length}` };
}

function pathFromUriOrPath(input: string): string | null {
    const value = input.trim();
    if (!value) return null;
    if (/^file:\/\//iu.test(value)) {
        try {
            return fileURLToPath(value);
        } catch {
            return null;
        }
    }
    if (/^data:/iu.test(value)) return null;
    if (/^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value)) return path.normalize(value);
    if (/^[a-z]+:\/\//iu.test(value)) return null;
    return path.resolve(value);
}

function extensionForAsset(filePath: string, kind: "image" | "file", mimeType?: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext) return ext;
    if (mimeType?.includes("jpeg")) return ".jpg";
    if (mimeType?.includes("png")) return ".png";
    if (mimeType?.includes("webp")) return ".webp";
    if (mimeType?.includes("gif")) return ".gif";
    return kind === "image" ? ".png" : ".bin";
}

function parseInlineImage(input: string): { mimeType: string; bytes: Buffer } | null {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/isu.exec(input.trim());
    if (!match) return null;
    const base64 = match[2].replace(/\s+/gu, "");
    try {
        return { mimeType: match[1].toLowerCase(), bytes: Buffer.from(base64, "base64") };
    } catch {
        return null;
    }
}

function hashFile(filePath: string): { sha256: string; sizeBytes: number } {
    const hash = crypto.createHash("sha256");
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return { sha256: hash.digest("hex"), sizeBytes: data.length };
}

function writeInlineImageAsset(
    uri: string,
    asset: Omit<ConversationExportAsset, "exportPath" | "relativePath" | "sizeBytes" | "sha256">,
    exportDir: string,
    budget: { remainingCount: number; remainingBytes: number; maxBytes: number; copiedByKey: Map<string, ConversationExportAsset> },
): ConversationExportAsset {
    const parsed = parseInlineImage(uri);
    if (!parsed) return { ...asset, warning: "内联图片不是可识别的 base64 image data URL，未复制" };
    const sizeBytes = parsed.bytes.length;
    if (budget.remainingCount <= 0) return { ...asset, sizeBytes, warning: "超过导出附件数量预算，未复制" };
    if (sizeBytes > budget.maxBytes) return { ...asset, sizeBytes, warning: `超过单附件大小预算 ${budget.maxBytes} bytes，未复制` };
    if (sizeBytes > budget.remainingBytes) return { ...asset, sizeBytes, warning: "超过导出附件总大小预算，未复制" };
    const sha256 = crypto.createHash("sha256").update(parsed.bytes).digest("hex");
    const key = `data:${sha256}`;
    const cached = budget.copiedByKey.get(key);
    if (cached) return { ...cached, roundIndex: asset.roundIndex, source: asset.source, displayName: asset.displayName };

    const directory = path.join(exportDir, "assets", "images");
    fs.mkdirSync(directory, { recursive: true });
    const ext = extensionForAsset("", "image", parsed.mimeType);
    const filename = `round-${String(asset.roundIndex).padStart(6, "0")}_${sha256.slice(0, 12)}${ext}`;
    const targetPath = path.join(directory, filename);
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size !== sizeBytes) {
        const tmpPath = `${targetPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, parsed.bytes);
        fs.renameSync(tmpPath, targetPath);
    }
    budget.remainingCount -= 1;
    budget.remainingBytes -= sizeBytes;
    const result: ConversationExportAsset = {
        ...asset,
        exportPath: targetPath,
        relativePath: path.relative(exportDir, targetPath).replace(/\\/gu, "/"),
        sizeBytes,
        sha256,
    };
    budget.copiedByKey.set(key, result);
    return result;
}

function copyAsset(
    sourcePath: string | null,
    asset: Omit<ConversationExportAsset, "exportPath" | "relativePath" | "sizeBytes" | "sha256">,
    exportDir: string,
    budget: { remainingCount: number; remainingBytes: number; maxBytes: number; copiedByKey: Map<string, ConversationExportAsset> },
): ConversationExportAsset {
    if (!sourcePath) return { ...asset, warning: "附件不是本地文件路径，未复制" };
    let stat: fs.Stats;
    try {
        stat = fs.statSync(sourcePath);
        if (!stat.isFile()) return { ...asset, originalPath: sourcePath, warning: "附件路径不是文件，未复制" };
    } catch {
        return { ...asset, originalPath: sourcePath, warning: "附件路径不存在或不可访问，未复制" };
    }
    if (budget.remainingCount <= 0) return { ...asset, originalPath: sourcePath, sizeBytes: stat.size, warning: "超过导出附件数量预算，未复制" };
    if (stat.size > budget.maxBytes) return { ...asset, originalPath: sourcePath, sizeBytes: stat.size, warning: `超过单附件大小预算 ${budget.maxBytes} bytes，未复制` };
    if (stat.size > budget.remainingBytes) return { ...asset, originalPath: sourcePath, sizeBytes: stat.size, warning: "超过导出附件总大小预算，未复制" };

    const key = path.normalize(sourcePath).toLowerCase();
    const cached = budget.copiedByKey.get(key);
    if (cached) return { ...cached, roundIndex: asset.roundIndex, source: asset.source, displayName: asset.displayName };

    const { sha256, sizeBytes } = hashFile(sourcePath);
    const directory = asset.kind === "image" ? path.join(exportDir, "assets", "images") : path.join(exportDir, "assets", "files");
    fs.mkdirSync(directory, { recursive: true });
    const ext = extensionForAsset(sourcePath, asset.kind);
    const filename = `round-${String(asset.roundIndex).padStart(6, "0")}_${sha256.slice(0, 12)}${ext}`;
    const targetPath = path.join(directory, filename);
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size !== sizeBytes) {
        const tmpPath = `${targetPath}.${process.pid}.tmp`;
        fs.copyFileSync(sourcePath, tmpPath);
        fs.renameSync(tmpPath, targetPath);
    }
    budget.remainingCount -= 1;
    budget.remainingBytes -= sizeBytes;
    const result: ConversationExportAsset = {
        ...asset,
        originalPath: sourcePath,
        exportPath: targetPath,
        relativePath: path.relative(exportDir, targetPath).replace(/\\/gu, "/"),
        sizeBytes,
        sha256,
    };
    budget.copiedByKey.set(key, result);
    return result;
}

function collectAndRewriteAssets(
    rounds: ConversationRound[],
    exportDir: string,
    includeAssets: boolean,
): { rounds: ConversationRound[]; assets: ConversationExportAsset[]; warnings: string[] } {
    const warnings: string[] = [];
    const cloned = rounds.map(cloneRound);
    if (!includeAssets) return { rounds: cloned, assets: [], warnings };
    const budget = {
        remainingCount: Math.max(0, Number(process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_ASSETS || DEFAULT_MAX_ASSETS)),
        remainingBytes: Math.max(1, Number(process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_TOTAL_ASSET_BYTES || DEFAULT_MAX_TOTAL_ASSET_BYTES)),
        maxBytes: Math.max(1, Number(process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_ASSET_BYTES || DEFAULT_MAX_ASSET_BYTES)),
        copiedByKey: new Map<string, ConversationExportAsset>(),
    };
    const assets: ConversationExportAsset[] = [];

    for (const round of cloned) {
        round.mediaAttachments = round.mediaAttachments.map((uri, index) => {
            const sourcePath = pathFromUriOrPath(uri);
            const descriptor = {
                roundIndex: round.roundIndex,
                kind: "image",
                source: "mediaAttachments",
                displayName: `round-${round.roundIndex}-media-${index + 1}`,
                originalPath: sourcePath || uri,
            } satisfies Omit<ConversationExportAsset, "exportPath" | "relativePath" | "sizeBytes" | "sha256">;
            const copied = sourcePath
                ? copyAsset(sourcePath, descriptor, exportDir, budget)
                : writeInlineImageAsset(uri, descriptor, exportDir, budget);
            assets.push(copied);
            if (copied.warning) warnings.push(`R${round.roundIndex} 图片附件：${copied.warning}`);
            return copied.relativePath || uri;
        });

        for (const attachment of round.attachments || []) {
            const sourcePath = pathFromUriOrPath(attachment.tempPath || attachment.originalPath || "");
            const copied = copyAsset(sourcePath, {
                roundIndex: round.roundIndex,
                kind: attachment.kind,
                source: attachment.source,
                displayName: attachment.name || path.basename(sourcePath || attachment.tempPath || attachment.originalPath || "attachment"),
                originalPath: sourcePath || attachment.originalPath || attachment.tempPath,
            }, exportDir, budget);
            assets.push(copied);
            if (copied.warning) warnings.push(`R${round.roundIndex} ${attachment.kind === "image" ? "图片" : "文件"}附件：${copied.warning}`);
            if (copied.relativePath) {
                if (attachment.tempPath) attachment.tempPath = copied.relativePath;
                else attachment.originalPath = copied.relativePath;
                attachment.exists = true;
            }
        }
    }

    return { rounds: cloned, assets, warnings };
}

function formatAssetAppendix(assets: ConversationExportAsset[]): string {
    const lines = ["", "# 附件清单", ""];
    if (assets.length === 0) {
        lines.push("本次导出未包含附件。");
        return lines.join("\n");
    }
    for (const asset of assets) {
        const status = asset.relativePath
            ? asset.kind === "image"
                ? `![${asset.displayName}](${asset.relativePath})`
                : `[${asset.displayName}](${asset.relativePath})`
            : asset.warning || "未复制";
        lines.push(`- R${asset.roundIndex} ${asset.kind === "image" ? "图片" : "文件"} ${asset.displayName}: ${status}`);
    }
    return lines.join("\n");
}

function buildMarkdown(options: ConversationExportOptions, rounds: ConversationRound[], assets: ConversationExportAsset[], warnings: string[], rangeLabel: string): string {
    const lines: string[] = [];
    lines.push("# Conversation Export");
    lines.push("");
    lines.push("## Export Metadata");
    lines.push("");
    lines.push(`- conversationId: ${options.conversationId}`);
    lines.push(`- dataChain: ${options.chainUsed}`);
    lines.push(`- exportedAt: ${new Date().toISOString()}`);
    lines.push(`- scope: ${options.scope || "full"}`);
    lines.push(`- rounds: ${rangeLabel} / total ${options.rounds.length}`);
    lines.push(`- totalSteps: ${options.totalSteps}`);
    lines.push(`- depth: ${options.depth || "normal"}`);
    lines.push(`- extraTypes: ${(options.extraTypes || []).join(", ") || "(none)"}`);
    lines.push(`- compactionMode: ${options.compactionMode || ((options.depth || "normal") === "full" ? "full" : "folded")}`);
    lines.push("");
    if (warnings.length || options.partialWarning) {
        lines.push("## Warnings");
        lines.push("");
        if (options.partialWarning) lines.push(`- ${options.partialWarning.replace(/\n/gu, " ")}`);
        for (const warning of warnings) lines.push(`- ${warning}`);
        lines.push("");
    }
    lines.push("## Conversation");
    lines.push("");
    lines.push(formatOverview(options.conversationId, options.rounds, options.totalSteps));
    lines.push(`🔗 数据链路: ${options.chainUsed}`);
    lines.push("");
    for (const round of rounds) {
        lines.push(formatRound(round, options.depth || "normal", options.extraTypes || [], {
            compactionMode: options.compactionMode || ((options.depth || "normal") === "full" ? "full" : "folded"),
        }));
        lines.push("");
    }
    if (options.expandedChildren?.length) {
        lines.push("# 子代理线程展开");
        lines.push("");
        for (const child of options.expandedChildren) {
            lines.push(`## 子线程 ${child.thread.id.slice(0, 8)}... ${child.thread.title ? `| ${child.thread.title}` : ""}`);
            for (const round of child.rounds) {
                lines.push(formatRound(round, options.depth || "normal", options.extraTypes || [], {
                    compactionMode: options.compactionMode || ((options.depth || "normal") === "full" ? "full" : "folded"),
                }));
                lines.push("");
            }
        }
    }
    if (options.childDiagnostics?.length) {
        lines.push("# 子代理线程诊断");
        lines.push("");
        for (const item of options.childDiagnostics) {
            const label = item.nickname ? `${item.nickname} (${item.threadId.slice(0, 8)}...)` : item.threadId;
            lines.push(`- ${label}: ${item.reason} — ${item.detail}`);
        }
        lines.push("");
    }
    lines.push(formatAssetAppendix(assets));
    return lines.join("\n");
}

export async function exportConversation(options: ConversationExportOptions): Promise<ConversationExportResult> {
    const format = options.format || "markdown";
    const includeAssets = options.includeAssets !== false;
    const warnings: string[] = [];
    const exportDir = resolveExportDirectory(options);
    const selected = await selectRounds(options);
    warnings.push(...selected.warnings);

    const materialized = await materializeRoundAttachments(selected.rounds, options.conversationId);
    if (materialized.truncated > 0) warnings.push(`${materialized.truncated} 个内联图片超过 materialize 预算，未生成导出图片`);
    const assetResult = collectAndRewriteAssets(materialized.rounds, exportDir, includeAssets);
    warnings.push(...assetResult.warnings);

    let markdown = buildMarkdown(options, assetResult.rounds, assetResult.assets, warnings, selected.rangeLabel);
    const maxChars = Math.max(10_000, Number(process.env.MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS || DEFAULT_MAX_EXPORT_CHARS));
    if (markdown.length > maxChars) {
        markdown = `${markdown.slice(0, maxChars)}\n\n⚠️ 导出正文超过 MEMORY_STORE_CONVERSATION_EXPORT_MAX_CHARS=${maxChars}，已截断。\n`;
        warnings.push(`导出正文超过 ${maxChars} 字，Markdown 已截断`);
    }

    const markdownPath = path.join(exportDir, "conversation.md");
    atomicWriteText(markdownPath, markdown);

    let pdfPath: string | undefined;
    let htmlPath: string | undefined;
    let embeddedPdfAttachments = 0;
    if (format === "pdf" || format === "both") {
        const targetPdfPath = path.join(exportDir, "conversation.pdf");
        const pdf = await renderConversationPdf({
            title: `Conversation ${options.conversationId}`,
            exportDir,
            markdownPath,
            pdfPath: targetPdfPath,
            embedAttachments: options.pdfEmbedAttachments || "auto",
            attachmentFiles: assetResult.assets
                .filter(asset => asset.kind === "file" && asset.exportPath)
                .map(asset => ({ path: asset.exportPath || "", name: asset.displayName, sizeBytes: asset.sizeBytes })),
        });
        warnings.push(...pdf.warnings);
        htmlPath = pdf.htmlPath;
        embeddedPdfAttachments = pdf.embeddedAttachments;
        if (pdf.ok && pdf.pdfPath) pdfPath = pdf.pdfPath;
    }

    const manifestPath = path.join(exportDir, "manifest.json");
    const manifest = {
        conversationId: options.conversationId,
        dataChain: options.chainUsed,
        exportedAt: new Date().toISOString(),
        format,
        scope: options.scope || "full",
        depth: options.depth || "normal",
        extraTypes: options.extraTypes || [],
        compactionMode: options.compactionMode || ((options.depth || "normal") === "full" ? "full" : "folded"),
        startRound: selected.rounds[0]?.roundIndex || null,
        endRound: selected.rounds[selected.rounds.length - 1]?.roundIndex || null,
        totalRounds: options.rounds.length,
        totalSteps: options.totalSteps,
        roundsExported: selected.rounds.length,
        partial: Boolean(options.partialWarning) || warnings.length > 0,
        partialWarning: options.partialWarning || null,
        warnings,
        files: {
            markdown: markdownPath,
            pdf: pdfPath || null,
            html: htmlPath || null,
        },
        assets: assetResult.assets,
        stats: {
            markdownChars: markdown.length,
            assetsCopied: assetResult.assets.filter(asset => asset.exportPath).length,
            assetsSkipped: assetResult.assets.filter(asset => asset.warning && !asset.exportPath).length,
            embeddedPdfAttachments,
        },
    };
    writeJsonAtomic(manifestPath, manifest);

    return {
        success: format === "pdf" ? Boolean(pdfPath) : true,
        conversationId: options.conversationId,
        chainUsed: options.chainUsed,
        exportDir,
        markdownPath,
        pdfPath,
        htmlPath,
        manifestPath,
        warnings,
        stats: {
            roundsExported: selected.rounds.length,
            totalRounds: options.rounds.length,
            totalSteps: options.totalSteps,
            markdownChars: markdown.length,
            assetsCopied: assetResult.assets.filter(asset => asset.exportPath).length,
            assetsSkipped: assetResult.assets.filter(asset => asset.warning && !asset.exportPath).length,
            embeddedPdfAttachments,
        },
    };
}

export function formatConversationExportResult(result: ConversationExportResult): string {
    const lines = [
        `${result.success ? "✅" : "⚠️"} Conversation exported`,
        `📂 对话: ${result.conversationId}`,
        `🔗 数据链路: ${result.chainUsed}`,
        `📁 导出目录: ${result.exportDir}`,
        result.markdownPath ? `📄 Markdown: ${result.markdownPath}` : "",
        result.pdfPath ? `📕 PDF: ${result.pdfPath}` : "📕 PDF: 未生成",
        result.htmlPath ? `🌐 HTML: ${result.htmlPath}` : "",
        `📋 Manifest: ${result.manifestPath}`,
        `📊 轮次: ${result.stats.roundsExported}/${result.stats.totalRounds} | Markdown ${(result.stats.markdownChars / 1024).toFixed(1)}KB | assets ${result.stats.assetsCopied} copied / ${result.stats.assetsSkipped} skipped`,
        result.stats.embeddedPdfAttachments > 0 ? `🧷 PDF 原生附件嵌入: ${result.stats.embeddedPdfAttachments}` : "",
    ].filter(Boolean);
    if (result.warnings.length) {
        lines.push("");
        lines.push("⚠️ Warnings:");
        for (const warning of result.warnings.slice(0, 12)) lines.push(`- ${warning}`);
        if (result.warnings.length > 12) lines.push(`- ... 还有 ${result.warnings.length - 12} 条 warning，详见 manifest.json`);
    }
    return lines.join("\n");
}

import fs from "fs";
import path from "path";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";
import { loadConversationData } from "./conversation-bridge.js";
import { exportConversation, formatConversationExportResult, type ConversationExportOptions, type ConversationExportResult } from "./conversation-exporter.js";
import type { UnifiedConversationCandidate, SourceStatus } from "./conversation-filter.js";
import type { ConversationLinkMode } from "./chain.js";

export interface ConversationBatchExportOptions extends Omit<ConversationExportOptions, "conversationId" | "chainUsed" | "rounds" | "totalSteps" | "expandedChildren" | "childDiagnostics" | "partialWarning"> {
    candidates: UnifiedConversationCandidate[];
    batchLimit?: number;
    batchConcurrency?: number;
    sourceStatuses?: SourceStatus[];
    link?: ConversationLinkMode;
}

export interface ConversationBatchExportItemResult {
    conversationId: string;
    dataChain: string;
    title: string;
    workspace: string;
    success: boolean;
    exportDir?: string;
    markdownPath?: string;
    pdfPath?: string;
    manifestPath?: string;
    warnings: string[];
    error?: string;
}

export interface ConversationBatchExportResult {
    success: boolean;
    exportDir: string;
    manifestPath: string;
    total: number;
    succeeded: number;
    failed: number;
    sourceStatuses: SourceStatus[];
    items: ConversationBatchExportItemResult[];
}

function timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

function safeSegment(input: string): string {
    return input.replace(/[^a-zA-Z0-9\u4e00-\u9fff_.-]/gu, "_").replace(/_+/gu, "_").slice(0, 96) || "item";
}

function resolveBatchExportDirectory(outputDir?: string): string {
    const folder = `conversation_batch_${timestamp()}`;
    if (outputDir?.trim()) {
        const base = path.resolve(outputDir.trim());
        fs.mkdirSync(base, { recursive: true });
        const target = path.join(base, folder);
        fs.mkdirSync(target, { recursive: true });
        return target;
    }
    const target = path.join(DATA_ROOT, "exports", "conversations", "batch", folder);
    fs.mkdirSync(target, { recursive: true });
    return target;
}

function formatWindsurfPartialWarning(loaded: Awaited<ReturnType<typeof loadConversationData>>): string {
    const skipped = loaded?.windsurfData?.skippedSteps || [];
    if (!loaded?.windsurfData?.partial || skipped.length === 0) return "";
    const shown = skipped.slice(0, 5).map(item => `offset ${item.offset}`).join(", ");
    const more = skipped.length > 5 ? ` 等 ${skipped.length} 个` : "";
    return `⚠️ WSF 读取已降级：跳过超大 step ${shown}${more}`;
}

async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

export async function exportConversationBatch(options: ConversationBatchExportOptions): Promise<ConversationBatchExportResult> {
    const batchDir = resolveBatchExportDirectory(options.outputDir);
    const selected = options.candidates.slice(0, Math.max(options.batchLimit || options.candidates.length, 0));
    const concurrency = Math.max(1, Math.min(options.batchConcurrency || 2, 4));
    const pendingManifestPath = path.join(batchDir, "batch_manifest.pending.json");
    const startedAt = new Date().toISOString();
    const request = {
        batchLimit: options.batchLimit,
        batchConcurrency: concurrency,
        candidateCount: options.candidates.length,
        selectedCount: selected.length,
        scope: options.scope || "full",
        format: options.format || "markdown",
        query: options.query,
        startRound: options.startRound,
        endRound: options.endRound,
        contextRounds: options.contextRounds,
        limit: options.limit,
        mode: options.mode,
        depth: options.depth,
        includeAssets: options.includeAssets,
        pdfEmbedAttachments: options.pdfEmbedAttachments,
        candidates: selected.map(item => ({
            dataChain: item.dataChain,
            conversationId: item.id,
            title: item.title,
            workspace: item.workspace,
        })),
    };
    writeJsonAtomic(pendingManifestPath, {
        status: "running",
        startedAt,
        request,
        sourceStatuses: options.sourceStatuses || [],
    });

    const items = await runWithConcurrency(selected, concurrency, async (candidate) => {
        const childDir = path.join(batchDir, `${safeSegment(candidate.dataChain)}_${safeSegment(candidate.id.slice(0, 8))}`);
        try {
            const loaded = await loadConversationData(candidate.dataChain, candidate.id, { link: options.link });
            if (!loaded) {
                return {
                    conversationId: candidate.id,
                    dataChain: candidate.dataChain,
                    title: candidate.title,
                    workspace: candidate.workspace,
                    success: false,
                    warnings: [],
                    error: "无法读取对话数据",
                };
            }
            const result: ConversationExportResult = await exportConversation({
                ...options,
                conversationId: loaded.conversationId,
                chainUsed: loaded.chainUsed,
                rounds: loaded.rounds,
                totalSteps: loaded.totalSteps,
                expandedChildren: loaded.codexData?.expandedChildren || [],
                childDiagnostics: loaded.codexData?.childDiagnostics || [],
                partialWarning: formatWindsurfPartialWarning(loaded),
                outputDir: childDir,
                overwrite: true,
            });
            return {
                conversationId: loaded.conversationId,
                dataChain: loaded.chainUsed,
                title: candidate.title,
                workspace: candidate.workspace,
                success: result.success,
                exportDir: result.exportDir,
                markdownPath: result.markdownPath,
                pdfPath: result.pdfPath,
                manifestPath: result.manifestPath,
                warnings: result.warnings,
                error: result.success ? undefined : "导出未完全成功",
            };
        } catch (error) {
            return {
                conversationId: candidate.id,
                dataChain: candidate.dataChain,
                title: candidate.title,
                workspace: candidate.workspace,
                success: false,
                warnings: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });

    const manifest = {
        status: "complete",
        startedAt,
        exportedAt: new Date().toISOString(),
        request,
        total: items.length,
        succeeded: items.filter(item => item.success).length,
        failed: items.filter(item => !item.success).length,
        sourceStatuses: options.sourceStatuses || [],
        items,
    };
    const manifestPath = path.join(batchDir, "batch_manifest.json");
    writeJsonAtomic(manifestPath, manifest);
    try {
        fs.unlinkSync(pendingManifestPath);
    } catch {
        // pending manifest cleanup is best-effort after final manifest has been written.
    }

    return {
        success: manifest.failed === 0,
        exportDir: batchDir,
        manifestPath,
        total: manifest.total,
        succeeded: manifest.succeeded,
        failed: manifest.failed,
        sourceStatuses: options.sourceStatuses || [],
        items,
    };
}

export function formatConversationBatchExportResult(result: ConversationBatchExportResult): string {
    const lines = [
        `${result.success ? "✅" : "⚠️"} 批量导出完成`,
        `📁 导出目录: ${result.exportDir}`,
        `📄 manifest: ${result.manifestPath}`,
        `📊 结果: ${result.succeeded}/${result.total} 成功，${result.failed} 失败`,
    ];
    if (result.sourceStatuses.length > 0) {
        lines.push("", "🔗 数据源状态:");
        for (const status of result.sourceStatuses) {
            const warnings = status.warnings?.length ? ` | warnings: ${status.warnings.slice(0, 3).join("；")}` : "";
            lines.push(status.status === "ok"
                ? `- ${status.dataChain}: ok (${status.count})${warnings}`
                : `- ${status.dataChain}: failed — ${status.error || "unknown"}${warnings}`);
        }
    }
    lines.push("", "📦 导出项:");
    for (const item of result.items.slice(0, 30)) {
        lines.push(`- ${item.success ? "✅" : "❌"} ${item.dataChain}:${item.conversationId} ${item.title ? `| ${item.title}` : ""}`);
        if (item.exportDir) lines.push(`  目录: ${item.exportDir}`);
        if (item.error) lines.push(`  错误: ${item.error}`);
        for (const warning of item.warnings.slice(0, 3)) lines.push(`  ⚠️ ${warning}`);
    }
    if (result.items.length > 30) lines.push(`... 其余 ${result.items.length - 30} 项见 batch_manifest.json`);
    return lines.join("\n");
}

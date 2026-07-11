import crypto from "node:crypto";
import { callModelResponse } from "./model-bridge.js";
import type { Chain } from "./chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";
import {
    buildMemoryFile,
    mutateWorkspaceIndex,
    parseMemoryFile,
    readMemoryFile,
    syncGlobalIndexForWorkspace,
    type MemoryFrontmatter,
    writeMemoryFile,
} from "./store.js";
import { withToolConcurrency } from "./tool-concurrency.js";

const AUTO_SUMMARY_MODEL = process.env.MEMORY_STORE_AUTOSUMMARY_MODEL || process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL;
const AUTO_SUMMARY_TIMEOUT_MS = Number(process.env.MEMORY_STORE_AUTOSUMMARY_TIMEOUT_MS || "30000");

export interface AutoSummarySnapshot {
    title: string;
    tags: string[];
    updated: string;
    body: string;
    fingerprint: string;
}

export type AutoSummaryWritebackResult = "written" | "stale" | "missing" | "invalid" | "existing";

export function shouldGenerateAutoSummaryForUpdate(input: {
    contentChanged: boolean;
    titleChanged: boolean;
    tagsChanged: boolean;
    existingAutoSummary?: string;
}): boolean {
    return input.contentChanged
        || input.titleChanged
        || input.tagsChanged
        || !input.existingAutoSummary?.trim();
}

function normalizeSnapshotInput(input: {
    title: string;
    tags: string[];
    updated: string;
    body: string;
}): Omit<AutoSummarySnapshot, "fingerprint"> {
    return {
        title: input.title.replace(/\r\n/g, "\n"),
        tags: [...input.tags],
        updated: input.updated.replace(/\r\n/g, "\n"),
        body: input.body.replace(/\r\n/g, "\n").replace(/^\n/u, ""),
    };
}

function buildSnapshotFingerprint(input: Omit<AutoSummarySnapshot, "fingerprint">): string {
    return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function snapshotFromParsedMemory(
    frontmatter: Record<string, unknown>,
    body: string,
    fallbackTitle: string,
    fallbackTags: string[],
): AutoSummarySnapshot {
    return captureAutoSummarySnapshot({
        title: String(frontmatter.title || fallbackTitle),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : fallbackTags,
        updated: String(frontmatter.updated || ""),
        body,
    });
}

export function captureAutoSummarySnapshot(input: {
    title: string;
    tags: string[];
    updated: string;
    body: string;
}): AutoSummarySnapshot {
    const normalized = normalizeSnapshotInput(input);
    return {
        ...normalized,
        fingerprint: buildSnapshotFingerprint(normalized),
    };
}

export async function writeAutoSummaryIfUnchanged(params: {
    hash: string;
    memoryId: string;
    summary: string;
    expectedFingerprint: string;
    fallbackTitle: string;
    fallbackTags: string[];
}): Promise<AutoSummaryWritebackResult> {
    const fileContent = readMemoryFile(params.hash, params.memoryId);
    if (!fileContent) return "missing";

    const parsed = parseMemoryFile(fileContent);
    if (!parsed) return "invalid";

    const currentSnapshot = snapshotFromParsedMemory(
        parsed.frontmatter,
        parsed.body,
        params.fallbackTitle,
        params.fallbackTags,
    );
    if (currentSnapshot.fingerprint !== params.expectedFingerprint) {
        return "stale";
    }

    const existingAutoSummary = typeof parsed.frontmatter.autoSummary === "string"
        ? parsed.frontmatter.autoSummary.trim()
        : "";
    if (existingAutoSummary.length > 0) {
        return "existing";
    }

    const fm = parsed.frontmatter;
    const newFrontmatter: MemoryFrontmatter = {
        id: String(fm.id || params.memoryId),
        title: currentSnapshot.title,
        tags: currentSnapshot.tags,
        category: String(fm.category || "general"),
        created: String(fm.created || new Date().toISOString()),
        updated: String(fm.updated || new Date().toISOString()),
        workspace: String(fm.workspace || "general"),
        conversationId: fm.conversationId ? String(fm.conversationId) : undefined,
        searchSummary: String(fm.searchSummary || ""),
        autoSummary: params.summary,
        pinned: fm.pinned === true ? true : undefined,
    };

    const newContent = buildMemoryFile(newFrontmatter, currentSnapshot.body);
    writeMemoryFile(params.hash, params.memoryId, newContent);

    await mutateWorkspaceIndex(params.hash, (wsIndex) => {
        const indexEntry = wsIndex.entries.find(e => e.id === params.memoryId);
        if (indexEntry) {
            indexEntry.autoSummary = params.summary;
            indexEntry.sizeBytes = Buffer.byteLength(newContent, "utf-8");
        }
    });
    await syncGlobalIndexForWorkspace(params.hash);

    return "written";
}

export async function generateAutoSummary(
    title: string,
    tags: string[],
    content: string,
    chain: Chain = "auto",
): Promise<string | null> {
    const truncatedContent = content.length > 6000
        ? content.slice(0, 6000) + "\n\n[内容已截断]"
        : content;

    const prompt = `请为以下记忆生成一段简洁的中文摘要，用于未来快速理解和检索。

要求：
- 80-150 字
- 概括核心内容、关键决策、技术点或问题解决方案
- 不要重复标题
- 直接输出摘要文本，不要加前缀

标题: ${title}
标签: ${tags.join(", ")}

内容:
${truncatedContent}`;

    const result = await withToolConcurrency(
        "mixed",
        "autoSummary",
        () => callModelResponse(AUTO_SUMMARY_MODEL, prompt, chain, AUTO_SUMMARY_TIMEOUT_MS, { grokContext: "default" }),
    );
    if (result.chainUsed) {
        console.error(`[auto-summary] modelChain=${chain} actualChain=${result.chainUsed} actualModel=${result.modelUsed || "unknown"} grokContext=default`);
    }
    return result.text?.trim() || null;
}

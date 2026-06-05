import crypto from "crypto";
import fs from "fs";
import path from "path";
import { TEMP_DIR, ensureTempDir } from "./temp-store.js";
import type { ConversationRound } from "./trajectory.js";

export type ConversationAttachmentKind = "image" | "file";
export type ConversationAttachmentSource =
    | "codex-data-url"
    | "codex-local-image"
    | "files-mentioned"
    | "antigravity-uri"
    | "claude-code-data-url"
    | "claude-code-local-file"
    | "windsurf-data-url";

export interface ConversationAttachment {
    kind: ConversationAttachmentKind;
    source: ConversationAttachmentSource;
    name?: string;
    mimeType?: string;
    originalPath?: string;
    dataUrl?: string;
    sizeBytes?: number;
    sha256?: string;
    exists?: boolean;
    tempPath?: string;
    warning?: string;
}

export interface AttachmentSummary {
    total: number;
    images: number;
    files: number;
    codexInlineImages: number;
    existingPaths: number;
    missingPaths: number;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MATERIALIZE_LIMIT = 20;
const DEFAULT_MATERIALIZE_CONCURRENCY = 4;

function normalizePathKey(input: string): string {
    return path.normalize(input).toLowerCase();
}

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function estimateBase64Bytes(base64: string): number {
    const clean = base64.replace(/\s+/gu, "");
    if (!clean) return 0;
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function extensionFromMime(mimeType?: string): string {
    switch ((mimeType || "").toLowerCase()) {
        case "image/jpeg":
        case "image/jpg":
            return ".jpg";
        case "image/webp":
            return ".webp";
        case "image/gif":
            return ".gif";
        case "image/bmp":
            return ".bmp";
        case "image/png":
        default:
            return ".png";
    }
}

function isAllowedRasterMime(mimeType: string): boolean {
    return ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/bmp"].includes(mimeType.toLowerCase());
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string; sizeBytes: number } | null {
    const match = /^data:([^;,]+);base64,(.+)$/su.exec(dataUrl.trim());
    if (!match) return null;
    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s+/gu, "");
    return { mimeType, base64, sizeBytes: estimateBase64Bytes(base64) };
}

function safeFileName(input: string): string {
    return input.replace(/[^a-zA-Z0-9\u4e00-\u9fff_.-]/gu, "_").slice(0, 120);
}

function resolveMentionPath(rawPath: string, cwd?: string): string {
    const trimmed = rawPath.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "");
    if (/^[a-zA-Z]:[\\/]/u.test(trimmed) || /^\\\\/u.test(trimmed)) return path.normalize(trimmed);
    return path.normalize(path.resolve(cwd || process.cwd(), trimmed));
}

function isImagePath(filePath: string): boolean {
    return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(path.extname(filePath).toLowerCase());
}

function dedupeAttachments(attachments: ConversationAttachment[]): ConversationAttachment[] {
    const seen = new Set<string>();
    const result: ConversationAttachment[] = [];
    for (const attachment of attachments) {
        const key = attachment.dataUrl
            ? `${attachment.kind}:data:${attachment.dataUrl.slice(0, 160)}:${attachment.dataUrl.length}`
            : `${attachment.kind}:path:${normalizePathKey(attachment.originalPath || attachment.name || "")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(attachment);
    }
    return result;
}

export function extractCodexMessageAttachments(
    content: any[],
    messageText: string,
    options: { cwd?: string } = {},
): ConversationAttachment[] {
    const attachments: ConversationAttachment[] = [];

    for (const item of content || []) {
        const imageUrl = typeof item?.image_url === "string"
            ? item.image_url
            : typeof item?.imageUrl === "string"
                ? item.imageUrl
                : typeof item?.url === "string"
                    ? item.url
                    : "";
        if (item?.type === "input_image" && imageUrl) {
            const parsed = parseDataUrl(imageUrl);
            if (parsed) {
                attachments.push({
                    kind: "image",
                    source: "codex-data-url",
                    mimeType: parsed.mimeType,
                    dataUrl: imageUrl,
                    sizeBytes: parsed.sizeBytes,
                });
            } else {
                const resolved = resolveMentionPath(imageUrl, options.cwd);
                attachments.push({
                    kind: "image",
                    source: "codex-local-image",
                    originalPath: resolved,
                    name: path.basename(resolved),
                    exists: fileExists(resolved),
                });
            }
        }
    }

    attachments.push(...extractFilesMentionedAttachments(messageText, options));
    return dedupeAttachments(attachments);
}

export function extractCodexEventUserAttachments(
    payload: any,
    options: { cwd?: string } = {},
): ConversationAttachment[] {
    const attachments: ConversationAttachment[] = [];
    const localImages = Array.isArray(payload?.local_images) ? payload.local_images : [];
    for (const imagePath of localImages) {
        if (typeof imagePath !== "string" || !imagePath.trim()) continue;
        const resolved = resolveMentionPath(imagePath, options.cwd);
        attachments.push({
            kind: "image",
            source: "codex-local-image",
            originalPath: resolved,
            name: path.basename(resolved),
            exists: fileExists(resolved),
        });
    }

    const images = Array.isArray(payload?.images) ? payload.images : [];
    for (const image of images) {
        const url = typeof image === "string"
            ? image
            : typeof image?.image_url === "string"
                ? image.image_url
                : typeof image?.url === "string"
                    ? image.url
                    : "";
        if (!url) continue;
        const parsed = parseDataUrl(url);
        if (parsed) {
            attachments.push({
                kind: "image",
                source: "codex-data-url",
                mimeType: parsed.mimeType,
                dataUrl: url,
                sizeBytes: parsed.sizeBytes,
            });
        }
    }

    attachments.push(...extractFilesMentionedAttachments(extractPayloadText(payload), options));
    return dedupeAttachments(attachments);
}

function extractPayloadText(payload: any): string {
    if (typeof payload?.message === "string") return payload.message;
    if (typeof payload?.text === "string") return payload.text;
    if (typeof payload?.content === "string") return payload.content;
    if (Array.isArray(payload?.content)) {
        return payload.content
            .map((item: any) => typeof item?.text === "string" ? item.text : "")
            .filter(Boolean)
            .join("\n");
    }
    return "";
}

export function extractFilesMentionedAttachments(
    text: string,
    options: { cwd?: string } = {},
): ConversationAttachment[] {
    const marker = "# Files mentioned by the user:";
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return [];

    const block = text.slice(markerIndex + marker.length);
    const attachments: ConversationAttachment[] = [];
    const linePattern = /^##\s+(.+?)\s*:\s*(.+)$/gmu;
    let match: RegExpExecArray | null;
    while ((match = linePattern.exec(block)) !== null) {
        const displayName = match[1].trim();
        const rawPath = match[2].trim();
        if (/^my request for codex$/iu.test(displayName)) continue;
        if (!rawPath) continue;
        const resolved = resolveMentionPath(rawPath, options.cwd);
        attachments.push({
            kind: isImagePath(resolved) ? "image" : "file",
            source: "files-mentioned",
            name: displayName || path.basename(resolved),
            originalPath: resolved,
            exists: fileExists(resolved),
        });
    }

    return dedupeAttachments(attachments);
}

export function mergeRoundAttachments(round: ConversationRound, attachments: ConversationAttachment[]): void {
    if (attachments.length === 0) return;
    round.attachments = dedupeAttachments([...(round.attachments || []), ...attachments]);
}

async function mapLimit<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

async function materializeAttachment(
    attachment: ConversationAttachment,
    conversationId: string,
    roundIndex: number,
    options: { maxBytes: number; cache: Map<string, ConversationAttachment> },
): Promise<ConversationAttachment> {
    if (
        attachment.kind !== "image" ||
        (attachment.source !== "codex-data-url" && attachment.source !== "claude-code-data-url" && attachment.source !== "windsurf-data-url") ||
        !attachment.dataUrl
    ) {
        return attachment;
    }

    const cached = options.cache.get(attachment.dataUrl);
    if (cached) return { ...attachment, ...cached };

    const parsed = parseDataUrl(attachment.dataUrl);
    if (!parsed) {
        return { ...attachment, warning: "data URL 格式无法解析" };
    }
    if (!isAllowedRasterMime(parsed.mimeType)) {
        return { ...attachment, mimeType: parsed.mimeType, sizeBytes: parsed.sizeBytes, warning: `不支持的图片 MIME: ${parsed.mimeType}` };
    }
    if (parsed.sizeBytes > options.maxBytes) {
        return { ...attachment, mimeType: parsed.mimeType, sizeBytes: parsed.sizeBytes, warning: `超过大小限制 ${options.maxBytes} bytes` };
    }

    const bytes = Buffer.from(parsed.base64, "base64");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const sourceDir = attachment.source === "claude-code-data-url"
        ? "claude-code-attachments"
        : attachment.source === "windsurf-data-url"
            ? "windsurf-attachments"
            : "codex-attachments";
    const dir = path.join(TEMP_DIR, sourceDir, conversationId, `round-${String(roundIndex).padStart(6, "0")}`);
    const filename = `sha256-${sha256}${extensionFromMime(parsed.mimeType)}`;
    const tempPath = path.join(dir, filename);

    ensureTempDir();
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size !== bytes.length) {
        const tmpPath = path.join(dir, `${safeFileName(filename)}.${process.pid}.tmp`);
        fs.writeFileSync(tmpPath, bytes);
        fs.renameSync(tmpPath, tempPath);
    }

    const resolved: ConversationAttachment = {
        ...attachment,
        mimeType: parsed.mimeType,
        sizeBytes: bytes.length,
        sha256,
        tempPath,
        exists: true,
    };
    options.cache.set(attachment.dataUrl, {
        mimeType: resolved.mimeType,
        sizeBytes: resolved.sizeBytes,
        sha256,
        tempPath,
        exists: true,
    } as ConversationAttachment);
    return resolved;
}

export async function materializeRoundAttachments(
    rounds: ConversationRound[],
    conversationId: string,
    options: {
        limit?: number;
        maxBytes?: number;
        maxTotalBytes?: number;
        concurrency?: number;
    } = {},
): Promise<{ rounds: ConversationRound[]; truncated: number }> {
    const limit = Math.max(0, options.limit ?? Number(process.env.MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_LIMIT || DEFAULT_MATERIALIZE_LIMIT));
    const maxBytes = Math.max(1, options.maxBytes ?? Number(process.env.MEMORY_STORE_CODEX_ATTACHMENT_MAX_BYTES || DEFAULT_MAX_ATTACHMENT_BYTES));
    const maxTotalBytes = Math.max(1, options.maxTotalBytes ?? Number(process.env.MEMORY_STORE_CODEX_ATTACHMENT_MAX_TOTAL_BYTES || DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES));
    const concurrency = Math.max(1, options.concurrency ?? Number(process.env.MEMORY_STORE_CODEX_ATTACHMENT_MATERIALIZE_CONCURRENCY || DEFAULT_MATERIALIZE_CONCURRENCY));
    const cache = new Map<string, ConversationAttachment>();
    let remainingTotalBytes = maxTotalBytes;

    let remaining = limit;
    let truncated = 0;
    const cloned = rounds.map(round => ({ ...round, attachments: round.attachments ? [...round.attachments] : undefined }));
    const jobs: Array<{ round: ConversationRound; attachment: ConversationAttachment; index: number }> = [];

    for (const round of cloned) {
        const attachments = round.attachments || [];
        const existingImagePathCount = attachments.filter(attachment =>
            attachment.kind === "image" &&
            attachment.originalPath &&
            attachment.exists !== false
        ).length;
        const dataUrlImageCount = attachments.filter(attachment =>
            attachment.kind === "image" &&
            (attachment.source === "codex-data-url" || attachment.source === "claude-code-data-url" || attachment.source === "windsurf-data-url") &&
            attachment.dataUrl
        ).length;
        let preferLocalRemaining = existingImagePathCount >= dataUrlImageCount ? existingImagePathCount : 0;
        for (let index = 0; index < attachments.length; index++) {
            const attachment = attachments[index];
            if (
                attachment.kind !== "image" ||
                (attachment.source !== "codex-data-url" && attachment.source !== "claude-code-data-url" && attachment.source !== "windsurf-data-url") ||
                !attachment.dataUrl
            ) continue;
            if (preferLocalRemaining > 0) {
                attachments[index] = { ...attachment, warning: "已有本地图片路径，未生成临时文件" };
                preferLocalRemaining -= 1;
                continue;
            }
            const parsed = parseDataUrl(attachment.dataUrl);
            const estimatedBytes = parsed?.sizeBytes || attachment.sizeBytes || 0;
            if (remaining <= 0) {
                attachments[index] = { ...attachment, warning: `超过单次 materialize 数量上限 ${limit}，未生成临时文件` };
                truncated += 1;
                continue;
            }
            if (estimatedBytes > remainingTotalBytes) {
                attachments[index] = { ...attachment, sizeBytes: estimatedBytes, warning: `超过单次 materialize 总大小上限 ${maxTotalBytes} bytes，未生成临时文件` };
                truncated += 1;
                continue;
            }
            remaining -= 1;
            remainingTotalBytes -= estimatedBytes;
            jobs.push({ round, attachment, index });
        }
    }

    const materialized = await mapLimit(jobs, concurrency, async (job) =>
        materializeAttachment(job.attachment, conversationId, job.round.roundIndex, { maxBytes, cache }));

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.round.attachments) job.round.attachments[job.index] = materialized[i];
    }

    return { rounds: cloned, truncated };
}

export function summarizeAttachments(rounds: ConversationRound[]): AttachmentSummary {
    const summary: AttachmentSummary = {
        total: 0,
        images: 0,
        files: 0,
        codexInlineImages: 0,
        existingPaths: 0,
        missingPaths: 0,
    };

    for (const round of rounds) {
        for (const attachment of round.attachments || []) {
            summary.total += 1;
            if (attachment.kind === "image") summary.images += 1;
            if (attachment.kind === "file") summary.files += 1;
            if (attachment.source === "codex-data-url" || attachment.source === "claude-code-data-url" || attachment.source === "windsurf-data-url") summary.codexInlineImages += 1;
            if (attachment.originalPath) {
                if (attachment.exists) summary.existingPaths += 1;
                else summary.missingPaths += 1;
            }
        }
        summary.images += round.mediaAttachments?.length || 0;
        summary.total += round.mediaAttachments?.length || 0;
        summary.existingPaths += round.mediaAttachments?.length || 0;
    }

    return summary;
}

export function formatAttachmentOverview(rounds: ConversationRound[]): string {
    const summary = summarizeAttachments(rounds);
    if (summary.total === 0) return "";
    const parts = [
        `📎 附件概览: 图片 ${summary.images} 张，文件路径引用 ${summary.files} 个`,
        summary.codexInlineImages > 0 ? `内联图片 ${summary.codexInlineImages} 张会在 read/search 命中轮次时按需生成临时文件` : "",
        summary.existingPaths || summary.missingPaths ? `本地路径：${summary.existingPaths} 个存在，${summary.missingPaths} 个当前不可访问` : "",
    ].filter(Boolean);
    return parts.join("\n");
}

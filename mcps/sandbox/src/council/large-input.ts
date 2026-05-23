import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { TEMP_DIR, ensureTempDir } from "../temp-store.js";
import type { CouncilLargeInputArtifact, CouncilLargeInputConfig, CouncilRunParams } from "./types.js";

export const DEFAULT_LARGE_INPUT_CHUNK_SIZE = 24_000;
export const DEFAULT_LARGE_INPUT_OVERLAP = 1_200;
export const DEFAULT_LARGE_INPUT_THRESHOLD_CHARS = 60_000;
export const DEFAULT_LARGE_INPUT_CONTEXT_MAX_CHARS = 24_000;
export const LARGE_INPUT_INDEX_VERSION = 1;

export interface LargeInputChunkOptions {
    chunkSize?: number;
    overlap?: number;
    sourceId?: string;
    maxChunks?: number;
}

export interface LargeInputChunk {
    id: string;
    sourceId: string;
    index: number;
    startChar: number;
    endChar: number;
    charCount: number;
    sha256: string;
    text: string;
    overlapWithPrevious: number;
}

export interface LargeInputRange {
    startChar: number;
    endChar: number;
    charCount: number;
}

export interface LargeInputOverlapInfo extends LargeInputRange {
    leftChunkId: string;
    rightChunkId: string;
    expectedCharCount: number;
    actualCharCount: number;
    ok: boolean;
}

export interface LargeInputChunkCheck {
    chunkId: string;
    index: number;
    startChar: number;
    endChar: number;
    charCount: number;
    sha256: string;
    hashOk: boolean;
    rangeOk: boolean;
}

export interface LargeInputQualityReport {
    version: number;
    sourceId: string;
    sourceCharCount: number;
    sourceSha256: string;
    chunkCount: number;
    chunkSize: number;
    overlap: number;
    coveredCharCount: number;
    duplicatedCharCount: number;
    coverageRatio: number;
    allCovered: boolean;
    ordered: boolean;
    hashesOk: boolean;
    overlapsOk: boolean;
    unreadRanges: LargeInputRange[];
    overlapInfo: LargeInputOverlapInfo[];
    chunkChecks: LargeInputChunkCheck[];
    warnings: string[];
}

export interface LargeInputIndexMarkdownOptions {
    title?: string;
    label?: string;
    includeChunkText?: boolean;
    previewChars?: number;
}

export interface LargeInputArtifactOptions extends LargeInputChunkOptions, LargeInputIndexMarkdownOptions {
    outputDir?: string;
    checkpointName?: string;
    indexName?: string;
}

export interface LargeInputArtifactResult {
    sourceId: string;
    checkpointPath: string;
    indexPath: string;
    sourceTextPath: string;
    chunks: LargeInputChunk[];
    quality: LargeInputQualityReport;
    markdown: string;
}

export interface PreparedLargeInputReference {
    contextText: string;
    artifact: CouncilLargeInputArtifact;
}

type LargeInputChunkCheckpoint = Omit<LargeInputChunk, "text">;

interface NormalizedLargeInputChunkOptions {
    chunkSize: number;
    overlap: number;
    sourceId: string;
    maxChunks?: number;
}

type SegmenterCtor = new (
    locales?: string | string[],
    options?: { granularity?: "grapheme" },
) => {
    segment(input: string): Iterable<{ segment: string }>;
};

function normalizeSourceId(sourceId: string | undefined): string {
    return sourceId?.trim() || "large-input";
}

function assertChunkOptions(options: Required<Pick<LargeInputChunkOptions, "chunkSize" | "overlap">>): void {
    if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0) {
        throw new Error(`chunkSize 必须是正整数，当前为 ${options.chunkSize}`);
    }
    if (!Number.isInteger(options.overlap) || options.overlap < 0) {
        throw new Error(`overlap 必须是非负整数，当前为 ${options.overlap}`);
    }
    if (options.overlap >= options.chunkSize) {
        throw new Error(`overlap 必须小于 chunkSize，当前 overlap=${options.overlap}, chunkSize=${options.chunkSize}`);
    }
}

function normalizeChunkOptions(options: LargeInputChunkOptions = {}): NormalizedLargeInputChunkOptions {
    const normalized = {
        chunkSize: options.chunkSize ?? DEFAULT_LARGE_INPUT_CHUNK_SIZE,
        overlap: options.overlap ?? DEFAULT_LARGE_INPUT_OVERLAP,
        sourceId: normalizeSourceId(options.sourceId),
        maxChunks: options.maxChunks,
    };
    assertChunkOptions(normalized);
    if (normalized.maxChunks !== undefined && (!Number.isInteger(normalized.maxChunks) || normalized.maxChunks <= 0)) {
        throw new Error(`maxChunks 必须是正整数，当前为 ${normalized.maxChunks}`);
    }
    return normalized;
}

export function splitIntoRealCharacters(text: string): string[] {
    const segmenterCtor = (Intl as typeof Intl & { Segmenter?: SegmenterCtor }).Segmenter;
    if (segmenterCtor) {
        const segmenter = new segmenterCtor(undefined, { granularity: "grapheme" });
        return Array.from(segmenter.segment(text), (item) => item.segment);
    }
    return Array.from(text);
}

export function sha256Text(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function chunkLargeInput(text: string, options: LargeInputChunkOptions = {}): LargeInputChunk[] {
    const normalized = normalizeChunkOptions(options);
    const characters = splitIntoRealCharacters(text);
    const chunks: LargeInputChunk[] = [];
    let startChar = 0;

    while (startChar < characters.length) {
        if (normalized.maxChunks !== undefined && chunks.length >= normalized.maxChunks) {
            break;
        }

        const endChar = Math.min(startChar + normalized.chunkSize, characters.length);
        const chunkText = characters.slice(startChar, endChar).join("");
        const previous = chunks.at(-1);
        const overlapWithPrevious = previous ? Math.max(0, previous.endChar - startChar) : 0;
        chunks.push({
            id: `${normalized.sourceId}:chunk-${String(chunks.length + 1).padStart(4, "0")}`,
            sourceId: normalized.sourceId,
            index: chunks.length,
            startChar,
            endChar,
            charCount: endChar - startChar,
            sha256: sha256Text(chunkText),
            text: chunkText,
            overlapWithPrevious,
        });

        if (endChar >= characters.length) {
            break;
        }
        startChar = endChar - normalized.overlap;
    }

    return chunks;
}

function normalizeRanges(ranges: LargeInputRange[]): LargeInputRange[] {
    const sorted = ranges
        .filter((range) => range.endChar > range.startChar)
        .sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar);
    const merged: LargeInputRange[] = [];
    for (const range of sorted) {
        const current = merged.at(-1);
        if (!current || range.startChar > current.endChar) {
            merged.push({ ...range });
        } else if (range.endChar > current.endChar) {
            current.endChar = range.endChar;
            current.charCount = current.endChar - current.startChar;
        }
    }
    return merged;
}

function findUnreadRanges(sourceCharCount: number, coveredRanges: LargeInputRange[]): LargeInputRange[] {
    const unreadRanges: LargeInputRange[] = [];
    let cursor = 0;
    for (const range of coveredRanges) {
        if (range.startChar > cursor) {
            unreadRanges.push({
                startChar: cursor,
                endChar: range.startChar,
                charCount: range.startChar - cursor,
            });
        }
        cursor = Math.max(cursor, range.endChar);
    }
    if (cursor < sourceCharCount) {
        unreadRanges.push({
            startChar: cursor,
            endChar: sourceCharCount,
            charCount: sourceCharCount - cursor,
        });
    }
    return unreadRanges;
}

export function checkLargeInputQuality(text: string, chunks: LargeInputChunk[], options: LargeInputChunkOptions = {}): LargeInputQualityReport {
    const normalized = normalizeChunkOptions(options);
    const sourceId = normalizeSourceId(options.sourceId ?? chunks[0]?.sourceId);
    const characters = splitIntoRealCharacters(text);
    const chunkChecks: LargeInputChunkCheck[] = chunks.map((chunk) => {
        const expectedText = characters.slice(chunk.startChar, chunk.endChar).join("");
        const rangeOk = chunk.startChar >= 0
            && chunk.endChar <= characters.length
            && chunk.endChar >= chunk.startChar
            && chunk.charCount === chunk.endChar - chunk.startChar
            && chunk.text === expectedText;
        return {
            chunkId: chunk.id,
            index: chunk.index,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            charCount: chunk.charCount,
            sha256: chunk.sha256,
            hashOk: chunk.sha256 === sha256Text(chunk.text),
            rangeOk,
        };
    });
    const coveredRanges = normalizeRanges(chunks.map((chunk) => ({
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        charCount: chunk.endChar - chunk.startChar,
    })));
    const coveredCharCount = coveredRanges.reduce((sum, range) => sum + range.charCount, 0);
    const totalChunkChars = chunks.reduce((sum, chunk) => sum + chunk.charCount, 0);
    const unreadRanges = findUnreadRanges(characters.length, coveredRanges);
    const ordered = chunks.every((chunk, index) => {
        const previous = chunks[index - 1];
        return chunk.index === index && (!previous || chunk.startChar >= previous.startChar);
    });
    const overlapInfo = chunks.slice(1).map((chunk, index) => {
        const previous = chunks[index];
        const startChar = Math.max(previous.startChar, chunk.startChar);
        const endChar = Math.min(previous.endChar, chunk.endChar);
        const actualCharCount = Math.max(0, endChar - startChar);
        const expectedCharCount = previous.endChar < characters.length ? normalized.overlap : 0;
        return {
            leftChunkId: previous.id,
            rightChunkId: chunk.id,
            startChar,
            endChar: Math.max(startChar, endChar),
            charCount: actualCharCount,
            expectedCharCount,
            actualCharCount,
            ok: actualCharCount === expectedCharCount && chunk.overlapWithPrevious === actualCharCount,
        };
    });
    const warnings: string[] = [];
    if (unreadRanges.length > 0) {
        warnings.push(`存在 ${unreadRanges.length} 个未读范围，共 ${unreadRanges.reduce((sum, range) => sum + range.charCount, 0)} 字符`);
    }
    if (!ordered) {
        warnings.push("chunk 顺序或 index 不连续");
    }
    if (chunkChecks.some((check) => !check.hashOk)) {
        warnings.push("至少一个 chunk 的 sha256 与正文不匹配");
    }
    if (chunkChecks.some((check) => !check.rangeOk)) {
        warnings.push("至少一个 chunk 的字符范围与正文切片不匹配");
    }
    if (overlapInfo.some((info) => !info.ok)) {
        warnings.push("至少一个相邻 chunk 的 overlap 不符合预期");
    }

    return {
        version: LARGE_INPUT_INDEX_VERSION,
        sourceId,
        sourceCharCount: characters.length,
        sourceSha256: sha256Text(text),
        chunkCount: chunks.length,
        chunkSize: normalized.chunkSize,
        overlap: normalized.overlap,
        coveredCharCount,
        duplicatedCharCount: totalChunkChars - coveredCharCount,
        coverageRatio: characters.length === 0 ? 1 : coveredCharCount / characters.length,
        allCovered: unreadRanges.length === 0,
        ordered,
        hashesOk: chunkChecks.every((check) => check.hashOk && check.rangeOk),
        overlapsOk: overlapInfo.every((info) => info.ok),
        unreadRanges,
        overlapInfo,
        chunkChecks,
        warnings,
    };
}

function safeFilename(input: string): string {
    return input.replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 80) || "large-input";
}

function timestamp(): string {
    const now = new Date();
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
        String(now.getMilliseconds()).padStart(3, "0"),
    ].join("");
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

function envNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeRuntimeConfig(config: CouncilLargeInputConfig = {}): Required<Omit<CouncilLargeInputConfig, "maxChunks">> & Pick<CouncilLargeInputConfig, "maxChunks"> {
    const normalized = {
        enabled: config.enabled ?? process.env.SANDBOX_COUNCIL_LARGE_INPUT_ENABLED !== "0",
        thresholdChars: config.thresholdChars ?? envNumber("SANDBOX_COUNCIL_LARGE_INPUT_THRESHOLD_CHARS", DEFAULT_LARGE_INPUT_THRESHOLD_CHARS),
        chunkSize: config.chunkSize ?? envNumber("SANDBOX_COUNCIL_LARGE_INPUT_CHUNK_CHARS", DEFAULT_LARGE_INPUT_CHUNK_SIZE),
        overlap: config.overlap ?? envNumber("SANDBOX_COUNCIL_LARGE_INPUT_OVERLAP_CHARS", DEFAULT_LARGE_INPUT_OVERLAP),
        maxChunks: config.maxChunks,
        previewChars: config.previewChars ?? envNumber("SANDBOX_COUNCIL_LARGE_INPUT_PREVIEW_CHARS", 600),
        contextMaxChars: config.contextMaxChars ?? envNumber("SANDBOX_COUNCIL_LARGE_INPUT_INDEX_CONTEXT_CHARS", DEFAULT_LARGE_INPUT_CONTEXT_MAX_CHARS),
        includeChunkText: config.includeChunkText ?? process.env.SANDBOX_COUNCIL_LARGE_INPUT_INCLUDE_CHUNK_TEXT === "1",
    };
    assertChunkOptions({ chunkSize: normalized.chunkSize, overlap: normalized.overlap });
    return normalized;
}

function clipForContext(text: string, maxChars: number): string {
    const characters = splitIntoRealCharacters(text);
    if (characters.length <= maxChars) return text;
    return `${characters.slice(0, maxChars).join("")}\n\n... (LargeInputIndex clipped ${characters.length - maxChars} chars; full index is in the temp artifact path above)`;
}

export function shouldCreateLargeInputIndex(text: string, config: CouncilLargeInputConfig = {}): boolean {
    const enabled = config.enabled ?? process.env.SANDBOX_COUNCIL_LARGE_INPUT_ENABLED !== "0";
    if (!enabled) return false;
    const normalized = normalizeRuntimeConfig(config);
    return splitIntoRealCharacters(text).length > normalized.thresholdChars;
}

function formatRanges(ranges: LargeInputRange[]): string {
    if (ranges.length === 0) return "none";
    return ranges.map((range) => `${range.startChar}-${range.endChar} (${range.charCount})`).join(", ");
}

function previewText(text: string, previewChars: number): string {
    const characters = splitIntoRealCharacters(text);
    if (characters.length <= previewChars) return text;
    return `${characters.slice(0, previewChars).join("")}\n… clipped ${characters.length - previewChars} chars`;
}

export function buildLargeInputIndexMarkdown(
    input: {
        sourceId: string;
        text: string;
        chunks: LargeInputChunk[];
        quality: LargeInputQualityReport;
    },
    options: LargeInputIndexMarkdownOptions = {},
): string {
    const title = options.title || "LargeInputIndex";
    const previewChars = options.previewChars ?? 600;
    const lines = [
        `# ${title}`,
        "",
        `- Version: ${LARGE_INPUT_INDEX_VERSION}`,
        `- Source: ${input.sourceId}`,
        options.label ? `- Label: ${options.label}` : undefined,
        `- Source characters: ${input.quality.sourceCharCount}`,
        `- Source sha256: \`${input.quality.sourceSha256}\``,
        `- Chunk count: ${input.quality.chunkCount}`,
        `- Chunk size: ${input.quality.chunkSize}`,
        `- Overlap: ${input.quality.overlap}`,
        "",
        "## Quality",
        "",
        `- Coverage: ${input.quality.coveredCharCount}/${input.quality.sourceCharCount} (${formatPercent(input.quality.coverageRatio)})`,
        `- Duplicated overlap characters: ${input.quality.duplicatedCharCount}`,
        `- All covered: ${input.quality.allCovered ? "yes" : "no"}`,
        `- Hashes ok: ${input.quality.hashesOk ? "yes" : "no"}`,
        `- Overlaps ok: ${input.quality.overlapsOk ? "yes" : "no"}`,
        `- Ordered: ${input.quality.ordered ? "yes" : "no"}`,
        `- Unread ranges: ${formatRanges(input.quality.unreadRanges)}`,
        "",
        "## Overlaps",
        "",
        input.quality.overlapInfo.length === 0
            ? "- none"
            : input.quality.overlapInfo.map((info) => `- ${info.leftChunkId} -> ${info.rightChunkId}: ${info.actualCharCount}/${info.expectedCharCount} chars, range ${info.startChar}-${info.endChar}, ok=${info.ok}`).join("\n"),
        "",
        "## Warnings",
        "",
        input.quality.warnings.length === 0
            ? "- none"
            : input.quality.warnings.map((warning) => `- ${warning}`).join("\n"),
        "",
        "## Chunks",
        "",
    ].filter((line): line is string => line !== undefined);

    for (const chunk of input.chunks) {
        lines.push(
            `### ${chunk.id}`,
            "",
            `- Index: ${chunk.index}`,
            `- Range: ${chunk.startChar}-${chunk.endChar}`,
            `- Characters: ${chunk.charCount}`,
            `- Sha256: \`${chunk.sha256}\``,
            `- Overlap with previous: ${chunk.overlapWithPrevious}`,
            "",
        );
        if (options.includeChunkText) {
            lines.push("```text", chunk.text, "```", "");
        } else {
            lines.push("```text", previewText(chunk.text, previewChars), "```", "");
        }
    }

    return lines.join("\n");
}

export async function writeLargeInputArtifacts(text: string, options: LargeInputArtifactOptions = {}): Promise<LargeInputArtifactResult> {
    const normalized = normalizeChunkOptions(options);
    const sourceId = normalizeSourceId(normalized.sourceId);
    const chunks = chunkLargeInput(text, normalized);
    const quality = checkLargeInputQuality(text, chunks, normalized);
    const markdown = buildLargeInputIndexMarkdown({ sourceId, text, chunks, quality }, options);
    const outputDir = options.outputDir ?? path.join(TEMP_DIR, "council-large-input");
    ensureTempDir();
    await fs.mkdir(outputDir, { recursive: true });

    const baseName = safeFilename(sourceId);
    const stamp = timestamp();
    const checkpointPath = path.join(outputDir, options.checkpointName ?? `${baseName}_${stamp}.checkpoint.json`);
    const indexPath = path.join(outputDir, options.indexName ?? `${baseName}_${stamp}.LargeInputIndex.md`);
    const sourceTextPath = path.join(outputDir, `${baseName}_${stamp}.source.txt`);
    const checkpointChunks: LargeInputChunkCheckpoint[] = chunks.map(({ text: _text, ...chunk }) => chunk);
    await fs.writeFile(sourceTextPath, text, "utf8");
    await fs.writeFile(checkpointPath, JSON.stringify({
        version: LARGE_INPUT_INDEX_VERSION,
        createdAt: new Date().toISOString(),
        sourceId,
        sourceSha256: quality.sourceSha256,
        sourceCharCount: quality.sourceCharCount,
        sourceTextPath,
        chunkOptions: {
            chunkSize: normalized.chunkSize,
            overlap: normalized.overlap,
            maxChunks: normalized.maxChunks,
        },
        chunks: checkpointChunks,
        quality,
        indexPath,
    }, null, 2), "utf8");
    await fs.writeFile(indexPath, markdown, "utf8");

    return {
        sourceId,
        checkpointPath,
        indexPath,
        sourceTextPath,
        chunks,
        quality,
        markdown,
    };
}

export async function createLargeInputIndex(text: string, options: LargeInputArtifactOptions = {}): Promise<LargeInputArtifactResult> {
    return writeLargeInputArtifacts(text, options);
}

export async function prepareLargeInputReference(input: {
    text: string;
    sourceId: string;
    sourceKind: CouncilLargeInputArtifact["sourceKind"];
    label?: string;
    sourcePath?: string;
    config?: CouncilLargeInputConfig;
}): Promise<PreparedLargeInputReference> {
    const config = normalizeRuntimeConfig(input.config);
    const result = await writeLargeInputArtifacts(input.text, {
        sourceId: input.sourceId,
        title: `sandbox_council LargeInputIndex: ${input.label || input.sourceId}`,
        label: input.label,
        chunkSize: config.chunkSize,
        overlap: config.overlap,
        maxChunks: config.maxChunks,
        previewChars: config.previewChars,
        includeChunkText: config.includeChunkText,
        outputDir: path.join(TEMP_DIR, "council-large-inputs"),
    });
    const artifact: CouncilLargeInputArtifact = {
        id: result.sourceId,
        label: input.label,
        sourceKind: input.sourceKind,
        sourcePath: input.sourcePath,
        sourceCharCount: result.quality.sourceCharCount,
        sourceSha256: result.quality.sourceSha256,
        chunkCount: result.quality.chunkCount,
        chunkSize: result.quality.chunkSize,
        overlap: result.quality.overlap,
        duplicatedCharCount: result.quality.duplicatedCharCount,
        coverageRatio: result.quality.coverageRatio,
        checkpointPath: result.checkpointPath,
        indexPath: result.indexPath,
        sourceTextPath: result.sourceTextPath,
        warnings: result.quality.warnings.length > 0 ? result.quality.warnings : undefined,
    };
    const contextText = [
        `# 大输入索引：${input.label || input.sourceId}`,
        "",
        "原始内容超过 sandbox_council 的安全上下文阈值，已写入临时文件并按真实字符分块；相邻 chunk 带固定重叠区，避免边界处语义断裂。",
        "",
        `- sourceKind: ${input.sourceKind}`,
        input.sourcePath ? `- sourcePath: ${input.sourcePath}` : undefined,
        `- sourceCharacters: ${artifact.sourceCharCount}`,
        `- sourceSha256: ${artifact.sourceSha256}`,
        `- chunkCount: ${artifact.chunkCount}`,
        `- chunkSize: ${artifact.chunkSize}`,
        `- overlap: ${artifact.overlap}`,
        `- duplicatedOverlapCharacters: ${artifact.duplicatedCharCount}`,
        `- coverageRatio: ${formatPercent(artifact.coverageRatio)}`,
        `- sourceTextPath: ${artifact.sourceTextPath}`,
        `- checkpointPath: ${artifact.checkpointPath}`,
        `- indexPath: ${artifact.indexPath}`,
        "",
        "## LargeInputIndex 摘录",
        "",
        clipForContext(result.markdown, config.contextMaxChars),
    ].filter((line): line is string => line !== undefined).join("\n");
    return { contextText, artifact };
}

export async function prepareCouncilLargeInputs(params: CouncilRunParams): Promise<{ params: CouncilRunParams; largeInputs: CouncilLargeInputArtifact[] }> {
    const largeInputs: CouncilLargeInputArtifact[] = [];
    let input = params.input;
    let manualContext = params.manualContext;

    if (shouldCreateLargeInputIndex(input, params.largeInput)) {
        const prepared = await prepareLargeInputReference({
            text: input,
            sourceId: `input_${sha256Text(input).slice(0, 12)}`,
            sourceKind: "input",
            label: "用户输入",
            config: params.largeInput,
        });
        input = prepared.contextText;
        largeInputs.push(prepared.artifact);
    }

    if (manualContext && shouldCreateLargeInputIndex(manualContext, params.largeInput)) {
        const prepared = await prepareLargeInputReference({
            text: manualContext,
            sourceId: `manualContext_${sha256Text(manualContext).slice(0, 12)}`,
            sourceKind: "manualContext",
            label: "手动上下文",
            config: params.largeInput,
        });
        manualContext = prepared.contextText;
        largeInputs.push(prepared.artifact);
    }

    if (largeInputs.length === 0) {
        return { params, largeInputs };
    }
    return {
        params: {
            ...params,
            input,
            manualContext,
        },
        largeInputs,
    };
}

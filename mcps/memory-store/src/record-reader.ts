import crypto from "crypto";

export const RECORD_READER_VERSION = 1;
export const RECORD_READER_PARSER_VERSION = "plan12-reader-v1";

export const RECORD_SECTION_TYPES = [
    "header",
    "phase_title",
    "user_ops",
    "ai_actions",
    "decisions",
    "outputs",
    "verification",
    "risks",
    "lessons",
    "status",
    "tail",
    "tags",
    "unknown",
] as const;

export type RecordSectionType = typeof RECORD_SECTION_TYPES[number];
export type RecordReaderView = "raw" | "outline" | "state" | "outputs" | "lessons" | "risks" | "verification" | "phase" | "custom";
export type RecordReaderIndexMode = "auto" | "reuse" | "rebuild" | "off";

export interface TextRange {
    start: number;
    end: number;
}

export interface ReaderBlock {
    id: string;
    blockId: string;
    kind: "header" | "phase" | "tail" | "block";
    phaseId?: string;
    sectionType: RecordSectionType;
    title?: string;
    heading?: string;
    text: string;
    lineRange: TextRange;
    charRange: TextRange;
    lineStart: number;
    lineEnd: number;
    charStart: number;
    charEnd: number;
    textPreview: string;
}

export interface ReaderPhase {
    id: string;
    phaseId: number;
    phaseIndex: number;
    title: string;
    roundStart?: number;
    roundEnd?: number;
    titleLine: number;
    lineRange: TextRange;
    charRange: TextRange;
    lineStart: number;
    lineEnd: number;
    charStart: number;
    charEnd: number;
    blockIds: string[];
    textPreview: string;
}

export interface ReaderAggregateItem {
    text: string;
    blockId: string;
    phaseId?: string;
    sectionType: RecordSectionType;
    lineRange: TextRange;
    charRange: TextRange;
}

export interface ReaderAggregates {
    outputs: ReaderAggregateItem[];
    producedFiles: ReaderAggregateItem[];
    lessons: ReaderAggregateItem[];
    risks: ReaderAggregateItem[];
    status: ReaderAggregateItem[];
    currentStatus: ReaderAggregateItem[];
    verification: ReaderAggregateItem[];
    decisions: ReaderAggregateItem[];
}

export interface RecordReaderCommitArtifactIdentity {
    conversationId: string;
    recordId: string;
    commitId: string;
    coveredRevision: string;
    bodyHash: string;
    recordCommitEpoch: number;
}

export interface RecordReaderCommitArtifact {
    identity: RecordReaderCommitArtifactIdentity;
    readerIndex: {
        commitId: string;
        bodyHash: string;
        coveredRevision: string;
        conversationId: string;
        recordId: string;
    };
}

export interface RecordReaderIndex {
    version: number;
    parserVersion: string;
    recordId: string;
    sourceHash: string;
    sourceSizeBytes: number;
    generatedAt: string;
    title?: string;
    totalRounds?: number;
    totalSteps?: number;
    totalLines: number;
    totalChars: number;
    phases: ReaderPhase[];
    blocks: ReaderBlock[];
    aggregates: ReaderAggregates;
    warnings: string[];
    commitArtifact?: RecordReaderCommitArtifact;
}

export interface SelectReaderBlocksOptions {
    view?: RecordReaderView;
    phaseIds?: Array<string | number>;
    sectionTypes?: RecordSectionType[];
    include?: RecordSectionType[];
    exclude?: RecordSectionType[];
    startBlockId?: string;
}

export interface FormatReaderViewOptions extends SelectReaderBlocksOptions {
    maxChars?: number;
    format?: "text" | "json";
    withCitations?: boolean;
}

export interface BuildRecordReaderIndexOptions {
    generatedAt?: string;
}

export function hashRecordSource(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function calculateRecordSourceHash(content: string): string {
    return hashRecordSource(normalizeText(content));
}

export function isRecordReaderIndexStale(index: Pick<RecordReaderIndex, "sourceHash">, content: string): boolean {
    return index.sourceHash !== calculateRecordSourceHash(content);
}

export function isRecordReaderIndexFresh(index: Pick<RecordReaderIndex, "sourceHash">, content: string): boolean {
    return !isRecordReaderIndexStale(index, content);
}

function lineOffsets(content: string): number[] {
    const offsets = [0];
    for (let index = 0; index < content.length; index++) {
        if (content[index] === "\n") offsets.push(index + 1);
    }
    return offsets;
}

function lineStart(offsets: number[], lineNumber: number): number {
    return offsets[Math.max(0, lineNumber - 1)] ?? 0;
}

function lineEnd(lines: string[], offsets: number[], lineNumber: number): number {
    const start = lineStart(offsets, lineNumber);
    const line = lines[lineNumber - 1] ?? "";
    return start + line.length;
}

function normalizeText(input: string): string {
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parsePhaseHeading(line: string): { title: string; phaseIndex?: number; roundStart?: number; roundEnd?: number } | null {
    const match = line.match(/^##\s*Phase\s*(\d+)?\s*[：:\-—]?\s*(.*)$/iu);
    if (!match) return null;
    const rest = match[2]?.trim() || `Phase ${match[1] || ""}`.trim();
    const roundMatch = rest.match(/(?:轮次?|rounds?)\s*(\d+)\s*(?:-|—|~|至|到)\s*(\d+)/iu);
    const title = rest
        .replace(/[（(]\s*(?:轮次?|rounds?)\s*\d+\s*(?:-|—|~|至|到)\s*\d+\s*[）)]/giu, "")
        .replace(/^[:：\-—]\s*/u, "")
        .trim();
    return {
        title: title || rest || line.replace(/^##\s*/u, "").trim(),
        phaseIndex: match[1] ? Number(match[1]) : undefined,
        roundStart: roundMatch ? Number(roundMatch[1]) : undefined,
        roundEnd: roundMatch ? Number(roundMatch[2]) : undefined,
    };
}

function classifySection(title: string, text = ""): RecordSectionType {
    const titleSample = title.toLowerCase();
    if (/标签|tags?/iu.test(titleSample)) return "tags";
    if (/用户操作|用户反馈|用户要求|用户输入|user/iu.test(titleSample)) return "user_ops";
    if (/ai\s*执行|执行内容|修复内容|实现内容|处理过程|操作记录|assistant/iu.test(titleSample)) return "ai_actions";
    if (/关键决策|设计结论|固化原则|决策|decision/iu.test(titleSample)) return "decisions";
    if (/产出文件|修改文件|输出文件|文件总清单|files?|outputs?/iu.test(titleSample)) return "outputs";
    if (/当前状态|后续状态|未完成|下一步|status|state|todo/iu.test(titleSample)) return "status";
    if (/经验教训|learnings?|lesson/iu.test(titleSample)) return "lessons";
    if (/风险|阻塞|问题|后续建议|注意|risk|blocker/iu.test(titleSample)) return "risks";
    if (/验证|测试|guard|构建|build|test/iu.test(titleSample)) return "verification";

    const sample = `${title}\n${text}`.toLowerCase();
    if (/标签|tags?/iu.test(sample)) return "tags";
    if (/用户操作|用户反馈|用户要求|用户输入|user/iu.test(sample)) return "user_ops";
    if (/ai\s*执行|执行内容|修复内容|实现内容|处理过程|操作记录|assistant/iu.test(sample)) return "ai_actions";
    if (/关键决策|设计结论|固化原则|决策|decision/iu.test(sample)) return "decisions";
    if (/产出文件|修改文件|输出文件|文件总清单|files?|outputs?/iu.test(sample)) return "outputs";
    if (/经验教训|learnings?|lesson/iu.test(sample)) return "lessons";
    if (/当前状态|后续状态|未完成|下一步|status|state|todo/iu.test(sample)) return "status";
    if (/风险|阻塞|问题|后续建议|注意|risk|blocker/iu.test(sample)) return "risks";
    if (/验证|测试|guard|构建|build|test/iu.test(sample)) return "verification";
    return "unknown";
}

function emptyAggregates(): ReaderAggregates {
    const outputs: ReaderAggregateItem[] = [];
    const status: ReaderAggregateItem[] = [];
    return { outputs, producedFiles: outputs, lessons: [], risks: [], status, currentStatus: status, verification: [], decisions: [] };
}

function addAggregate(aggregates: ReaderAggregates, block: ReaderBlock): void {
    if (block.sectionType === "outputs") aggregates.outputs.push(toAggregateItem(block));
    if (block.sectionType === "lessons") aggregates.lessons.push(toAggregateItem(block));
    if (block.sectionType === "risks") aggregates.risks.push(toAggregateItem(block));
    if (block.sectionType === "status") aggregates.status.push(toAggregateItem(block));
    if (block.sectionType === "verification") aggregates.verification.push(toAggregateItem(block));
    if (block.sectionType === "decisions") aggregates.decisions.push(toAggregateItem(block));
}

function toAggregateItem(block: ReaderBlock): ReaderAggregateItem {
    return {
        text: block.text.trim().slice(0, 1200),
        blockId: block.id,
        phaseId: block.phaseId,
        sectionType: block.sectionType,
        lineRange: block.lineRange,
        charRange: block.charRange,
    };
}

function makeBlock(
    id: string,
    sectionType: RecordSectionType,
    lines: string[],
    offsets: number[],
    startLine: number,
    endLine: number,
    phaseId?: string,
    title?: string,
): ReaderBlock {
    const safeStart = Math.max(1, startLine);
    const safeEnd = Math.max(safeStart, endLine);
    const charStart = lineStart(offsets, safeStart);
    const charEnd = lineEnd(lines, offsets, safeEnd);
    const text = lines.slice(safeStart - 1, safeEnd).join("\n");
    const kind = sectionType === "header" ? "header" : sectionType === "phase_title" ? "phase" : phaseId ? "block" : "tail";
    return {
        id,
        blockId: id,
        kind,
        phaseId,
        sectionType,
        title,
        heading: title,
        text,
        lineRange: { start: safeStart, end: safeEnd },
        charRange: { start: charStart, end: charEnd },
        lineStart: safeStart,
        lineEnd: safeEnd,
        charStart,
        charEnd,
        textPreview: compactPreview(text),
    };
}

function findSectionStarts(lines: string[], startLine: number, endLine: number): number[] {
    const starts: number[] = [];
    let inCode = false;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        const line = lines[lineNumber - 1] || "";
        if (/^\s*```/u.test(line)) inCode = !inCode;
        if (inCode) continue;
        if (/^###\s+/u.test(line)) {
            starts.push(lineNumber);
            continue;
        }
        const bulletTitle = parseBulletSectionTitle(line);
        if (bulletTitle && classifySection(bulletTitle) !== "unknown") starts.push(lineNumber);
    }
    return starts;
}

function parseBulletSectionTitle(line: string): string | undefined {
    const match = line.match(/^\s*[-*]\s+(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[：:]/u);
    return match?.[1]?.trim();
}

function parseSectionTitle(line: string): string {
    return line.replace(/^###\s*/u, "").replace(/^\s*[-*]\s+/u, "").replace(/\s*[：:].*$/u, "").replace(/\*\*/gu, "").trim();
}

function compactPreview(text: string): string {
    const compact = text.replace(/\s+/gu, " ").trim();
    return compact.length > 220 ? `${compact.slice(0, 219)}…` : compact;
}

function extractTopTitle(lines: string[]): string | undefined {
    for (const line of lines) {
        const match = line.match(/^#(?!#)\s+(.+?)\s*$/u);
        if (match) return match[1].trim();
    }
    return undefined;
}

function extractNumberMeta(content: string, label: string): number | undefined {
    const match = new RegExp(`${label}\\s*[：:]\\s*(\\d+)`, "iu").exec(content);
    return match ? Number(match[1]) : undefined;
}

export function buildRecordReaderIndex(recordId: string, content: string, options: BuildRecordReaderIndexOptions = {}): RecordReaderIndex {
    const normalized = normalizeText(content);
    const lines = normalized.split("\n");
    const offsets = lineOffsets(normalized);
    const warnings: string[] = [];
    const markers: Array<{ type: "phase" | "tail"; line: number; phase?: ReturnType<typeof parsePhaseHeading>; title?: string; level?: number }> = [];
    let inCode = false;
    let tailHeadingLevel: number | undefined;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (/^\s*```/u.test(line)) {
            inCode = !inCode;
            continue;
        }
        if (inCode) continue;
        const phase = parsePhaseHeading(line);
        if (phase) {
            markers.push({ type: "phase", line: index + 1, phase });
            continue;
        }
        if (markers.some(marker => marker.type === "phase")) {
            const heading = line.match(/^(#{1,2})(?!#)\s+(.+?)\s*$/u);
            if (!heading) continue;
            const level = heading[1].length;
            if (tailHeadingLevel === undefined || level <= tailHeadingLevel) {
                tailHeadingLevel = level;
                markers.push({ type: "tail", line: index + 1, title: heading[2].trim(), level });
            }
        }
    }

    if (!markers.some(marker => marker.type === "phase")) {
        warnings.push("未识别到 Phase 标题，索引仅包含 header block");
    }

    const blocks: ReaderBlock[] = [];
    const phases: ReaderPhase[] = [];
    const aggregates = emptyAggregates();
    const firstMarkerLine = markers[0]?.line ?? lines.length + 1;
    if (firstMarkerLine > 1) {
        const header = makeBlock("header-1", "header", lines, offsets, 1, firstMarkerLine - 1, undefined, "Header");
        blocks.push(header);
    }

    for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
        const marker = markers[markerIndex];
        const nextLine = markers[markerIndex + 1]?.line ?? (lines.length + 1);
        const endLine = Math.max(marker.line, nextLine - 1);

        if (marker.type === "tail") {
            const type = classifySection(marker.title || "", lines.slice(marker.line, endLine).join("\n"));
            const block = makeBlock(`tail-${blocks.length + 1}`, type, lines, offsets, marker.line, endLine, undefined, marker.title);
            blocks.push(block);
            addAggregate(aggregates, block);
            continue;
        }

        const phaseInfo = marker.phase!;
        const phaseIndex = phaseInfo.phaseIndex ?? phases.length + 1;
        const phaseId = `phase-${phaseIndex}`;
        const phaseBlocks: string[] = [];
        const titleBlock = makeBlock(`${phaseId}-title`, "phase_title", lines, offsets, marker.line, marker.line, phaseId, phaseInfo.title);
        blocks.push(titleBlock);
        phaseBlocks.push(titleBlock.id);

        const bodyStart = marker.line + 1;
        if (bodyStart <= endLine) {
            const sectionStarts = findSectionStarts(lines, bodyStart, endLine);
            if (sectionStarts.length === 0) {
                const text = lines.slice(bodyStart - 1, endLine).join("\n");
                const type = classifySection("", text);
                const block = makeBlock(`${phaseId}-block-1`, type, lines, offsets, bodyStart, endLine, phaseId);
                blocks.push(block);
                phaseBlocks.push(block.id);
                addAggregate(aggregates, block);
            } else {
                if (sectionStarts[0] > bodyStart) {
                    const text = lines.slice(bodyStart - 1, sectionStarts[0] - 1).join("\n");
                    const type = classifySection("", text);
                    const block = makeBlock(`${phaseId}-block-1`, type, lines, offsets, bodyStart, sectionStarts[0] - 1, phaseId);
                    blocks.push(block);
                    phaseBlocks.push(block.id);
                    addAggregate(aggregates, block);
                }
                for (let sectionIndex = 0; sectionIndex < sectionStarts.length; sectionIndex++) {
                    const start = sectionStarts[sectionIndex];
                    const sectionEnd = (sectionStarts[sectionIndex + 1] ?? (endLine + 1)) - 1;
                    const title = parseSectionTitle(lines[start - 1] || "");
                    const text = lines.slice(start, sectionEnd).join("\n");
                    const type = classifySection(title, text);
                    const block = makeBlock(`${phaseId}-block-${sectionIndex + 2}`, type, lines, offsets, start, sectionEnd, phaseId, title);
                    blocks.push(block);
                    phaseBlocks.push(block.id);
                    addAggregate(aggregates, block);
                }
            }
        }

        phases.push({
            id: phaseId,
            phaseId: phaseIndex,
            phaseIndex,
            title: phaseInfo.title,
            roundStart: phaseInfo.roundStart,
            roundEnd: phaseInfo.roundEnd,
            titleLine: marker.line,
            lineRange: { start: marker.line, end: endLine },
            charRange: { start: lineStart(offsets, marker.line), end: lineEnd(lines, offsets, endLine) },
            lineStart: marker.line,
            lineEnd: endLine,
            charStart: lineStart(offsets, marker.line),
            charEnd: lineEnd(lines, offsets, endLine),
            blockIds: phaseBlocks,
            textPreview: compactPreview(lines.slice(marker.line - 1, endLine).join("\n")),
        });
    }

    return {
        version: RECORD_READER_VERSION,
        parserVersion: RECORD_READER_PARSER_VERSION,
        recordId,
        sourceHash: hashRecordSource(normalized),
        sourceSizeBytes: Buffer.byteLength(normalized, "utf8"),
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        title: extractTopTitle(lines),
        totalRounds: extractNumberMeta(normalized, "总轮次"),
        totalSteps: extractNumberMeta(normalized, "总\\s*steps") ?? extractNumberMeta(normalized, "总步骤"),
        totalLines: lines.length,
        totalChars: normalized.length,
        phases,
        blocks,
        aggregates,
        warnings,
    };
}

function typesForView(view?: RecordReaderView): RecordSectionType[] | null {
    if (!view || view === "raw" || view === "outline" || view === "phase" || view === "custom") return null;
    if (view === "state") return ["status", "risks"];
    if (view === "outputs") return ["outputs"];
    if (view === "lessons") return ["lessons"];
    if (view === "risks") return ["risks"];
    if (view === "verification") return ["verification"];
    return null;
}

export function selectReaderBlocks(index: RecordReaderIndex, options: SelectReaderBlocksOptions = {}): ReaderBlock[] {
    let blocks = [...index.blocks];
    if (options.phaseIds && options.phaseIds.length > 0) {
        blocks = blocks.filter(block => block.phaseId && phaseIdMatches(block.phaseId, options.phaseIds!));
    }
    const viewTypes = typesForView(options.view);
    const wantedTypes = options.sectionTypes || options.include || viewTypes;
    if (wantedTypes && wantedTypes.length > 0) {
        blocks = blocks.filter(block => wantedTypes.includes(block.sectionType));
    }
    if (options.exclude && options.exclude.length > 0) {
        blocks = blocks.filter(block => !options.exclude!.includes(block.sectionType));
    }
    if (isReverseChronologicalView(options.view)) {
        blocks = blocks.sort((left, right) => right.lineRange.start - left.lineRange.start);
    }
    if (options.startBlockId) {
        const startIndex = blocks.findIndex(block => block.id === options.startBlockId || block.blockId === options.startBlockId);
        blocks = startIndex >= 0 ? blocks.slice(startIndex) : [];
    }
    return blocks;
}

function isReverseChronologicalView(view?: RecordReaderView): boolean {
    return view === "state" || view === "risks" || view === "lessons" || view === "verification";
}

function phaseIdMatches(blockPhaseId: string, requestedPhaseIds: Array<string | number>): boolean {
    const numericPhaseId = Number(blockPhaseId.replace(/^phase-/u, ""));
    return requestedPhaseIds.some(requested => requested === blockPhaseId || requested === numericPhaseId || String(requested) === blockPhaseId);
}

export function buildOutline(index: RecordReaderIndex) {
    return {
        recordId: index.recordId,
        sourceHash: index.sourceHash,
        parserVersion: index.parserVersion,
        totalLines: index.totalLines,
        totalChars: index.totalChars,
        sourceSizeBytes: index.sourceSizeBytes,
        title: index.title,
        totalRounds: index.totalRounds,
        totalSteps: index.totalSteps,
        phaseCount: index.phases.length,
        blockCount: index.blocks.length,
        phases: index.phases.map(phase => ({
            id: phase.id,
            phaseId: phase.phaseId,
            title: phase.title,
            rounds: phase.roundStart !== undefined && phase.roundEnd !== undefined ? `${phase.roundStart}-${phase.roundEnd}` : undefined,
            lineRange: phase.lineRange,
            blockCount: phase.blockIds.length,
        })),
        sectionStats: index.blocks.reduce((stats, block) => {
            stats[block.sectionType] = (stats[block.sectionType] ?? 0) + 1;
            return stats;
        }, {} as Partial<Record<RecordSectionType, number>>),
        warnings: index.warnings,
    };
}

export function createRecordReaderOutline(index: RecordReaderIndex) {
    return buildOutline(index);
}

export interface SelectRecordReaderBlocksResult {
    blocks: ReaderBlock[];
    totalBlocks: number;
    truncated: boolean;
    nextReadHint?: {
        startBlockId: string;
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
    };
    truncatedReason?: "next_block_over_budget" | "first_block_over_budget";
}

export function selectRecordReaderBlocks(index: RecordReaderIndex, options: FormatReaderViewOptions = {}): SelectRecordReaderBlocksResult {
    const blocks = selectReaderBlocks(index, options);
    if (!options.maxChars || options.maxChars <= 0) {
        return { blocks, totalBlocks: blocks.length, truncated: false };
    }
    const selected: ReaderBlock[] = [];
    let usedChars = 0;
    for (const block of blocks) {
        const blockLength = Math.max(0, block.charRange.end - block.charRange.start);
        if (selected.length > 0 && usedChars + blockLength > options.maxChars) {
            return {
                blocks: selected,
                totalBlocks: blocks.length,
                truncated: true,
                truncatedReason: "next_block_over_budget",
                nextReadHint: {
                    startBlockId: block.id,
                    phaseIds: block.phaseId ? [block.phaseId] : undefined,
                    sectionTypes: [block.sectionType],
                },
            };
        }
        if (selected.length === 0 && blockLength > options.maxChars) {
            return {
                blocks: [],
                totalBlocks: blocks.length,
                truncated: true,
                truncatedReason: "first_block_over_budget",
                nextReadHint: {
                    startBlockId: block.id,
                    phaseIds: block.phaseId ? [block.phaseId] : undefined,
                    sectionTypes: [block.sectionType],
                },
            };
        }
        selected.push(block);
        usedChars += blockLength;
    }
    return { blocks: selected, totalBlocks: blocks.length, truncated: false };
}

function formatExecutableReadHint(hint?: SelectRecordReaderBlocksResult["nextReadHint"], maxChars?: number): string {
    if (!hint) return "增加 maxChars，或使用 phaseIds / sectionTypes 缩小读取范围";
    const parts = [
        `startBlockId=${hint.startBlockId}`,
        hint.phaseIds?.length ? `phaseIds=${JSON.stringify(hint.phaseIds)}` : undefined,
        hint.sectionTypes?.length ? `sectionTypes=${JSON.stringify(hint.sectionTypes)}` : undefined,
        maxChars ? `当前 maxChars=${maxChars}` : undefined,
    ].filter(Boolean);
    const callParts = [
        hint.phaseIds?.length ? `phaseIds: ${JSON.stringify(hint.phaseIds)}` : undefined,
        hint.sectionTypes?.length ? `sectionTypes: ${JSON.stringify(hint.sectionTypes)}` : undefined,
        `maxChars: ${Math.max((maxChars || 0) * 2, 4000)}`,
    ].filter(Boolean);
    return `${parts.join(", ")}；可继续调用 read({ ${callParts.join(", ")} })`;
}

export function createRecordReaderView(index: RecordReaderIndex, view: Exclude<RecordReaderView, "raw">, options: FormatReaderViewOptions = {}) {
    if (view === "outline") {
        return { view, outline: buildOutline(index), truncated: false };
    }
    const selected = selectRecordReaderBlocks(index, { ...options, view });
    return {
        view,
        blocks: selected.blocks,
        refs: selected.blocks.map(toAggregateItem),
        truncated: selected.truncated,
        nextReadHint: selected.nextReadHint,
    };
}

export function formatReaderView(index: RecordReaderIndex, options: FormatReaderViewOptions = {}) {
    if (options.view === "outline") {
        return { text: JSON.stringify(buildOutline(index), null, 2), truncated: false, nextReadHint: undefined as string | undefined };
    }
    const selected = selectRecordReaderBlocks(index, options);
    const blocks = selected.blocks;
    const parts: string[] = [];
    for (const block of blocks) {
        const citation = options.withCitations === false ? "" : ` [${block.id} L${block.lineRange.start}-${block.lineRange.end}]`;
        const header = `### ${block.title || block.sectionType}${citation}`;
        const chunk = `${header}\n${block.text.trim()}\n`;
        parts.push(chunk);
    }
    return {
        text: parts.join("\n").trim(),
        truncated: selected.truncated,
        nextReadHint: selected.truncated ? formatExecutableReadHint(selected.nextReadHint, options.maxChars) : undefined,
        matchedBlockCount: selected.totalBlocks,
        returnedBlockCount: selected.blocks.length,
        truncatedReason: selected.truncatedReason,
    };
}

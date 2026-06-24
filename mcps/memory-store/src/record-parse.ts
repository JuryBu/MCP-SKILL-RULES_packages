// Record 生成引擎 —— 解析 / 校验 / 合成（纯函数）。
// 由 record-generator.ts 拆分而来（E2-B2），纯结构搬运、零行为变更。
import { saveTempFile } from "./temp-store.js";
import {
    roundRangeLabel, patchRangeLabel,
    RECORD_COMPOSE_ROLLBACK_PHASES, RECORD_COMPOSE_MAX_ROLLBACK_PHASES,
    RECORD_COMPOSE_MIN_SIZE_RATIO, RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS,
} from "./record-config.js";
import type {
    RecordPatch, ParsedRecordPhase, ParsedRecordDocument,
    LocalComposeBoundary, LocalComposeDelta, ComposeValidationResult,
    SerialStepPhase, SerialStepDelta,
} from "./record-types.js";

export function parseRecordPatchResponse(response: string, fallbackStartRound: number, fallbackEndRound: number): RecordPatch {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/iu) || trimmed.match(/(\{[\s\S]*?\})/u);
    let parsed: any = {};
    if (jsonMatch) {
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch {
            parsed = {};
        }
    }
    const markdown = jsonMatch
        ? trimmed.replace(jsonMatch[0], "").trim()
        : trimmed;
    return {
        startRound: Number(parsed.startRound) || fallbackStartRound,
        endRound: Number(parsed.endRound) || fallbackEndRound,
        title: typeof parsed.title === "string" ? parsed.title : roundRangeLabel(fallbackStartRound, fallbackEndRound),
        files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        status: typeof parsed.status === "string" ? parsed.status : "parse_fallback",
        markdown: markdown || trimmed,
    };
}

export function stripFencedCodeBlocks(text: string): string {
    return text.replace(/```[\s\S]*?```/gu, "");
}

export function extractPhaseRange(text: string): { startRound: number; endRound: number; english: boolean } {
    const source = stripFencedCodeBlocks(text);
    const range = source.match(/(?:\*\*)?\s*(轮次(?:范围)?|回合|rounds?)\s*(?:\*\*)?\s*[：:]?\s*(\d+)\s*(?:[-~–—－]+|至|到|to)\s*(\d+)/iu);
    if (range) {
        return {
            startRound: Number(range[2]) || 0,
            endRound: Number(range[3]) || Number(range[2]) || 0,
            english: /^round/i.test(range[1]),
        };
    }
    const single = source.match(/(?:\*\*)?\s*(轮次(?:范围)?|回合|rounds?)\s*(?:\*\*)?\s*[：:]?\s*(\d+)/iu);
    const round = single ? Number(single[2]) || 0 : 0;
    return { startRound: round, endRound: round, english: !!single && /^round/i.test(single[1]) };
}

export function normalizeCanonicalRecordLanguage(content: string): { content: string; warnings: string[] } {
    const warnings: string[] = [];
    const normalized = content.replace(
        /^(##\s*Phase\b[^\n（(]*)([（(])\s*(rounds?)\s*(\d+)\s*(?:[-~–—－]+|to)\s*(\d+)\s*([）)])/gimu,
        (_match, prefix, open, _label, start, end, close) => {
            warnings.push(`Phase 标题使用英文 Rounds，已规范为中文${roundRangeLabel(start, end)}`);
            return `${prefix}${open}${roundRangeLabel(start, end)}${close}`;
        },
    );
    return { content: normalized, warnings };
}

export function collectManualSupplementSnippets(content: string): string[] {
    return content
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.includes("[手动补充]"));
}

export function normalizeManualSupplementForCompare(text: string): string {
    return text
        .split(/\r?\n/u)
        .map(line => line
            .trim()
            .replace(/^(?:>\s*)+/u, "")
            .replace(/^(?:[-*+]\s*)+/u, "")
            .replace(/^(?:(?:\d+|[一二三四五六七八九十百千]+)[.、)]\s*)+/u, "")
            .trim())
        .join("\n")
        .replace(/\s+/gu, " ")
        .trim();
}

export function hasManualSupplementSnippet(candidate: string, snippet: string): boolean {
    if (!snippet.trim()) return true;
    if (candidate.includes(snippet)) return true;
    const normalizedSnippet = normalizeManualSupplementForCompare(snippet);
    if (!normalizedSnippet) return true;
    const normalizedCandidate = normalizeManualSupplementForCompare(candidate);
    return normalizedCandidate.includes(normalizedSnippet);
}

export function splitTags(content: string): { body: string; tags: string[] } {
    const tagMatches = [...content.matchAll(/^<!--\s*TAGS:\s*([\s\S]*?)-->\s*$/gimu)];
    if (tagMatches.length === 0) return { body: content.trim(), tags: [] };
    const last = tagMatches[tagMatches.length - 1];
    const tags = String(last[1] || "")
        .split(/[,，]/u)
        .map(tag => tag.trim())
        .filter(Boolean);
    return { body: content.replace(/^<!--\s*TAGS:\s*[\s\S]*?-->\s*$/gimu, "").trim(), tags };
}

export function isTailHeading(line: string): boolean {
    return /^#{1,3}\s*(产出文件|文件总清单|经验教训|后续|未完成|风险|验证结果|总结|关键文件|变更清单)/u.test(line.trim());
}

export function parseRecordDocument(content: string): ParsedRecordDocument {
    const { body, tags } = splitTags(content);
    const lines = body.split(/\r?\n/u);
    const phaseHeadingRegex = /^##\s*Phase\b(.*)$/iu;
    const headingIndexes: { index: number; number: number; title: string }[] = [];
    const parseWarnings: string[] = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/u.test(lines[i])) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const match = lines[i].match(phaseHeadingRegex);
        if (match) {
            const parsedHeading = parsePhaseHeadingSuffix(match[1] || "", headingIndexes.length + 1);
            headingIndexes.push({ index: i, number: parsedHeading.number, title: parsedHeading.title });
        }
    }

    if (headingIndexes.length === 0) {
        return {
            header: body.trim(),
            phases: [],
            tail: "",
            tags,
            manualSupplementSnippets: collectManualSupplementSnippets(content),
            parseWarnings: ["未找到 Phase 标题"],
        };
    }

    const header = lines.slice(0, headingIndexes[0].index).join("\n").trim();
    const phases: ParsedRecordPhase[] = [];
    let tailStart = lines.length;

    for (let i = 0; i < headingIndexes.length; i++) {
        const heading = headingIndexes[i];
        const nextHeadingIndex = headingIndexes[i + 1]?.index ?? lines.length;
        let endIndex = nextHeadingIndex;
        if (i === headingIndexes.length - 1) {
            for (let j = heading.index + 1; j < nextHeadingIndex; j++) {
                if (isTailHeading(lines[j])) {
                    endIndex = j;
                    tailStart = j;
                    break;
                }
            }
        }
        const phaseContent = lines.slice(heading.index, endIndex).join("\n").trim();
        const headingRange = extractPhaseRange(lines[heading.index]);
        const contentRange = headingRange.startRound === 0 || headingRange.endRound === 0
            ? extractPhaseRange(phaseContent)
            : headingRange;
        const { startRound, endRound } = contentRange;
        if (contentRange.english) {
            parseWarnings.push(`Phase ${heading.number} 使用英文 Rounds 轮次标记，建议规范为中文“轮次”`);
        }
        if (startRound === 0 || endRound === 0) {
            parseWarnings.push(`Phase ${heading.number} 缺少可解析轮次范围`);
        }
        phases.push({
            number: heading.number,
            title: heading.title,
            startRound,
            endRound,
            content: phaseContent,
        });
    }

    const tail = tailStart < lines.length
        ? lines.slice(tailStart).join("\n").trim()
        : "";

    return {
        header,
        phases,
        tail,
        tags,
        manualSupplementSnippets: collectManualSupplementSnippets(content),
        parseWarnings,
    };
}

export function parsePhaseHeadingSuffix(suffix: string, fallbackNumber: number): { number: number; title: string } {
    const raw = suffix || "";
    const rangeLabel = raw.match(/^\s*\d+\s*[-~–—－]\s*\d+/u);
    if (rangeLabel) {
        return {
            number: fallbackNumber,
            title: raw.replace(/^[\s：:.\-、]+/u, "").trim(),
        };
    }

    const ordinal = raw.match(/^\s*(\d+)/u);
    if (ordinal) {
        return {
            number: Number(ordinal[1]) || fallbackNumber,
            title: raw.slice(ordinal[0].length).replace(/^[\s：:.\-、]+/u, "").trim(),
        };
    }

    return {
        number: fallbackNumber,
        title: raw.replace(/^[\s：:.\-、]+/u, "").trim(),
    };
}

export function hasOpenPhaseSignal(phase: ParsedRecordPhase, tail: string): boolean {
    const text = `${phase.title}\n${phase.content}\n${tail}`;
    return /进行中|未完成|待验证|阻塞|失败|下一步|Stage Guard 未通过|异常|自指|待修复/iu.test(text);
}

export function selectLocalComposeBoundary(
    parsed: ParsedRecordDocument,
    resumeFromRound: number,
    totalRounds: number,
): LocalComposeBoundary {
    if (parsed.phases.length === 0) {
        return {
            stablePhases: [],
            rollbackPhases: [],
            stableEndRound: 0,
            rewriteStartRound: Math.max(1, resumeFromRound + 1),
            rollbackCount: 0,
            reason: "无可解析 Phase",
        };
    }

    const maxRollback = Math.max(1, Math.min(RECORD_COMPOSE_MAX_ROLLBACK_PHASES, parsed.phases.length));
    let rollbackCount = Math.max(1, Math.min(RECORD_COMPOSE_ROLLBACK_PHASES, maxRollback));
    const last = parsed.phases[parsed.phases.length - 1];
    const lastSpan = last.startRound > 0 && last.endRound >= last.startRound
        ? last.endRound - last.startRound + 1
        : 0;
    const addedRounds = Math.max(0, totalRounds - resumeFromRound);
    let reason = "默认回滚最后 1 个 Phase";

    if (hasOpenPhaseSignal(last, parsed.tail)) {
        reason = "最后 Phase 或尾部呈现开放状态，至少回滚最后 Phase";
    }
    if (maxRollback >= 2 && lastSpan > 0 && lastSpan <= 3 && addedRounds >= 10) {
        rollbackCount = Math.max(rollbackCount, 2);
        reason = "最后 Phase 较短且新增轮次较多";
    }

    const splitIndex = Math.max(0, parsed.phases.length - rollbackCount);
    const stablePhases = parsed.phases.slice(0, splitIndex);
    const rollbackPhases = parsed.phases.slice(splitIndex);
    const stableEndRound = stablePhases[stablePhases.length - 1]?.endRound || 0;
    const rewriteStartRound = rollbackPhases[0]?.startRound || Math.max(1, resumeFromRound + 1);

    return { stablePhases, rollbackPhases, stableEndRound, rewriteStartRound, rollbackCount, reason };
}

export function parseLocalComposeResponse(response: string, fallbackStartRound: number, fallbackEndRound: number): LocalComposeDelta {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/iu) || trimmed.match(/(\{[\s\S]*\})/u);
    let parsed: any = {};
    if (jsonMatch) {
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch {
            parsed = {};
        }
    }
    const markdownFallback = jsonMatch ? trimmed.replace(jsonMatch[0], "").trim() : trimmed;
    const rawPhaseMarkdown = typeof parsed.phaseMarkdown === "string" && parsed.phaseMarkdown.trim()
        ? parsed.phaseMarkdown.trim()
        : markdownFallback;
    return {
        rewriteStartRound: Number(parsed.rewriteStartRound) || fallbackStartRound,
        rewriteEndRound: Number(parsed.rewriteEndRound) || fallbackEndRound,
        phaseMarkdown: dropStaleLocalComposePhases(rawPhaseMarkdown, fallbackStartRound),
        tailMarkdown: typeof parsed.tailMarkdown === "string" ? parsed.tailMarkdown.trim() : "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String).filter(Boolean) : [],
    };
}

export function dropStaleLocalComposePhases(markdown: string, rewriteStartRound: number): string {
    if (!markdown.trim() || !/^##\s*Phase/imu.test(markdown)) return markdown.trim();
    const parsed = parseRecordDocument(markdown);
    if (parsed.phases.length === 0) return markdown.trim();
    const keptPhases = parsed.phases.filter(phase => {
        if (!phase.endRound) return true;
        return phase.endRound >= rewriteStartRound;
    });
    if (keptPhases.length === 0) return markdown.trim();
    if (keptPhases.length === parsed.phases.length) return markdown.trim();
    const parts = [
        ...keptPhases.map(phase => phase.content.trim()).filter(Boolean),
        parsed.tail.trim(),
    ].filter(Boolean);
    return parts.join("\n\n").trim();
}

export function updateRecordHeader(header: string, conversationId: string, workspace: string, totalRounds: number, totalSteps: number): string {
    let next = header.trim() || "# 对话记录 Record";
    const replacements: Array<[RegExp, string]> = [
        [/^-?\s*(?:\*\*)?对话ID(?:\*\*)?[：:]\s*.*$/imu, `- 对话ID：\`${conversationId}\``],
        [/^-?\s*(?:\*\*)?工作区(?:\*\*)?[：:]\s*.*$/imu, `- 工作区：\`${workspace}\``],
        [/^-?\s*(?:\*\*)?总轮次(?:\*\*)?[：:]\s*.*$/imu, `- 总轮次：${totalRounds}`],
        [/^-?\s*(?:\*\*)?总步骤(?:\*\*)?[：:]\s*.*$/imu, `- 总步骤：${totalSteps}`],
    ];
    for (const [pattern, replacement] of replacements) {
        next = pattern.test(next) ? next.replace(pattern, replacement) : `${next}\n${replacement}`;
    }
    return next.trim();
}

export function enforceRecordHeaderMetadata(
    content: string,
    metadata: { conversationId: string; workspace: string; totalRounds: number; totalSteps: number },
): string {
    const normalized = normalizeCanonicalRecordLanguage(content).content;
    const parsed = parseRecordDocument(normalized);
    const header = updateRecordHeader(parsed.header, metadata.conversationId, metadata.workspace, metadata.totalRounds, metadata.totalSteps);
    if (parsed.phases.length === 0) {
        const tags = normalizeTags(parsed.tags);
        const parts = [header];
        if (tags.length > 0) {
            parts.push(`<!-- TAGS: ${tags.join(", ")} -->`);
        }
        return `${parts.join("\n\n")}\n`;
    }
    const phasesText = parsed.phases.map(phase => phase.content).join("\n\n").trim();
    const tags = normalizeTags(parsed.tags);
    const parts = [header, phasesText, parsed.tail]
        .map(part => part.trim())
        .filter(Boolean);
    if (tags.length > 0) {
        parts.push(`<!-- TAGS: ${tags.join(", ")} -->`);
    }
    return `${parts.join("\n\n")}\n`;
}

export function normalizeRenumberedPhaseSuffix(rest: string): string {
    const trimmed = rest.trimStart();
    if (!trimmed) return "";
    if (/^[（(]/u.test(trimmed)) return trimmed;
    const text = trimmed.replace(/^[：:.\-、]\s*/u, "").trimStart();
    return text ? `：${text}` : "";
}

export function renumberPhaseMarkdown(markdown: string, startNumber = 1): string {
    let current = startNumber;
    return markdown.replace(/^##\s*Phase\b(.*)$/gimu, (_match, suffix) => {
        let rest = String(suffix || "");
        const rangeLabel = rest.match(/^\s*(\d+)\s*[-~–—－]\s*(\d+)/u);
        const ordinal = rangeLabel ? null : rest.match(/^\s*\d+/u);
        let rangeToPreserve: string | null = null;
        if (ordinal) {
            rest = rest.slice(ordinal[0].length);
        } else if (rangeLabel) {
            rest = rest.slice(rangeLabel[0].length);
            // 模型把轮次范围写进了 Phase 编号位（如 `## Phase 1-63：标题`，多见于从零/reduce 自由文本产物）。
            // 若标题里没有标准「（轮次 X-Y）」标签，就把这个范围转成标准轮次标签补回——否则范围被剥掉后
            // inferCoveredRoundFromRecord 读不出覆盖轮次，会把好候选误判为「只覆盖第 0 轮」而拒收（## Phase 1-63 误杀根因）。
            rangeToPreserve = patchRangeLabel(rangeLabel[1], rangeLabel[2]);
        } else {
            // 兜底：模型用 `## Phase ?：标题` 这种占位编号时，剥掉 ?/？ 占位符（串行管线让模型写占位号、由本函数统一重排）
            const placeholder = rest.match(/^\s*[?？]/u);
            if (placeholder) rest = rest.slice(placeholder[0].length);
        }
        let suffixText = normalizeRenumberedPhaseSuffix(rest);
        if (rangeToPreserve && !/[（(]\s*轮次?\s*\d+\s*[-~–—－]\s*\d+\s*[)）]/u.test(suffixText)) {
            suffixText = `${suffixText}${rangeToPreserve}`;
        }
        return `## Phase ${current++}${suffixText}`;
    });
}

export function normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
}

export function composeRecordLocally(
    parsed: ParsedRecordDocument,
    boundary: LocalComposeBoundary,
    delta: LocalComposeDelta,
    metadata: { conversationId: string; workspace: string; totalRounds: number; totalSteps: number },
): string {
    const header = updateRecordHeader(parsed.header, metadata.conversationId, metadata.workspace, metadata.totalRounds, metadata.totalSteps);
    const stableText = boundary.stablePhases.map(phase => phase.content).join("\n\n").trim();
    const phaseStartNumber = boundary.stablePhases.length + 1;
    const rewritten = renumberPhaseMarkdown(delta.phaseMarkdown.trim(), phaseStartNumber);
    const tail = delta.tailMarkdown.trim() || parsed.tail.trim();
    const tags = normalizeTags(delta.tags.length > 0 ? delta.tags : parsed.tags);
    const parts = [header, stableText, rewritten, tail]
        .map(part => part.trim())
        .filter(Boolean);
    if (tags.length > 0) {
        parts.push(`<!-- TAGS: ${tags.join(", ")} -->`);
    }
    return `${normalizeCanonicalRecordLanguage(parts.join("\n\n")).content}\n`;
}

export function validateComposedRecord(
    candidate: string,
    oldRecord: string,
    parsed: ParsedRecordDocument,
    boundary: LocalComposeBoundary,
    totalRounds: number,
): ComposeValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const candidateCovered = inferCoveredRoundFromRecord(candidate, totalRounds);
    if (candidateCovered < totalRounds) {
        errors.push(`候选 Record 只覆盖到第 ${candidateCovered} 轮，目标是第 ${totalRounds} 轮`);
    }
    for (const phase of boundary.stablePhases) {
        if (phase.content && !candidate.includes(phase.content)) {
            errors.push(`稳定区 Phase ${phase.number} 未原样保留`);
            break;
        }
    }
    for (const snippet of parsed.manualSupplementSnippets) {
        if (snippet && !hasManualSupplementSnippet(candidate, snippet)) {
            errors.push(`缺少手动补充内容: ${snippet.slice(0, 80)}`);
            break;
        }
    }
    const tagCount = (candidate.match(/<!--\s*TAGS:/giu) || []).length;
    if (tagCount !== 1) {
        errors.push(`TAGS 数量异常: ${tagCount}`);
    }
    if (!/产出文件|经验教训|后续|风险|验证结果|总结/u.test(candidate)) {
        warnings.push("候选 Record 缺少明显尾部总结/经验/风险段落");
    }
    const stableLength = boundary.stablePhases.map(phase => phase.content).join("\n\n").length;
    if (candidate.length < stableLength * 0.98) {
        errors.push("候选 Record 短于稳定区内容，疑似丢失旧 Phase");
    }
    if (oldRecord.length > 0 && candidate.length < oldRecord.length * RECORD_COMPOSE_MIN_SIZE_RATIO) {
        errors.push(`候选 Record 明显短于旧 Record (${candidate.length}/${oldRecord.length})，疑似过度压缩`);
    }
    const parsedCandidate = parseRecordDocument(candidate);
    for (let i = 1; i < parsedCandidate.phases.length; i++) {
        const prev = parsedCandidate.phases[i - 1];
        const cur = parsedCandidate.phases[i];
        if (cur.number !== prev.number + 1) {
            errors.push(`Phase 编号不连续: ${prev.number} -> ${cur.number}`);
            break;
        }
        const bothStable = cur.endRound > 0 && cur.endRound <= boundary.stableEndRound;
        if (bothStable) {
            continue;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound < prev.endRound) {
            errors.push(`Phase 轮次重叠或倒退: ${prev.endRound} -> ${cur.startRound}`);
            break;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound > prev.endRound + 1) {
            errors.push(`Phase 轮次不连续: ${prev.endRound} -> ${cur.startRound}`);
            break;
        }
    }
    return { ok: errors.length === 0, errors, warnings };
}

export function extractRecordTitle(content: string): string | null {
    const match = content.match(/^#\s*(?:Record|对话记录 Record)[：:]\s*(.+)$/m);
    return match?.[1]?.trim() || null;
}

export function inferRecordTotalRounds(content: string): number {
    const match = content.match(/总轮次[：:]\s*`?(\d+)/u);
    return match ? Number(match[1]) : 0;
}

export function phaseRangeIssueKey(prevEndRound: number, curStartRound: number, curEndRound: number): string {
    return `${prevEndRound}->${curStartRound}-${curEndRound}`;
}

export function collectLegacyPhaseRangeIssues(oldRecord: string): Set<string> {
    const issues = new Set<string>();
    const parsed = parseRecordDocument(oldRecord);
    for (let i = 1; i < parsed.phases.length; i++) {
        const prev = parsed.phases[i - 1];
        const cur = parsed.phases[i];
        if (prev.endRound > 0 && cur.startRound > 0 && cur.endRound > 0 && cur.startRound < prev.endRound) {
            issues.add(phaseRangeIssueKey(prev.endRound, cur.startRound, cur.endRound));
        }
    }
    return issues;
}

export function validateRecordCandidateForWrite(
    content: string,
    conversationId: string,
    totalRounds: number,
    expectedCoveredRound: number,
    options: { oldRecord?: string; strictShrinkCheck?: boolean } = {},
): { ok: true; warnings: string[] } | { ok: false; error: string; candidatePath: string; warnings: string[] } {
    const phaseCount = countPhasesInRecord(content);
    const oldPhaseCount = options.oldRecord ? countPhasesInRecord(options.oldRecord) : 0;
    const coveredRound = inferCoveredRoundFromRecord(content, totalRounds);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (phaseCount === 0 && (totalRounds >= 3 || oldPhaseCount > 0)) {
        errors.push("候选 Record 未识别到任何 Phase");
    }
    if (oldPhaseCount > 0 && phaseCount === 0) {
        errors.push("旧 Record 已有 Phase，候选却变成 0 Phase，疑似模型输出格式崩坏");
    }
    if (expectedCoveredRound > 0 && coveredRound < expectedCoveredRound) {
        errors.push(`候选 Record 只明确覆盖到第 ${coveredRound} 轮，目标至少第 ${expectedCoveredRound} 轮`);
    }
    if (options.oldRecord && options.strictShrinkCheck !== false && options.oldRecord.length > 2000 && content.length < options.oldRecord.length * RECORD_COMPOSE_MIN_SIZE_RATIO) {
        errors.push(`候选 Record 明显短于旧 Record (${content.length}/${options.oldRecord.length})，疑似过度压缩`);
    }
    const parsed = parseRecordDocument(content);
    const legacyRangeIssues = options.oldRecord
        ? collectLegacyPhaseRangeIssues(options.oldRecord)
        : new Set<string>();
    for (let i = 1; i < parsed.phases.length; i++) {
        const prev = parsed.phases[i - 1];
        const cur = parsed.phases[i];
        if (cur.number !== prev.number + 1) {
            errors.push(`Phase 编号不连续: ${prev.number} -> ${cur.number}`);
            break;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound < prev.endRound) {
            const legacyKey = phaseRangeIssueKey(prev.endRound, cur.startRound, cur.endRound);
            if (legacyRangeIssues.has(legacyKey)) {
                warnings.push(`候选继承旧 Record 已存在的 Phase 轮次重叠: ${prev.endRound} -> ${cur.startRound}`);
                continue;
            }
            errors.push(`Phase 轮次重叠或倒退: ${prev.endRound} -> ${cur.startRound}`);
            break;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound > prev.endRound + 1) {
            warnings.push(`Phase 轮次存在空洞: ${prev.endRound} -> ${cur.startRound}`);
        }
    }
    if (phaseCount > 0 && !/产出文件|经验教训|后续|风险|验证结果|总结/u.test(content)) {
        warnings.push("候选 Record 缺少明显尾部总结/经验/风险段落");
    }
    if (errors.length === 0) return { ok: true, warnings };
    const candidatePath = saveTempFile("record_candidate_rejected", conversationId.slice(0, 8), content);
    return {
        ok: false,
        error: `${errors.join("; ")}；已拒绝覆盖正式 Record，候选已保存: ${candidatePath}`,
        candidatePath,
        warnings,
    };
}

export function validateRecordBeforeAccept(
    content: string,
    conversationId: string,
    totalRounds: number,
    expectedCoveredRound: number,
    oldRecord?: string,
): { ok: true } | { ok: false; error: string; candidatePath: string } {
    const result = validateRecordCandidateForWrite(content, conversationId, totalRounds, expectedCoveredRound, {
        oldRecord,
        strictShrinkCheck: false,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error, candidatePath: result.candidatePath };
}

/**
 * 从 Record 正文推断它实际覆盖到的轮次。
 *
 * 只使用明确的覆盖声明、Phase 标题或 Phase 内轮次范围。
 * 不能用头部“总轮次”兜底，否则坏 Record 会把目标总轮次误当作正文已覆盖轮次。
 */
export function inferCoveredRoundFromRecord(content: string, currentTotalRounds: number): number {
    let covered = 0;
    const update = (value: number) => {
        if (Number.isFinite(value) && value > covered) {
            covered = value;
        }
    };

    const parsed = parseRecordDocument(content);
    for (const phase of parsed.phases) {
        update(phase.endRound);
    }

    let inFence = false;
    for (const rawLine of content.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (/^\s*```/u.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (!line || /总轮次/u.test(line)) continue;

        const isExplicitCoverageComment = /^<!--.*(?:当前明确覆盖到|已覆盖到|覆盖到)第?\s*\d+\s*轮.*-->$/u.test(line);

        if (isExplicitCoverageComment) {
            const match = line.match(/(?:当前明确覆盖到|已覆盖到|覆盖到)第?\s*(\d+)\s*轮/u);
            if (match) update(Number(match[1]));
        }
    }

    return Math.min(Math.max(covered, 0), currentTotalRounds);
}

/** 从（可能被截断的）JSON 文本里抢救出 phases 数组中【已完整闭合】的对象。模型输出超 token 上限被截断时，
 *  整体 JSON.parse 会失败 → 0 phases，但前面已写完的 Phase 其实是好的，逐个括号配对（含字符串/转义处理）抢救回来，
 *  遇到第一个未闭合（截断在对象中途）即停。 */
export function salvagePhasesFromTruncatedJson(text: string): any[] {
    const arrAt = text.search(/"phases"\s*:\s*\[/u);
    if (arrAt < 0) return [];
    let i = text.indexOf("[", arrAt);
    if (i < 0) return [];
    i++;
    const objs: any[] = [];
    const n = text.length;
    while (i < n) {
        while (i < n && text[i] !== "{" && text[i] !== "]") i++;
        if (i >= n || text[i] === "]") break;
        let depth = 0, inStr = false, esc = false;
        const start = i;
        for (; i < n; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === "\\") { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
        }
        if (depth !== 0) break; // 截断在对象中途，停止抢救
        try { objs.push(JSON.parse(text.slice(start, i))); } catch { break; }
    }
    return objs;
}

export function parseSerialComposeStep(response: string): SerialStepDelta {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/iu) || trimmed.match(/(\{[\s\S]*\})/u);
    let parsed: any = {};
    if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[1]); } catch { parsed = {}; }
    }
    let rawPhases: any[] = Array.isArray(parsed.phases) ? parsed.phases : [];
    let truncated = false;
    if (rawPhases.length === 0) {
        // 整体解析失败（多半是输出被截断成残缺 JSON）→ 抢救已完整闭合的 Phase 对象
        const salvaged = salvagePhasesFromTruncatedJson(trimmed);
        if (salvaged.length > 0) { rawPhases = salvaged; truncated = true; }
    }
    const phases: SerialStepPhase[] = rawPhases.map((p: any) => ({
        title: typeof p?.title === "string" ? p.title : undefined,
        startRound: Number.isFinite(p?.startRound) ? Number(p.startRound) : undefined,
        endRound: Number.isFinite(p?.endRound) ? Number(p.endRound) : undefined,
        open: p?.open === true,
        markdown: typeof p?.markdown === "string" ? p.markdown : undefined,
    }));
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String).filter(Boolean) : [];
    if (truncated) warnings.push(`模型输出疑似被截断，已从残缺 JSON 抢救出 ${phases.length} 个完整 Phase`);
    return { phases, warnings };
}

export function parseSerialComposeTail(response: string): { tailMarkdown: string; tags: string[] } {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/iu) || trimmed.match(/(\{[\s\S]*\})/u);
    let parsed: any = {};
    if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[1]); } catch { parsed = {}; }
    }
    return {
        tailMarkdown: typeof parsed.tailMarkdown === "string" ? parsed.tailMarkdown.trim() : "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [],
    };
}

/** 用代码兜底改写 markdown 标题里的轮次范围，防止跨步重叠；模型省略括号时追加补全 */
export function rewritePhaseRoundsLabel(markdown: string, startRound: number, endRound: number): string {
    const label = patchRangeLabel(startRound, endRound);
    const replaceRe = /^(##\s*Phase\b[^\n]*?)[（(]\s*轮次?\s*\d+\s*[-~–—－]\s*\d+\s*[)）]/imu;
    if (replaceRe.test(markdown)) {
        return markdown.replace(replaceRe, `$1${label}`);
    }
    // 模型省略括号兜底：把标签追加到首个 `## Phase` 标题行末尾
    return markdown.replace(/^(##\s*Phase\b[^\n]*?)$/imu, (_m, head) => `${String(head).trimEnd()}${label}`);
}

/** 代码级修复：把一段 phaseMarkdown 的各 Phase 轮次范围重排成连续（首段从 rewriteStartRound 起，
 *  保留各段原跨度链式衔接，末段覆盖到 totalRounds），专治串行产物的轮次不连续/覆盖不足，无需模型调用。 */
export function relabelSerialPhaseMarkdown(phaseMarkdown: string, rewriteStartRound: number, totalRounds: number): string {
    const trimmed = phaseMarkdown.trim();
    if (!trimmed || !/^##\s*Phase/imu.test(trimmed)) return trimmed;
    const blocks = trimmed.split(/(?=^##\s*Phase\b)/imu).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) return trimmed;
    let cursor = Math.max(1, rewriteStartRound);
    const relabeled = blocks.map((block, idx) => {
        const rangeMatch = block.match(/[（(]\s*轮次?\s*(\d+)\s*[-~–—－]\s*(\d+)\s*[)）]/u);
        // M1 加固：兼容模型把轮次范围写进 Phase 编号位（## Phase 1-30：）的情形——括号标签缺失时从编号位读跨度，
        // 否则 span 退化为 0，会把多段真实跨度压成 1 轮，relabel 反而抹掉模型给出的正确边界。
        const headingRangeMatch = rangeMatch ? null : block.match(/^##\s*Phase\s*(\d+)\s*[-~–—－]\s*(\d+)/imu);
        const span = rangeMatch
            ? Math.max(0, Number(rangeMatch[2]) - Number(rangeMatch[1]))
            : headingRangeMatch
                ? Math.max(0, Number(headingRangeMatch[2]) - Number(headingRangeMatch[1]))
                : 0;
        const start = cursor;
        let end = start + span;
        if (idx === blocks.length - 1) end = Math.max(end, totalRounds);
        if (end < start) end = start;
        cursor = end + 1;
        return rewritePhaseRoundsLabel(block, start, end);
    });
    return relabeled.join("\n\n");
}

/**
 * B5/M3 治标：构造喂给下一窗模型的「未收尾开放 Phase」上下文。
 *
 * 契约（buildSerialComposeStepPrompt 规则 2）要求模型把延续后的【完整】markdown
 * （含历史已写部分）放进 phases[0]。代码本就持有开放 Phase 的完整累积 markdown
 * （acc.openPhase.markdown），1M 上下文模型输入不是瓶颈，所以默认喂全文，让模型看到
 * 完整历史→能完整重产→不丢头部（修复旧实现只喂末 1500 字导致开放 Phase 头部丢失的根因）。
 *
 * 仅当病态超长（> RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS，默认 50K，正常开放 Phase 远不及）
 * 时才做头尾保留截断兜底，防极端情况撑爆单窗 prompt。
 */
export function buildOpenPhaseSnippet(openPhase: { startRound: number; endRound: number; markdown: string }): string {
    const header = `${roundRangeLabel(openPhase.startRound, openPhase.endRound)} 的开放 Phase 当前【完整】markdown（请在延续/合并时含此全部历史内容，不要丢头部）：\n\n`;
    const md = openPhase.markdown;
    if (md.length <= RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS) {
        return header + md;
    }
    // 病态超长兜底：头尾保留 + 中段带标记省略（头 60% / 尾 40%），仍优先保住头部不丢。
    const headChars = Math.floor(RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS * 0.6);
    const tailChars = RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS - headChars;
    return [
        header,
        md.slice(0, headChars),
        `\n\n[开放 Phase 原文 ${md.length} 字，超上限 ${RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS} 字，中段省略约 ${md.length - headChars - tailChars} 字（请保留头尾两端内容）]\n\n`,
        md.slice(-tailChars),
    ].join("");
}

// ============= 辅助函数 =============

/**
 * 清理 Flash 响应（去掉代码块包裹 + 提取 tags）
 */
export function cleanFlashResponse(response: string): { content: string; tags: string[] } {
    let cleaned = response.trim();
    // 去掉 ```markdown ... ``` 包裹
    if (cleaned.startsWith("```markdown")) {
        cleaned = cleaned.slice("```markdown".length);
    } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // 提取 <!-- TAGS: ... --> 标签
    let tags: string[] = [];
    const tagMatch = cleaned.match(/<!--\s*TAGS:\s*(.+?)\s*-->/i);
    if (tagMatch) {
        tags = tagMatch[1].split(/[,，]/).map(t => t.trim()).filter(t => t.length > 0);
        cleaned = cleaned.replace(tagMatch[0], "").trim();
    }

    return { content: cleaned, tags };
}

/**
 * 从 Record 内容中提取 Phase 数量
 */
export function countPhasesInRecord(content: string): number {
    return parseRecordDocument(content).phases.length;
}

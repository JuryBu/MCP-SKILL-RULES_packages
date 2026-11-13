import fs from "fs";
import path from "path";

export interface GuardTargetRange {
    startLine: number;
    endLine: number;
    label: string;
    reason: string;
}

export interface GuardTargetDocument {
    file: string;
    mode: "task" | "plan";
    lines: string[];
    totalChars: number;
    ranges: GuardTargetRange[];
    gaps: string[];
}

interface TargetIdentity {
    stage?: string;
    unit?: string;
}

interface TargetHeading {
    startLine: number;
    endLine: number;
    level: number;
    title: string;
    identity: TargetIdentity;
}

function normalizedText(value: string): string {
    return value.replace(/[`*_]/gu, "").replace(/Stage\s+(?=\d)/giu, "Stage").replace(/\s+/gu, " ").trim().toLowerCase();
}

function identityOf(value: string): TargetIdentity {
    const stage = value.match(/\bstage\s*(\d+(?:\.\d+)*[a-z]?(?:-\d+[a-z]?)?)(?![\w.])/iu)?.[1];
    const unit = value.match(/\bU(\d+)(?!\w)/iu)?.[1];
    return { stage: stage?.toLowerCase(), unit };
}

export function sanitizeGuardTargetLines(content: string, preserveFencedContent = false): string[] {
    let guardLock = false;
    let fence: { character: string; length: number; preserve: boolean } | undefined;
    let previousContentLine = "";
    return content.split(/\r?\n/u).map(line => {
        if (!fence && /^\s*<!--\s*STAGE_GUARD_LOCK_BEGIN(?:\s|-->)/u.test(line)) guardLock = true;
        if (guardLock) {
            if (line.includes("STAGE_GUARD_LOCK_END")) guardLock = false;
            return "";
        }
        if (!fence && /<!--.*(?:STAGE GUARD ACTIVE|STAGE_GUARD|🔒)/u.test(line)) return "";
        const markerMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
        const marker = markerMatch?.[1];
        if (fence) {
            const preserve = fence.preserve;
            if (marker && marker[0] === fence.character && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/u.test(line)) fence = undefined;
            return preserve ? line : "";
        }
        if (marker) {
            const language = markerMatch![2].trim().split(/\s/u)[0];
            const introduction = previousContentLine.replace(/^\s*(?:#{1,6}\s*|[-*+]\s*)?/u, "");
            const example = /^(?:markdown|md)$/iu.test(language) || /^(?:仅供(?:参考|示例)|仅作(?:参考|示例)|(?:代码|配置|调用)?示例|examples?|samples?)(?:\s|[:：]|$)/iu.test(introduction);
            fence = { character: marker[0], length: marker.length, preserve: preserveFencedContent && !example };
            return fence.preserve ? line : "";
        }
        if (line.trim()) previousContentLine = line;
        return line;
    });
}

function headingsOf(lines: string[]): TargetHeading[] {
    const headings: TargetHeading[] = [];
    lines.forEach((line, index) => {
        const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
        if (match) headings.push({ startLine: index + 1, endLine: lines.length, level: match[1].length, title: match[2], identity: identityOf(match[2]) });
    });
    for (let index = 0; index < headings.length; index += 1) {
        headings[index].endLine = (headings.slice(index + 1).find(next => next.level <= headings[index].level)?.startLine || lines.length + 1) - 1;
    }
    return headings;
}

function isAddendum(title: string): boolean {
    if (/待复核|小本本|handoff|证据可见性/iu.test(title)) return true;
    const explicitStage = /^(?:stage\s*\d|u\d)/iu.test(normalizedText(title));
    return /追加/iu.test(title) && !explicitStage;
}

function isGlobal(title: string): boolean {
    return /^(?:(?:[一二三四五六七八九十\d]+)[、.．]\s*)?(?:适用(?:的)?全局(?:要求|规则|约束)|全局(?:要求|规则|约束|验收|目标|边界)|总原则|工作原则|安全边界|通用(?:要求|约束|规则)|目标(?:与|和|$)|验收(?:要求|标准|条件)|范围与约束)/u.test(title);
}

function tableHeader(lines: string[], rowIndex: number): number | undefined {
    let header = rowIndex;
    while (header > 0 && lines[header - 1].includes("|")) header -= 1;
    return rowIndex >= header + 2 && /^\s*\|?\s*:?-{3,}\s*:?(?:\s*\|\s*:?-{3,}\s*:?)+\s*\|?\s*$/u.test(lines[header + 1]) ? header : undefined;
}

function matchesIdentity(identity: TargetIdentity, target: TargetIdentity): boolean {
    if (target.unit && identity.unit !== target.unit) return false;
    if (target.stage && identity.stage && identity.stage !== target.stage) return false;
    return Boolean(target.unit ? identity.unit : target.stage && identity.stage === target.stage);
}

function rangeForHeading(heading: TargetHeading, label: string): GuardTargetRange {
    return { startLine: heading.startLine, endLine: heading.endLine, label, reason: `${label}: ${heading.title}` };
}

function selectorRanges(lines: string[], headings: TargetHeading[], bounds: GuardTargetRange[], selector: string): GuardTargetRange[] {
    const normalized = normalizedText(selector);
    const matching = lines.map((line, index) => ({ line, lineNumber: index + 1 })).filter(item => (
        bounds.some(bound => item.lineNumber >= bound.startLine && item.lineNumber <= bound.endLine)
        && normalizedText(item.line).includes(normalized)
        && (!/^[\w-]/u.test(normalized) || !/[\w-]/u.test(normalizedText(item.line)[normalizedText(item.line).indexOf(normalized) - 1] || ""))
        && (!/[\w-]$/u.test(normalized) || !/[\w-]/u.test(normalizedText(item.line)[normalizedText(item.line).indexOf(normalized) + normalized.length] || ""))
    ));
    const structural = matching.filter(item => /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/u.test(item.line));
    return (structural.length ? structural : matching).map(item => {
        const bound = bounds.find(candidate => item.lineNumber >= candidate.startLine && item.lineNumber <= candidate.endLine)!;
        const heading = headings.find(candidate => candidate.startLine === item.lineNumber);
        if (heading) return { ...rangeForHeading(heading, "scope-selector"), endLine: Math.min(heading.endLine, bound.endLine) };
        const indent = item.line.match(/^(\s*)/u)![1].length;
        let endLine = item.lineNumber;
        while (endLine < bound.endLine) {
            const next = lines[endLine];
            if (/^\s{0,3}#{1,6}\s/u.test(next)) break;
            const bullet = next.match(/^(\s*)(?:[-*+]|\d+[.)])\s/u);
            if (bullet && bullet[1].length <= indent) break;
            endLine += 1;
        }
        return { startLine: item.lineNumber, endLine, label: "scope-selector", reason: `scope selector: ${selector}` };
    });
}

export function resolveGuardTargetDocument(file: string, mode: "task" | "plan", stageId = "", scopeSelectors: string[] = []): GuardTargetDocument {
    const document: GuardTargetDocument = { file, mode, lines: [], totalChars: 0, ranges: [], gaps: [] };
    let structuralLines: string[] = [];
    const gap = (message: string) => document.gaps.push(`${file}: ${message}`);
    try {
        if (!fs.statSync(file).isFile()) throw new Error("not a regular file");
        const content = fs.readFileSync(file, "utf-8");
        document.totalChars = content.length;
        document.lines = sanitizeGuardTargetLines(content, true);
        structuralLines = sanitizeGuardTargetLines(content);
    } catch (error) {
        gap(`target unreadable (${error instanceof Error ? error.message : String(error)})`);
        return document;
    }
    const lines = structuralLines;
    const headings = headingsOf(lines);
    const target = identityOf(stageId);
    const knownStageHeadings = headings.filter(heading => (heading.identity.stage || heading.identity.unit) && !isAddendum(heading.title));
    const rows = lines.map((line, index) => ({ line, startLine: index + 1, header: line.includes("|") ? tableHeader(lines, index) : undefined, identity: identityOf(line.split("|").map(cell => cell.trim()).filter(Boolean)[0] || "") }))
        .filter(row => row.header !== undefined && (row.identity.stage || row.identity.unit));
    const knownStages = new Set([
        ...headings.filter(heading => !isAddendum(heading.title)).flatMap(heading => [heading.identity.stage && `stage:${heading.identity.stage}`, heading.identity.unit && `unit:${heading.identity.unit}`]),
        ...rows.flatMap(row => [row.identity.stage && `stage:${row.identity.stage}`, row.identity.unit && `unit:${row.identity.unit}`]),
    ].filter(Boolean));
    const effectiveIdentity = (heading: TargetHeading): TargetIdentity => ({
        ...heading.identity,
        stage: heading.identity.stage || headings.filter(parent => parent.startLine < heading.startLine && parent.endLine >= heading.endLine && parent.identity.stage).at(-1)?.identity.stage,
    });
    const stageHeadings = headings.filter(heading => !isAddendum(heading.title) && (
        target.stage || target.unit
            ? matchesIdentity(effectiveIdentity(heading), target)
            : Boolean(stageId.trim()) && normalizedText(heading.title) === normalizedText(stageId)
    ));
    const selectedHeadings = stageHeadings.filter(heading => !stageHeadings.some(parent => parent !== heading && parent.startLine < heading.startLine && parent.endLine >= heading.endLine));
    let stageRanges = selectedHeadings.map(heading => rangeForHeading(heading, "stage-section"));
    if (stageRanges.length > 1) gap(`ambiguous stage ${stageId}: ${stageRanges.map(range => `L${range.startLine}-${range.endLine}`).join(", ")}`);
    if (!stageRanges.length && (target.stage || target.unit)) {
        const matchingRows = rows.filter(row => matchesIdentity(row.identity, target));
        if (matchingRows.length > 1) gap(`ambiguous stage table ${stageId}: ${matchingRows.map(row => `L${row.startLine}`).join(", ")}`);
        if (matchingRows.length === 1) {
            const row = matchingRows[0];
            const header = row.header!;
            if (header + 1 < row.startLine) {
                document.ranges.push({ startLine: header + 1, endLine: header + 2, label: "table-header", reason: "stage table columns" });
            }
            stageRanges = [{ startLine: row.startLine, endLine: row.startLine, label: "stage-section", reason: `stage table row: ${stageId}` }];
        }
    }
    const globalHeadings = headings.filter(heading => isGlobal(heading.title) && !headings.some(parent => (
        parent !== heading && parent.startLine < heading.startLine && parent.endLine >= heading.endLine
        && (parent.identity.stage || parent.identity.unit)
    )));
    for (const heading of globalHeadings) {
        const blocked = headings.filter(child => child.startLine > heading.startLine && child.startLine <= heading.endLine && (child.identity.stage || child.identity.unit));
        let cursor = heading.startLine;
        for (const child of blocked) {
            if (child.startLine > cursor) document.ranges.push({ startLine: cursor, endLine: child.startLine - 1, label: "global-rules", reason: `applicable global section: ${heading.title}` });
            cursor = Math.max(cursor, child.endLine + 1);
        }
        if (cursor <= heading.endLine) document.ranges.push({ startLine: cursor, endLine: heading.endLine, label: "global-rules", reason: `applicable global section: ${heading.title}` });
    }
    const smallDocument = lines.length <= 260 && document.totalChars <= 60_000;
    if (!stageRanges.length) {
        if (smallDocument && knownStages.size <= 1 && !target.stage && !target.unit) {
            stageRanges = [{ startLine: 1, endLine: lines.length, label: "full-map", reason: "complete small document scope" }];
        } else if (mode === "plan" && !knownStages.size && document.ranges.length > 0) {
            stageRanges = [];
        } else {
            gap(`stage scope unresolved: ${stageId || "stageId missing"}; candidates=${knownStageHeadings.map(heading => `L${heading.startLine} ${heading.title}`).join("; ") || "none"}`);
        }
    }
    const selectors = [...new Set(scopeSelectors.map(selector => selector.trim()).filter(Boolean))];
    if (selectors.length && stageRanges.length && !document.gaps.length) {
        const selectedRanges: GuardTargetRange[] = [];
        for (const selector of selectors) {
            const matches = selectorRanges(lines, headings, stageRanges, selector);
            if (matches.length > 1) gap(`ambiguous scope selector ${selector}: ${matches.map(range => `L${range.startLine}`).join(", ")}`);
            else if (matches.length === 1) selectedRanges.push(matches[0]);
            else if (mode === "task") gap(`scope selector not found in ${stageId || "document"}: ${selector}`);
        }
        if (selectedRanges.length) stageRanges = selectedRanges;
    }
    document.ranges.push(...stageRanges);
    for (const heading of headings.filter(heading => isAddendum(heading.title) && matchesIdentity(effectiveIdentity(heading), target) && (!selectors.length || selectors.some(selector => normalizedText(heading.title).includes(normalizedText(selector)))))) {
        document.ranges.push(rangeForHeading(heading, "guard-note"));
    }
    for (const heading of headings) {
        if ((target.stage && heading.identity.stage && target.stage !== heading.identity.stage)
            || (target.unit && heading.identity.unit && target.unit !== heading.identity.unit)) {
            for (let lineNumber = heading.startLine; lineNumber <= heading.endLine; lineNumber += 1) {
                lines[lineNumber - 1] = "";
                document.lines[lineNumber - 1] = "";
            }
        }
    }
    for (const row of rows) {
        if ((target.stage || target.unit) && !matchesIdentity(row.identity, target)) {
            lines[row.startLine - 1] = "";
            document.lines[row.startLine - 1] = "";
        }
    }
    if (!lines.some(line => line.trim())) gap("target document empty after lock/example removal");
    return document;
}

export function resolveGuardTargetScope(taskFiles: string[], planFiles: string[], stageId = "", scopeSelectors: string[] = []): GuardTargetDocument[] {
    return [
        ...taskFiles.map(file => resolveGuardTargetDocument(file, "task", stageId, scopeSelectors)),
        ...planFiles.map(file => resolveGuardTargetDocument(file, "plan", stageId, scopeSelectors)),
    ];
}

export function validateGuardTargetScope(taskFiles: string[], planFiles: string[], stageId: string, scopeSelectors: string[]): string[] {
    if (!taskFiles.length) return ["taskFiles: at least one Task document is required"];
    return [...new Set(resolveGuardTargetScope(taskFiles, planFiles, stageId, scopeSelectors).flatMap(document => document.gaps))];
}

export function findDeclaredGuardPlanFiles(taskFiles: string[]): string[] {
    const declared: string[] = [];
    for (const taskFile of taskFiles) {
        let lines: string[];
        try { lines = sanitizeGuardTargetLines(fs.readFileSync(taskFile, "utf-8")); } catch { continue; }
        for (const line of lines) {
            if (/^\s{0,3}#{2,6}\s/u.test(line)) break;
            const match = line.trim().match(/^(?:计划|目标计划(?:文件)?|Plan\s*文件)\s*[:：]\s*(?:\[[^\]]+\]\(([^)]+\.md)\)|`([^`]+\.md)`|(.+?\.md))\s*[。.]?\s*$/iu);
            const planFile = match && (match[1] || match[2] || match[3]);
            if (planFile && !/^[a-z]+:\/\//iu.test(planFile)) declared.push(path.resolve(path.dirname(taskFile), planFile));
        }
    }
    return [...new Set(declared)];
}

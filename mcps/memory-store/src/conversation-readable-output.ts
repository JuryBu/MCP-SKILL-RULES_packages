import type { CorpusToolParams } from "./tools/conversation-corpus-tool.js";
import { compactProgressiveRef } from "./conversation-progressive-reference.js";
import { formatRoundForMessageRoles, parseResponseAnnotations, type ConversationRound, type ConversationMessageRole } from "./trajectory.js";

type ResultObject = Record<string, unknown>;

function object(value: unknown): ResultObject {
    return value && typeof value === "object" && !Array.isArray(value) ? value as ResultObject : {};
}

function objects(value: unknown): ResultObject[] {
    return Array.isArray(value) ? value.map(object) : [];
}

function string(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function warningLines(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === "string"))].map(item => `⚠️ ${item}`) : [];
}

function nextCall(lines: string[], next: unknown, label = "➡️ 下一步参数"): void {
    if (Object.keys(object(next)).length) lines.push("", label, "```json", JSON.stringify(next), "```");
}

function nextFormat(value: unknown, format: "markdown" | "json"): unknown {
    if (Array.isArray(value)) return value.map(item => nextFormat(item, format));
    const entry = object(value);
    if (!Object.keys(entry).length) return value;
    if (typeof entry.action === "string") return /^(?:read_fast|read_hit|read_ready|read_result|search_ready|locate_ready|extract_ready|prepare(?:_status|_cancel|_resume)?|search_all(?:_status|_cancel|_resume)?)$/u.test(entry.action) ? { ...entry, format } : entry;
    return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, nextFormat(item, format)]));
}

export function withCorpusOutputFormat(value: unknown, format: "markdown" | "json"): unknown {
    const entry = object(value);
    if (!Object.keys(entry).length) return value;
    const output = { ...entry };
    if (entry.next) output.next = nextFormat(entry.next, format);
    for (const key of ["cachePreparation", "fullFetchCache", "ready", "prepared", "changes", "match"]) {
        if (entry[key]) output[key] = withCorpusOutputFormat(entry[key], format);
    }
    for (const key of ["hits", "results", "upserts"]) {
        if (Array.isArray(entry[key])) output[key] = entry[key].map(item => withCorpusOutputFormat(item, format));
    }
    return output;
}

function diagnosticLines(value: unknown, label: string): string[] {
    return Array.isArray(value) ? value.map(item => `⚠️ ${label}：${typeof item === "string" ? item : JSON.stringify(item)}`) : [];
}

function coverageLines(result: ResultObject): string[] {
    const coverage = object(result.coverage);
    const lines: string[] = [];
    if (coverage.scannedConversations !== undefined) lines.push(`扫描范围：${coverage.scannedConversations}/${coverage.candidateConversations}个候选对话${coverage.complete === false ? "，仍有未覆盖内容" : ""}`);
    if (coverage.discoveryComplete === false) lines.push("⚠️ 候选发现尚未完成");
    for (const key of ["committedConversations", "partialConversations", "errorConversations", "pendingConversations", "scannedMessages", "sourceBytes"]) {
        if (coverage[key] !== undefined) lines.push(`${key}：${coverage[key]}`);
    }
    lines.push(...diagnosticLines(coverage.warnings, "覆盖提示"), ...diagnosticLines(coverage.errors, "来源错误"));
    for (const status of objects(coverage.sourceStatuses)) {
        lines.push(`来源 ${status.source || "unknown"}：${status.status || "unknown"}${status.candidateCount !== undefined ? ` · 候选${status.candidateCount}` : ""}`);
        lines.push(...diagnosticLines(status.warnings, String(status.source)), ...diagnosticLines(status.errors, String(status.source)));
        if (status.error) lines.push(`⚠️ ${status.source}：${typeof status.error === "string" ? status.error : JSON.stringify(status.error)}`);
    }
    for (const key of ["scannedRounds", "scannedMessages", "totalHits", "hasMoreHits", "provisional", "sourceRangeVerified"]) {
        if (result[key] !== undefined) lines.push(`${key}：${result[key]}`);
    }
    const status = object(result.status);
    if (status.complete === false) lines.push("⚠️ 搜索只覆盖当前已准备的历史");
    for (const range of objects(result.searchedRanges || status.completeRanges)) lines.push(`搜索${range.kind === "relative" ? "相对" : "绝对"}轮次：${range.startRound}–${range.endRound}${range.blockId ? ` · blockId=${range.blockId}` : ""}`);
    return lines;
}

function attachmentLines(value: ResultObject): string[] {
    const references = new Set<string>();
    const lines: string[] = [];
    for (const attachment of objects(value.attachments)) {
        const reference = string(attachment.tempPath) || string(attachment.originalPath) || string(attachment.reference);
        if (reference.startsWith("data:")) continue;
        if (reference) {
            references.add(reference);
            lines.push(`📎 ${attachment.kind === "image" ? "图片" : "附件"}${attachment.name ? `「${attachment.name}」` : ""}：${reference}`);
        }
        if (attachment.warning) lines.push(`⚠️ ${attachment.warning}`);
        else if (attachment.exists === false) lines.push("⚠️ 附件原路径当前不可用，来源引用已保留");
    }
    for (const reference of Array.isArray(value.mediaAttachments) ? value.mediaAttachments : []) {
        if (typeof reference === "string" && !reference.startsWith("data:") && !references.has(reference)) lines.push(`📎 图片：${reference}`);
    }
    return lines;
}

function localDate(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTime(timestamp: string, pageDate: string): string {
    const date = new Date(timestamp);
    const day = localDate(timestamp);
    if (!day) return timestamp;
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return day === pageDate ? time : `${day} ${time}`;
}

function readableRef(reference: unknown): string {
    return compactProgressiveRef(string(reference)) || string(reference);
}

function detailsPreparationLines(result: ResultObject): string[] {
    if (result.phase !== "details-not-prepared") return [];
    const depths = [result.preparedDepth && `已准备 ${result.preparedDepth}`, result.requestedDepth && `请求 ${result.requestedDepth}`].filter(Boolean);
    return [`ℹ️ 已有正文可读，详情需要补充准备${depths.length ? `（${depths.join("，")}）` : ""}`, ...(result.detail ? [string(result.detail)] : []),
        ...(result.requestedSelection ? [`原请求范围：${JSON.stringify(result.requestedSelection)}`] : [])];
}

function messageLines(message: ResultObject, context: { source: string; baseSource: string; pageDate: string; brief: boolean }): string[] {
    const roles: Record<string, string> = { user: "👤 用户", assistant: "🤖 AI", tool: "🔧 工具", subagent: "🧩 子代理" };
    const briefRoles: Record<string, string> = { user: "👤", assistant: "🤖", tool: "🔧 工具", subagent: "🧩 子代理" };
    const role = string(message.role);
    const agent = role === "subagent" ? string(message.agentNickname) || string(message.nickname) || string(message.agentRole) : "";
    const cliInput = role === "user" && string(message.rawRole).startsWith("antigravity-cli.");
    const label = cliInput ? `📥 CLI 输入（原始source=${string(message.rawRole).split(".source=")[1] || "unknown"}，作者未核）` : (context.brief ? briefRoles : roles)[role] || role;
    const lines = [`### ${label}${agent ? ` · ${agent}` : ""}${message.timestamp ? ` · ${localTime(string(message.timestamp), context.pageDate)}` : ""}`];
    const source = string(message.sourceThreadId) || context.baseSource;
    if (source && source !== context.source) lines.push(`来源对话：\`${source}\``);
    if (source) context.source = source;
    const parsed = role === "user" ? parseResponseAnnotations(string(message.text)) : { text: string(message.text), annotations: [], warnings: [] };
    if (parsed.text) lines.push("", `${parsed.text}${context.brief && message.truncated === true && !parsed.text.endsWith("…") ? "…" : ""}`);
    const annotations = [...parsed.annotations, ...objects(message.annotations)];
    const displayedAnnotations = new Set<string>();
    for (const annotation of annotations) {
        const key = JSON.stringify([annotation.selectedText, annotation.comment]);
        if (displayedAnnotations.has(key)) continue;
        displayedAnnotations.add(key);
        lines.push("", "💬 用户批注");
        if (annotation.selectedText) lines.push(`选中文本：${annotation.selectedText}`);
        lines.push(`批注：${annotation.comment || "（未填写）"}`);
    }
    lines.push(...warningLines(parsed.warnings));
    lines.push(...attachmentLines(message));
    if (message.truncated === true && !context.brief) lines.push(`⚠️ 当前为简略文本${message.originalTextChars ? `，原文${message.originalTextChars}字符` : ""}，用depth=normal读取完整正文`);
    return lines;
}

function readLines(result: ResultObject, params: CorpusToolParams): string[] {
    const source = object(result.source);
    const conversation = object(result.conversation || source.conversation);
    const messages = objects(result.messages);
    const rounds = objects(result.rounds);
    const brief = params.depth === "brief";
    const baseSource = string(conversation.id) || string(source.conversationId) || params.conversationIds?.[0] || string(messages[0]?.sourceThreadId);
    const pageDate = messages.map(message => localDate(string(message.timestamp))).find(Boolean) || "";
    const context = { source: baseSource, baseSource, pageDate, brief };
    const lines = [`# 📖 ${string(conversation.title) || "对话原文"}`];
    const identity = [
        string(conversation.source) || string(source.host) || params.dataChain,
        baseSource,
    ].filter(Boolean);
    if (identity.length) lines.push(identity.join(" · "));
    if (conversation.workspace) lines.push(`工作区：${conversation.workspace}`);
    if (result.totalRounds !== undefined || source.totalRounds !== undefined) lines.push(`总轮次：${result.totalRounds ?? source.totalRounds}`);
    const relative = result.roundNumbering === "relative" || rounds.some(round => round.roundNumbering === "relative");
    const numbers = [...rounds.map(round => Number(round.round ?? round.roundIndex)), ...messages.map(message => Number(message.round))].filter(Number.isFinite);
    const firstRound = numbers.reduce((minimum, round) => Math.min(minimum, round), Infinity);
    const lastRound = numbers.reduce((maximum, round) => Math.max(maximum, round), -Infinity);
    const actualRange = numbers.length ? `${relative ? "相对" : ""}轮次${firstRound}–${lastRound}` : "";
    const lastRounds = params.lastRounds ?? result.requestedRounds ?? object(result.request).lastRounds;
    const selectedRange = lastRounds !== undefined ? `末${lastRounds}轮` : params.startRound !== undefined || params.endRound !== undefined
        ? `所选轮次${params.startRound ?? "起始"}–${params.endRound ?? "末尾"}` : params.rangeRef ? "固定引用范围" : "";
    if (selectedRange || actualRange) lines.push(`范围：${selectedRange}${selectedRange && actualRange ? " · 本页" : ""}${actualRange}`);
    if (pageDate) lines.push(`时间：${pageDate}（本机时间）`);
    if (conversation.isChildThread) lines.push(`子代理：${conversation.agentNickname || conversation.agentRole || conversation.id}${conversation.parentConversationId ? ` · 主对话：${conversation.parentConversationId}` : ""}`);
    if (result.requestedRangeComplete === false || result.partial === true) lines.push("⚠️ 当前只返回可读范围，未覆盖内容与来源缺口见后续提示");
    if (result.sourceRangeVerified === false) lines.push("⚠️ 来源范围仍待核验");
    if (result.fullSourceComplete === false || result.fullSourceProjectionComplete === false) lines.push("⏳ 其余历史尚未完整准备，已就绪内容可以继续使用");
    if (relative) lines.push("相对轮号仅属于当前已准备范围，绝对轮号仍待核实");
    lines.push(...detailsPreparationLines(result));
    let briefTruncated = messages.some(message => message.truncated === true);
    const metadata = new Map(rounds.map(round => [Number(round.round ?? round.roundIndex), round]));
    const grouped = new Map<number, ResultObject[]>();
    for (const message of messages) {
        const roundNumber = Number(message.round);
        const group = grouped.get(roundNumber);
        if (group) group.push(message);
        else grouped.set(roundNumber, [message]);
    }
    for (const round of rounds) if (!grouped.has(Number(round.round ?? round.roundIndex))) grouped.set(Number(round.round ?? round.roundIndex), []);
    for (const [roundNumber, group] of grouped) {
        const round = metadata.get(roundNumber) || {};
        lines.push("", "---", "");
        if (!conversation.isChildThread && typeof round.userMessage === "string" && Array.isArray(round.aiResponses)) {
            if (round.roundNumbering === "relative" || result.roundNumbering === "relative") lines.push(`相对轮次 ${roundNumber}（当前准备范围）`);
            const defaults = conversation.isChildThread ? (params.depth === "full" ? ["subagent", "tool"] : ["subagent"])
                : params.depth === "full" ? ["user", "assistant", "tool", "subagent"] : ["user", "assistant"];
            const roles = new Set<ConversationMessageRole>((params.messageRoles || defaults) as ConversationMessageRole[]);
            if (roles.delete("model" as ConversationMessageRole)) roles.add("assistant");
            let rendered = formatRoundForMessageRoles(round as unknown as ConversationRound, params.depth || "normal", params.extraTypes || [], roles, "full");
            const cliMessage = objects(round.userMessages).find(message => string(message.rawRole).startsWith("antigravity-cli."));
            if (cliMessage) rendered = rendered.replace(/### 👤 用户/gu, `### 📥 CLI 输入（原始source=${string(cliMessage.rawRole).split(".source=")[1] || "unknown"}，作者未核）`);
            if (brief) rendered = rendered.replace(/\n\n⚠️ 本段过长已截断（\d+→\d+字），可用 depth="full" 展开/gu, () => { briefTruncated = true; return "…"; });
            lines.push(rendered);
        } else {
            lines.push(`## ${round.roundNumbering === "relative" || result.roundNumbering === "relative" ? "相对轮次" : "轮次"} ${roundNumber}`);
            for (const message of group) lines.push("", ...messageLines(message, context));
            if (!group.some(message => message.role === "user")) lines.push(...attachmentLines(round));
            for (const detail of objects(round.thinking)) if (detail.thinking) lines.push("", "#### 💭 思考", string(detail.thinking));
            for (const detail of objects(round.aiResponses)) if (detail.thinking) lines.push("", "#### 💭 思考", string(detail.thinking));
            if (!group.some(message => message.role === "tool")) for (const detail of objects(round.toolCalls)) lines.push("", `#### 🔧 ${detail.name || detail.toolName || "工具详情"}`, JSON.stringify(detail, null, 2));
            for (const detail of objects(round.codeActions)) lines.push("", "#### 📝 代码修改", JSON.stringify(detail, null, 2));
            for (const detail of objects(round.fileViews)) lines.push("", "#### 📄 文件记录", JSON.stringify(detail, null, 2));
        }
        if (Array.isArray(round.toolSummary) && params.depth !== "full") {
            const summary = objects(round.toolSummary).map(tool => `${tool.name || "工具"} × ${tool.count ?? 1}`);
            if (summary.length) lines.push("", `🔧 工具概况：${summary.join("、")}`);
            else if (round.toolSummaryAvailable === false) lines.push("⚠️ 当前准备范围尚无工具名称概要");
        }
        if (params.extraTypes?.includes("tool_results")) for (const detail of objects(round.sourceEvents)) lines.push("", "#### 🔧 来源事件详情", JSON.stringify(detail, null, 2));
        if (round.ref) lines.push("", `固定引用：\`${readableRef(round.ref)}\``);
        if (round.blockId && !(compactProgressiveRef(string(round.ref)) && string(round.ref).split(":")[3] === round.blockId)) lines.push(`已发布块：\`${round.blockId}\``);
    }
    if (!grouped.size) lines.push("", "当前所选范围与角色没有可见正文");
    if (brief && briefTruncated) lines.push("", "ℹ️ 简读中…表示正文已截短，可用 depth=normal 继续，长段落用 depth=full 展开");
    for (const key of ["taskId", "ref", "blockId", "revision", "sourceRevision", "cacheRevision", "originRevision"] as const) {
        if (key === "blockId" && [result, ...rounds].some(round => compactProgressiveRef(string(round.ref)) && string(round.ref).split(":")[3] === result.blockId)) continue;
        if (result[key]) lines.push("", `${key}：\`${key === "ref" ? readableRef(result[key]) : result[key]}\``);
    }
    lines.push(...warningLines(result.warnings));
    const preparation = object(result.cachePreparation);
    if (preparation.taskId) lines.push(`⏳ 缓存准备任务：\`${preparation.taskId}\``);
    nextCall(lines, result.next || preparation.next);
    return lines;
}

function searchLines(result: ResultObject, params: CorpusToolParams): string[] {
    const matches = objects(result.results);
    const single = object(result.match);
    if (Object.keys(single).length) matches.push(single);
    const lines = ["# 🔍 对话正文搜索", `任务：\`${result.taskId || params.taskId || ""}\``];
    if (result.status || result.phase) lines.push(`状态：${typeof result.status === "string" ? result.status : result.phase || "已就绪范围"}`);
    for (const key of ["revision", "viewRevision", "sourceRevision", "cacheRevision", "originRevision"]) if (result[key] !== undefined) lines.push(`${key}：${result[key]}`);
    if (result.totalMatches !== undefined) lines.push(`已找到${result.totalMatches}个对话，本页${matches.length}个`);
    for (const match of matches) {
        const conversation = object(match.conversation);
        lines.push("", `## ${conversation.title || conversation.id || "命中对话"}`, `${conversation.source || params.dataChain || ""} · ${conversation.id || ""}`);
        lines.push(`出现${match.occurrences ?? 0}次 · 命中${match.matchedMessages ?? 0}条消息 · 轮次：${Array.isArray(match.rounds) ? match.rounds.join("、") : match.round ?? ""}`);
        const counts = Object.entries(object(match.termCounts)).map(([term, count]) => `「${term}」${count}次`);
        if (counts.length) lines.push(counts.join(" · "));
        if (match.latestMatchAt) lines.push(`最近命中：${match.latestMatchAt}`);
        if (match.sourceRevision) lines.push(`来源版本：\`${match.sourceRevision}\``);
        if (match.provisional) lines.push("⚠️ 当前计数与来源仍在核实，结果会继续更新");
        for (const snippet of objects(match.snippets)) {
            const relative = snippet.roundNumbering === "relative" || match.roundNumbering === "relative";
            lines.push("", `### ${relative ? "相对轮次" : "轮次"} ${snippet.round} · ${snippet.role}`, string(snippet.text));
            if (params.action !== "search_ready") {
                const revision = string(snippet.sourceRevision || match.sourceRevision);
                const verified = revision && !/^pending(?:[:/-]|$)/u.test(revision);
                if (Number.isSafeInteger(Number(snippet.round)) && Number(snippet.round) > 0 && conversation.id && (conversation.source || params.dataChain)) {
                    if (!verified) lines.push("⚠️ 命中来源版本仍待核验，可读取当前来源的对应范围");
                    nextCall(lines, { action: verified ? "read_hit" : "read_fast", conversationId: params.conversationId, conversationIds: [conversation.id], dataChain: conversation.source || params.dataChain,
                        ...(verified ? { sourceRevision: revision } : { prepareCache: false }),
                        ...(!verified && relative ? { lastRounds: 5 } : { startRound: snippet.round, endRound: snippet.round }) }, !verified && relative ? "➡️ 先读取近期上下文，精确命中等待原搜索完成" : "➡️ 展开命中轮次");
                }
            }
        }
        lines.push(...warningLines(match.warnings));
    }
    const changes = object(result.changes);
    if (Object.keys(changes).length) {
        lines.push("", "## 本次增量事件");
        for (const match of objects(changes.upserts)) {
            const conversation = object(match.conversation);
            lines.push(`增改：${conversation.source || ""} · ${conversation.id || ""} · sourceRevision=${match.sourceRevision || match.revision || ""}${match.provisional ? " · 暂计" : ""}`);
            if (match.termCounts) lines.push(`词频：${JSON.stringify(match.termCounts)}`);
        }
        for (const removed of objects(changes.removedConversations)) lines.push(`移除：${removed.source} · ${removed.conversationId}`);
        for (const key of ["removedConversationKeys", "removedConversationIds"]) if (Array.isArray(changes[key]) && changes[key].length) lines.push(`${key}：${JSON.stringify(changes[key])}`);
        lines.push(`本次已消费位置：${result.nextAfterRevision ?? changes.throughRevision} · 增量尚有后页：${changes.hasMore === true}`);
    }
    lines.push(...coverageLines(result));
    for (const hit of objects(result.hits)) {
        lines.push("", `### 命中轮次 ${hit.round ?? ""}`, string(hit.text || hit.snippet));
        if (hit.ref) lines.push(`固定引用：\`${readableRef(hit.ref)}\``);
        nextCall(lines, hit.next);
    }
    const request = object(result.request);
    const sources = params.dataChain ? { dataChain: params.dataChain } : params.dataChains ? { dataChains: params.dataChains }
        : Array.isArray(request.dataChains) ? { dataChains: request.dataChains } : {};
    const continuation = { action: "search_all_status", conversationId: params.conversationId || result.ownerId, taskId: result.taskId, ...sources,
        ...(params.limit === undefined ? {} : { limit: params.limit }) };
    if (result.hasMore && result.nextCursor) nextCall(lines, { ...continuation, continuationCursor: result.nextCursor }, "➡️ 结果下一页参数");
    if (changes.hasMore === true || ["running", "queued", "pending", "cancelling"].includes(string(result.status))) nextCall(lines, { ...continuation,
        afterRevision: result.nextAfterRevision ?? changes.throughRevision ?? params.afterRevision ?? result.revision ?? 0, waitSeconds: 1 }, "➡️ 继续消费变化参数");
    if (result.status === "resumable") nextCall(lines, { ...continuation, action: "search_all_resume" }, "➡️ 恢复原搜索任务");
    nextCall(lines, result.next);
    lines.push(...warningLines(result.warnings));
    if (result.error) lines.push(`⚠️ ${result.error}`);
    return lines;
}

function preparationLines(result: ResultObject): string[] {
    const ready = object(result.ready);
    const request = object(result.request);
    const stopped = ["done", "failed", "cancelled", "canceled", "resumable"].includes(string(result.status));
    const lines = ["# ⏳ 对话历史准备", `任务：\`${result.taskId || ""}\``, `状态：${result.status || result.phase || "准备中"}`];
    if (request.dataChain || request.conversationId) lines.push(`${request.dataChain || ""} · ${request.conversationId || ""}`);
    if (result.phase === "details-not-prepared") lines.push(...detailsPreparationLines(result));
    else if (result.rangeAvailable) lines.push(result.requestedRangeComplete === false
        ? stopped ? "⚠️ 本任务已结束，已取得部分范围；请求范围尚未全部取得" : "⏳ 已有部分范围可读，所需范围仍在准备"
        : "✅ 所需范围已经就绪，可以读取、搜索和定位");
    else lines.push(stopped ? "⚠️ 本任务已结束，未取得所需范围" : "⏳ 所需范围仍在准备，请沿原任务查询进度");
    if (result.fullSourceComplete === false) lines.push(stopped ? "本次未准备完整历史" : "⏳ 完整历史尚未准备完成");
    const progress = object(result.progress);
    if (progress.detail) lines.push(string(progress.detail));
    for (const range of objects(result.completeRanges || ready.completeRanges || object(ready.cache).completeRanges)) lines.push(`已就绪${range.kind === "relative" ? "相对" : ""}轮次：${range.startRound}–${range.endRound}${range.blockId ? ` · ${range.blockId}` : ""}`);
    if (Array.isArray(result.availableMessageRoles)) lines.push(`可读角色：${result.availableMessageRoles.join("、")}`);
    lines.push(...warningLines(result.warnings), ...warningLines(ready.warnings));
    if (result.error) lines.push(`⚠️ ${result.error}`);
    if (result.preparationError) lines.push(`⚠️ 完整历史准备失败：${result.preparationError}`);
    nextCall(lines, result.next);
    return lines;
}

export function formatCorpusReadableResult(value: unknown, params?: CorpusToolParams): string | undefined {
    if (!params || params.format === "json") return undefined;
    const result = object(value);
    if (result.delivery === "paged" && result.format === "markdown") {
        const lines = [string(result.text), "", `📄 字节范围：${result.startByte}–${result.endByte} / ${result.bytes}`, `完整结果：${result.artifactPath}`];
        nextCall(lines, result.next, "➡️ 继续读取参数");
        return lines.join("\n");
    }
    if (["read_fast", "read_hit", "read_ready", "locate_ready", "extract_ready"].includes(params.action) && Array.isArray(result.messages)) return readLines(result, params).join("\n");
    if (["search_all", "search_all_status", "search_ready"].includes(params.action) && (Array.isArray(result.results) || Array.isArray(result.hits))) return searchLines(result, params).join("\n");
    if ((params.action.startsWith("prepare") || ["read_fast", "read_ready", "search_ready"].includes(params.action)) && (result.taskId || result.phase === "details-not-prepared")) return preparationLines(result).join("\n");
    return undefined;
}

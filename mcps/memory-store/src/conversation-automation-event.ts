export const CONVERSATION_AUTOMATION_EVENT_VERSION = 1 as const;

export interface ConversationAutomationEvent {
    version: typeof CONVERSATION_AUTOMATION_EVENT_VERSION;
    channel: string;
    type: string;
    summary: string;
    identifiers?: Record<string, string>;
    generation?: string;
    pendingCount?: number;
    sequenceSummary?: string[];
    state?: string;
    needsHandling: boolean;
    ackRequired: boolean;
}

export interface ConversationAutomationProjection {
    event: ConversationAutomationEvent;
    userText?: string;
}

interface AutomationChannelRenderer {
    channel: string;
    label: string;
    matches: (marker: string) => boolean;
}

const CHANNEL_RENDERERS: AutomationChannelRenderer[] = [
    { channel: "codex-automation", label: "定时任务", matches: marker => marker === "CODEX_AUTOMATION_HEARTBEAT" },
    { channel: "napcat-qq", label: "QQ消息", matches: marker => marker.startsWith("NAPCAT_") },
    { channel: "wechat", label: "微信消息", matches: marker => marker.startsWith("WECHAT_") },
    { channel: "tencent-docs", label: "腾讯文档", matches: marker => marker.startsWith("TDOCS_") },
];

const IDENTITY_FIELDS = [
    "task_id",
    "subscription_id",
    "route_id",
    "route_key",
    "request_id",
    "proposed_task_id",
    "previous_task_id",
    "source_machine",
    "target_machine",
    "message_seq",
] as const;
const MAX_IDENTIFIER_CHARS = 160;
const MAX_SEQUENCE_ITEMS = 6;

function compactValue(value: string, maxChars = MAX_IDENTIFIER_CHARS): string {
    const compact = value.replace(/[\r\n\t]+/gu, " ").trim();
    return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}…`;
}

function parseScalarList(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
            return parsed
                .filter(item => typeof item === "string" || typeof item === "number")
                .map(item => compactValue(String(item), 80));
        }
    } catch {
        // Fall through to comma-separated legacy values.
    }
    return trimmed
        .replace(/^\[|\]$/gu, "")
        .split(",")
        .map(item => compactValue(item.replace(/^['"]|['"]$/gu, ""), 80))
        .filter(Boolean);
}

function resolveChannel(marker: string): AutomationChannelRenderer {
    const renderer = CHANNEL_RENDERERS.find(candidate => candidate.matches(marker));
    if (renderer) return renderer;
    const prefix = marker.split("_")[0]?.toLowerCase() || "external";
    return { channel: prefix, label: prefix.toUpperCase(), matches: () => true };
}

function normalizeEventType(marker: string): string {
    return marker.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function eventSummary(type: string): string {
    if (type === "codex_automation_heartbeat") return "定时任务已触发";
    if (type === "napcat_connection_request") return "收到自动建链请求";
    if (type === "napcat_owner_reply") return "主人通过QQ通道补充了消息";
    if (type.includes("wake")) return "有新的自动通道事件待处理";
    if (type.includes("alert")) return "自动通道报告了需要关注的状态";
    if (type.includes("monitor")) return "自动监控检测到变化";
    return "收到自动通道事件";
}

function parseFields(lines: string[]): Map<string, string> {
    const fields = new Map<string, string>();
    for (const line of lines.slice(1, 40)) {
        const match = line.match(/^([a-z][a-z0-9_]{1,64})\s*=\s*(.+)$/u);
        if (match && !fields.has(match[1])) fields.set(match[1], match[2].trim());
    }
    return fields;
}

function buildIdentifiers(fields: Map<string, string>): Record<string, string> {
    const identifiers: Record<string, string> = {};
    for (const key of IDENTITY_FIELDS) {
        const value = fields.get(key);
        if (value) identifiers[key] = compactValue(value);
    }
    return identifiers;
}

function readXmlElement(body: string, name: string): string | undefined {
    const match = body.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "u"));
    return match?.[1]?.trim();
}

function parseCodexAutomationHeartbeat(normalized: string): ConversationAutomationEvent | null {
    const root = normalized.match(/^<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>$/u);
    if (!root) return null;
    const body = root[1];
    const automationId = readXmlElement(body, "automation_id");
    const currentTime = readXmlElement(body, "current_time_iso");
    const instructions = readXmlElement(body, "instructions");
    const decision = readXmlElement(body, "decision");
    const message = readXmlElement(body, "message");
    if (!automationId || !(currentTime || instructions || decision || message)) return null;
    return {
        version: CONVERSATION_AUTOMATION_EVENT_VERSION,
        channel: "codex-automation",
        type: "codex_automation_heartbeat",
        summary: decision ? "定时任务已返回状态" : "定时任务已触发",
        identifiers: { automation_id: compactValue(automationId) },
        ...(decision ? { state: compactValue(decision, 40) } : {}),
        needsHandling: !decision || !/^(?:NONE|NOOP|SKIP|DONE)$/iu.test(decision),
        ackRequired: false,
    };
}

function parseBracketAutomationEvent(normalized: string): ConversationAutomationEvent | null {
    const lines = normalized.split(/\r?\n/u);
    const markerMatch = lines[0]?.match(/^\[([A-Z][A-Z0-9_-]{2,80})\]$/u);
    if (!markerMatch) return null;
    const marker = markerMatch[1];
    const isConnectionRequest = marker === "NAPCAT_CONNECTION_REQUEST";
    const isOwnerReply = marker === "NAPCAT_OWNER_REPLY";
    if (!/(?:WAKE|ALERT|NOTIFICATION|EVENT)$/u.test(marker) && !isConnectionRequest && !isOwnerReply) return null;

    const fields = parseFields(lines);
    const identifiers = buildIdentifiers(fields);
    const hasIdentity = Object.keys(identifiers).length > 0;
    const hasWakeState = fields.has("wake_id")
        || fields.has("generation")
        || [...fields.keys()].some(key => /^pending_.+(?:seqs|ids|count)$/u.test(key));
    const validConnectionRequest = isConnectionRequest
        && fields.has("request_id")
        && fields.has("proposed_task_id")
        && fields.has("source_machine")
        && fields.has("target_machine");
    const validOwnerReply = isOwnerReply && fields.has("route_key") && fields.has("message_seq");
    if (!hasIdentity || (!hasWakeState && !validConnectionRequest && !validOwnerReply)) return null;

    const sequenceField = [...fields.entries()].find(([key]) => /^pending_.+(?:seqs|ids)$/u.test(key));
    const sequences = sequenceField ? parseScalarList(sequenceField[1]) : [];
    const explicitCount = [...fields.entries()].find(([key]) => /(?:pending|message|event|batch)_count$/u.test(key));
    const parsedCount = explicitCount ? Number(explicitCount[1]) : Number.NaN;
    const pendingCount = Number.isFinite(parsedCount) && parsedCount >= 0
        ? Math.floor(parsedCount)
        : sequences.length || undefined;
    const type = normalizeEventType(marker);
    const ackRequired = /(?:\back\b|确认|回执)/iu.test(normalized) || fields.has("wake_id");
    const renderer = resolveChannel(marker);
    return {
        version: CONVERSATION_AUTOMATION_EVENT_VERSION,
        channel: renderer.channel,
        type,
        summary: eventSummary(type),
        ...(hasIdentity ? { identifiers } : {}),
        ...(fields.get("generation") ? { generation: compactValue(fields.get("generation")!, 40) } : {}),
        ...(pendingCount !== undefined ? { pendingCount } : {}),
        ...(sequences.length > 0 ? { sequenceSummary: sequences.slice(0, MAX_SEQUENCE_ITEMS) } : {}),
        needsHandling: type.includes("wake") || pendingCount !== undefined || isConnectionRequest || isOwnerReply,
        ackRequired: isOwnerReply || isConnectionRequest ? false : ackRequired,
    };
}

function parseNapcatOwnerReply(normalized: string): ConversationAutomationProjection | null {
    if (!normalized.startsWith("[NAPCAT_OWNER_REPLY]")) return null;
    const event = parseBracketAutomationEvent(normalized);
    if (!event) return null;
    const lines = normalized.split(/\r?\n/u);
    const directPayloadStart = lines.findIndex(line => /请把下面内容作为用户补充信息处理[：:]?\s*$/u.test(line.trim()));
    const bufferedStart = lines.findIndex(line => /主人此前连续发送了以下附件或媒体/u.test(line));
    const bufferedPayloadStart = lines.findIndex(line => /主人现在补充了明确文字/u.test(line));
    let userText = "";
    if (directPayloadStart >= 0) {
        userText = lines.slice(directPayloadStart + 1).join("\n").trim();
    } else if (bufferedStart >= 0 && bufferedPayloadStart > bufferedStart) {
        const bufferedItems = lines.slice(bufferedStart + 1, bufferedPayloadStart).join("\n").trim();
        const currentReply = lines.slice(bufferedPayloadStart + 1).join("\n").trim();
        userText = [
            bufferedItems ? `主人此前缓冲的附件或媒体：\n${bufferedItems}` : "",
            currentReply ? `主人当前回复：\n${currentReply}` : "",
        ].filter(Boolean).join("\n\n");
    }
    return { event, ...(userText ? { userText } : {}) };
}

export function projectConversationAutomationInput(text: string): ConversationAutomationProjection | null {
    const normalized = text.trim();
    const ownerReply = parseNapcatOwnerReply(normalized);
    if (ownerReply) return ownerReply;
    const event = parseCodexAutomationHeartbeat(normalized) || parseBracketAutomationEvent(normalized);
    return event ? { event } : null;
}

export function parseConversationAutomationEvent(text: string): ConversationAutomationEvent | null {
    const projection = projectConversationAutomationInput(text);
    return projection && !projection.userText ? projection.event : null;
}

export function conversationAutomationEventKey(event: ConversationAutomationEvent): string {
    return JSON.stringify({
        channel: event.channel,
        type: event.type,
        identifiers: event.identifiers || {},
        generation: event.generation || "",
        sequenceSummary: event.sequenceSummary || [],
        state: event.state || "",
    });
}

export function renderConversationAutomationEvent(event: ConversationAutomationEvent): string {
    const renderer = CHANNEL_RENDERERS.find(candidate => candidate.channel === event.channel);
    const label = renderer?.label || event.channel.toUpperCase();
    const details: string[] = [];
    for (const [key, value] of Object.entries(event.identifiers || {})) {
        details.push(`${key.replace(/_id$/u, "")}=${compactValue(value)}`);
    }
    if (event.generation) details.push(`generation=${compactValue(event.generation, 40)}`);
    if (event.pendingCount !== undefined) details.push(`待处理 ${event.pendingCount} 条`);
    if (event.sequenceSummary?.length) details.push(`序号摘要: ${event.sequenceSummary.join(", ")}`);
    if (event.state) details.push(`状态=${compactValue(event.state, 40)}`);
    if (event.needsHandling) details.push(event.ackRequired ? "需要处理并 ACK" : "需要处理");
    else details.push("无需处理");
    return `【自动${label}提醒】${event.summary}${details.length ? `｜${details.join("｜")}` : ""}`;
}

import { CONVERSATION_AUTOMATION_EVENT_VERSION, type ConversationAutomationEvent } from "./conversation-automation-event.js";
import type { ConversationSubagentNotification } from "./conversation-subagent-event.js";

export interface ConversationTaskNotificationSource {
    channel: string;
    kind?: string;
    rawRole: string;
}

export interface ConversationTaskNotificationEvent {
    automation: ConversationAutomationEvent;
    subagent?: ConversationSubagentNotification;
    rawText: string;
}

export interface ConversationTaskNotificationProjection {
    events: ConversationTaskNotificationEvent[];
    userText?: string;
}

function readNotificationField(body: string, name: string): string | undefined {
    const field = name.replace(/_/gu, "[-_]");
    return body.match(new RegExp(`<${field}>\\s*([\\s\\S]*?)\\s*</${field}>`, "iu"))?.[1]?.trim();
}

function compactNotificationText(text: string): string {
    const compact = text.replace(/\s+/gu, " ").trim();
    return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}

function projectTaskNotification(body: string, rawText: string, source: ConversationTaskNotificationSource): ConversationTaskNotificationEvent {
    const taskId = readNotificationField(body, "task_id");
    const status = readNotificationField(body, "status");
    const summary = readNotificationField(body, "summary");
    const result = readNotificationField(body, "result");
    const toolUseId = readNotificationField(body, "tool_use_id");
    const agentId = readNotificationField(body, "agent_id");
    const agentName = readNotificationField(body, "agent_name")
        || readNotificationField(body, "agent_nickname")
        || summary?.match(/^Agent\s+["“]([^"”]+)["”]/u)?.[1];
    const taskType = readNotificationField(body, "task_type");
    const isSubagent = Boolean(agentId || agentName || taskType === "agent" || source.kind?.startsWith("agent"));
    const identifiers: Record<string, string> = {};
    for (const [key, value] of [["task_id", taskId], ["tool_use_id", toolUseId], ["agent_id", agentId]]) {
        if (value) identifiers[key!] = compactNotificationText(value);
    }
    return {
        automation: {
            version: CONVERSATION_AUTOMATION_EVENT_VERSION,
            channel: source.channel,
            type: (source.kind || "task_notification").replace(/-/gu, "_"),
            summary: summary ? compactNotificationText(summary) : "收到后台任务通知",
            ...(Object.keys(identifiers).length ? { identifiers } : {}),
            state: status || "unparsed",
            needsHandling: !status || !/^(?:completed|cancelled|shutdown)$/iu.test(status),
            ackRequired: false,
        },
        ...(isSubagent ? {
            subagent: {
                threadId: agentId || "",
                nickname: agentName || "subagent",
                role: taskType || "agent",
                summary: result || summary || rawText,
                status: status || "unparsed",
                rawRole: source.rawRole,
                semanticRole: "subagent" as const,
            },
        } : {}),
        rawText,
    };
}

export function projectConversationTaskNotification(text: string, source: ConversationTaskNotificationSource): ConversationTaskNotificationProjection | null {
    if (!source.kind || !/(?:^|[-_])notification$/iu.test(source.kind)) return null;
    const events: ConversationTaskNotificationEvent[] = [];
    let remaining = text.trim();
    while (remaining) {
        const opening = remaining.match(/^<([a-z][a-z0-9_-]*)>/iu);
        if (!opening || opening[1].replace(/_/gu, "-").toLowerCase() !== source.kind.replace(/_/gu, "-").toLowerCase()) break;
        const closing = `</${opening[1]}>`;
        const closeIndex = remaining.indexOf(closing, opening[0].length);
        if (closeIndex < 0) break;
        const end = closeIndex + closing.length;
        const rawText = remaining.slice(0, end);
        const body = remaining.slice(opening[0].length, closeIndex);
        events.push(projectTaskNotification(body, rawText, source));
        remaining = remaining.slice(end).trimStart();
    }
    if (!events.length) return { events: [projectTaskNotification("", text, source)] };
    return { events, ...(remaining ? { userText: remaining } : {}) };
}

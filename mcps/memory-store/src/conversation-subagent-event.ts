export interface ConversationSubagentNotification {
    threadId: string;
    nickname: string;
    role?: string;
    summary?: string;
    status?: string;
    rawRole?: string;
    semanticRole: "subagent";
}

export interface ConversationSubagentProjection {
    notifications: ConversationSubagentNotification[];
    userText?: string;
}

function compactJson(value: unknown, maxChars = 2_000): string {
    let text: string;
    try {
        text = JSON.stringify(value);
    } catch {
        text = String(value);
    }
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function parseConversationSubagentNotification(block: string): ConversationSubagentNotification {
    const open = "<subagent_notification>";
    const close = "</subagent_notification>";
    const jsonText = block.slice(open.length, block.length - close.length).trim();
    try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const statusValue = parsed.status;
        const statusKey = typeof statusValue === "string"
            ? statusValue
            : statusValue && typeof statusValue === "object"
                ? ["completed", "errored", "failed", "cancelled", "shutdown", "running"]
                    .find(key => (statusValue as Record<string, unknown>)[key] !== undefined) || "updated"
                : "updated";
        const summaryValue = typeof statusValue === "string"
            ? statusValue
            : statusValue && typeof statusValue === "object"
                ? (statusValue as Record<string, unknown>)[statusKey]
                : "";
        return {
            threadId: typeof parsed.agent_path === "string" ? parsed.agent_path : "",
            nickname: typeof parsed.agent_nickname === "string" ? parsed.agent_nickname : "subagent",
            role: typeof parsed.agent_role === "string" ? parsed.agent_role : undefined,
            summary: typeof summaryValue === "string" ? summaryValue : compactJson(summaryValue),
            status: statusKey,
            rawRole: "response_item.message.user.subagent_notification",
            semanticRole: "subagent",
        };
    } catch {
        return {
            threadId: "",
            nickname: "subagent",
            summary: block,
            status: "unparsed",
            rawRole: "response_item.message.user.subagent_notification",
            semanticRole: "subagent",
        };
    }
}

export function projectConversationSubagentInput(text: string): ConversationSubagentProjection | null {
    const notifications: ConversationSubagentNotification[] = [];
    let remaining = text.trim();
    while (remaining.startsWith("<subagent_notification>")) {
        const close = "</subagent_notification>";
        const closeIndex = remaining.indexOf(close);
        if (closeIndex < 0) return null;
        const end = closeIndex + close.length;
        notifications.push(parseConversationSubagentNotification(remaining.slice(0, end)));
        remaining = remaining.slice(end).trimStart();
    }
    if (notifications.length === 0) return null;
    return { notifications, ...(remaining ? { userText: remaining } : {}) };
}

import type { ConversationRound } from "./trajectory.js";

export function devinText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return JSON.stringify(value, function (key, child) {
        if (["base64_data", "image_data", "blob"].includes(key)
            || (key === "data" && (this?.type === "image" || this?.mimeType?.startsWith("image/") || this?.mime_type?.startsWith("image/")))) return "[binary omitted]";
        return child;
    });
}

export function redactDevinBinary(value: unknown): string {
    if (typeof value === "string" && /^[\s]*[\[{]/u.test(value)) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object") {
                const sanitized = devinText(parsed);
                if (sanitized.includes("[binary omitted]")) value = sanitized;
            }
        } catch {}
    }
    return devinText(value)
        .replace(/data:[\w.+/-]+;base64,[a-zA-Z0-9+/=]+/gu, "[inline attachment]")
        .replace(/("(?:base64_data|image_data|blob)"\s*:\s*")[^"]*(")/gu, "$1[binary omitted]$2");
}

export function devinBlockText(block: any): string {
    if (!block || typeof block !== "object") return "";
    if (block.type === "text") return redactDevinBinary(block.text);
    if (block.type === "resource") return redactDevinBinary(block.resource?.text || "");
    if (block.type === "resource_link") return `[${devinText(block.name || "resource")}](${devinText(block.uri)})`;
    return "";
}

export function devinDesktopText(record: Record<string, any>): string {
    const blocks = Array.isArray(record.content) ? record.content : [record.content];
    const groups: string[] = [];
    let previousStream: string | undefined;
    for (const block of blocks) {
        const value = devinBlockText(block?.content || block);
        if (!value) continue;
        const stream = typeof block?.sessionUpdate === "string" && block.sessionUpdate.endsWith("_chunk")
            ? `${block.sessionUpdate}:${block._meta?.["cognition.ai/streamingMessageId"] || ""}` : undefined;
        if (stream && stream === previousStream && groups.length) groups[groups.length - 1] += value;
        else groups.push(value);
        previousStream = stream;
    }
    return groups.join("\n");
}

export function devinUserContent(message: Record<string, any>): { content: string; images: Record<string, any>[] } {
    let content = typeof message.content === "string" ? redactDevinBinary(message.content)
        : Array.isArray(message.content) ? message.content.map(devinBlockText).filter(Boolean).join("\n") : redactDevinBinary(message.content);
    const images = [...(Array.isArray(message.images) ? message.images : [])];
    const blocks = message.metadata?.extensions?.["chisel/acp-content-blocks"];
    for (const wrapped of Array.isArray(blocks) ? blocks : []) {
        const block = wrapped?.content || wrapped;
        if (block?.type === "image") images.push(block);
        if (block?.type === "resource" || block?.type === "resource_link") {
            const quoted = devinBlockText(block);
            if (quoted && !content.includes(quoted)) content += `${content ? "\n\n" : ""}${quoted}`;
        }
    }
    const unique = new Map<string, Record<string, any>>();
    for (const image of images.filter(image => image && typeof image === "object")) {
        unique.set(devinText(image.base64_data || image.data || image.source_path || image), image);
    }
    return { content, images: [...unique.values()] };
}

export function addDevinToolDetails(round: ConversationRound, name: string, rawArgs: unknown, step: number, result = ""): void {
    let args: Record<string, any>;
    try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs as Record<string, any>; } catch { return; }
    if (!args || typeof args !== "object") return;
    if (name === "edit" || name === "write") {
        const targetFile = devinText(args.file_path || args.path);
        if (targetFile) round.codeActions.push({
            stepIndex: step, description: name, targetFile, instruction: `${name} ${targetFile}`,
            diffs: [{ targetContent: redactDevinBinary(args.old_string || ""), replacementContent: redactDevinBinary(name === "write" ? args.content : args.new_string) }],
        });
    }
    if (name === "todo_write") {
        for (const todo of Array.isArray(args.todos) ? args.todos : []) round.taskBoundaries.push({ stepIndex: step, taskName: redactDevinBinary(todo.content), taskStatus: devinText(todo.status) });
    }
    if (name === "read") {
        round.fileViews ??= [];
        round.fileViews.push({ stepIndex: step, kind: "file_read", title: devinText(args.file_path || args.path), textSummary: result });
    }
}

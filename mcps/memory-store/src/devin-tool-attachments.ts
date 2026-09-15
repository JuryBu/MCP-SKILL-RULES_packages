import { createHash } from "node:crypto";
import type { ConversationRound } from "./trajectory.js";
import type { DevinRawConversation } from "./devin-types.js";

export function attachDevinToolImages(raw: DevinRawConversation, rounds: ConversationRound[]): void {
    const owners = new Map<string, { round: ConversationRound; step: number }>();
    const seen = new Set<string>();
    let inspected = 0;
    let imageCount = 0;
    let limited = false;
    const collect = (value: unknown, round: ConversationRound, step: number, depth = 0): void => {
        if (depth > 12 || inspected++ >= 20_000 || imageCount >= 256) { limited = true; return; }
        if (typeof value === "string") {
            if (/^\s*[\[{]/u.test(value)) {
                try { collect(JSON.parse(value), round, step, depth + 1); } catch {}
            }
            return;
        }
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) collect(item, round, step, depth + 1); return; }
        const item = value as Record<string, unknown>;
        const mimeType = String(item.mimeType || item.mime_type || "image/png");
        const encoded = item.base64_data || item.data;
        if (item.type === "image" && typeof encoded === "string" && mimeType.startsWith("image/")) {
            const sha256 = createHash("sha256").update(encoded).digest("hex");
            const key = `${round.roundIndex}:${step}:${sha256}`;
            if (!seen.has(key)) {
                seen.add(key);
                imageCount++;
                const attachment = {
                    kind: "image" as const, source: "devin-inline-image" as const, mimeType, stepIndex: step,
                    reference: `devin-tool:${raw.summary.canonicalId}:${step}:${sha256.slice(0, 16)}`,
                    dataUrl: `data:${mimeType};base64,${encoded}`,
                    sizeBytes: Math.floor(encoded.replace(/=+$/u, "").length * 3 / 4),
                    width: typeof item.width === "number" ? item.width : undefined,
                    height: typeof item.height === "number" ? item.height : undefined,
                };
                round.attachments = [...(round.attachments || []), attachment];
                const event = round.semanticEvents?.find(entry => entry.semanticRole === "tool" && entry.stepIndex === step);
                if (event) (event.attachments ||= []).push(attachment);
            }
            return;
        }
        for (const nested of Object.values(item)) collect(nested, round, step, depth + 1);
    };
    for (const [step, node] of raw.nodes.entries()) {
        const message = node.message;
        const round = rounds.find(item => step >= item.startStep && step <= item.endStep);
        if (!round) continue;
        if (message.role === "assistant") {
            for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) owners.set(String(call.id), { round, step });
        } else if (message.role === "tool") {
            const owner = owners.get(String(message.tool_call_id));
            collect(message.content, owner?.round || round, owner?.step ?? step);
        }
    }
    for (const entry of raw.desktopMessages) {
        if (entry.kind !== "tool_call") continue;
        const state = entry.payload.content || entry.payload;
        const owner = owners.get(String(state.toolCallId || entry.payload.id).replace(/^tool:/u, ""));
        if (owner) collect(state.rawOutput || state.content, owner.round, owner.step);
    }
    if (limited && !raw.warnings.includes("DEVIN_TOOL_IMAGE_DISCOVERY_LIMIT")) raw.warnings.push("DEVIN_TOOL_IMAGE_DISCOVERY_LIMIT");
}

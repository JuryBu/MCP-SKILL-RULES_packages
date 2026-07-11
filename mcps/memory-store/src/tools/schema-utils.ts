import { z } from "zod";
import { CHAIN_INPUT_VALUES } from "../chain.js";

const MODEL_CHAIN_ALLOWED = "auto|antigravity|codex|claude-code|cc|grok";

function modelChainError(parameterName: string, received: unknown): string {
    const value = String(received || "").trim().toLowerCase();
    if (value === "windsurf" || value === "wsf") {
        return `${parameterName} 不支持 windsurf/wsf：Windsurf 只提供对话数据链路。请使用 dataChain="windsurf"，并把 modelChain 设为 ${MODEL_CHAIN_ALLOWED}`;
    }
    return `${parameterName} 只支持 ${MODEL_CHAIN_ALLOWED}`;
}

export function modelChainInputSchema(parameterName = "modelChain", description?: string) {
    const schemaDescription = description
        ? `${description}；支持 ${MODEL_CHAIN_ALLOWED}`
        : `${parameterName} 模型链路；支持 ${MODEL_CHAIN_ALLOWED}`;
    return z.enum(CHAIN_INPUT_VALUES, {
        errorMap: issue => ({ message: modelChainError(parameterName, (issue as { received?: unknown }).received) }),
    }).optional().describe(schemaDescription);
}

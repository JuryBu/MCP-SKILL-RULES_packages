import { z } from "zod";
import { CHAIN_INPUT_VALUES, DATA_CHAIN_INPUT_VALUES } from "../chain.js";

const MODEL_CHAIN_ALLOWED = "auto|antigravity|codex|claude-code|cc|grok|agy";
const DATA_CHAIN_ALLOWED = "auto|antigravity|codex|claude-code|cc|windsurf|wsf";

function modelChainError(parameterName: string, received: unknown): string {
    const value = String(received || "").trim().toLowerCase();
    if (value === "windsurf" || value === "wsf") {
        return `${parameterName} 不支持 windsurf/wsf：Windsurf 只提供对话数据链路。请使用 dataChain="windsurf"，并把 modelChain 设为 ${MODEL_CHAIN_ALLOWED}`;
    }
    return `${parameterName} 只支持 ${MODEL_CHAIN_ALLOWED}`;
}

function dataChainError(parameterName: string, received: unknown): string {
    const value = String(received || "").trim().toLowerCase();
    if (value === "grok") {
        return `${parameterName} 不支持 grok：Grok 只提供模型链路。请使用 modelChain="grok"，并把 ${parameterName} 设为 ${DATA_CHAIN_ALLOWED}`;
    }
    if (value === "agy") {
        return `${parameterName} 不支持 agy：agy CLI 只提供模型链路。请使用 modelChain="agy"，并把 ${parameterName} 设为 ${DATA_CHAIN_ALLOWED}`;
    }
    return `${parameterName} 只支持 ${DATA_CHAIN_ALLOWED}`;
}

export function modelChainInputSchema(parameterName = "modelChain", description?: string) {
    const schemaDescription = description
        ? `${description}；支持 ${MODEL_CHAIN_ALLOWED}`
        : `${parameterName} 模型链路；支持 ${MODEL_CHAIN_ALLOWED}`;
    return z.enum(CHAIN_INPUT_VALUES, {
        errorMap: issue => ({ message: modelChainError(parameterName, (issue as { received?: unknown }).received) }),
    }).optional().describe(schemaDescription);
}

export function dataChainValueSchema(parameterName = "dataChain", description?: string) {
    const schemaDescription = description
        ? `${description}；支持 ${DATA_CHAIN_ALLOWED}`
        : `${parameterName} 对话数据链路；支持 ${DATA_CHAIN_ALLOWED}`;
    return z.enum(DATA_CHAIN_INPUT_VALUES, {
        errorMap: issue => ({ message: dataChainError(parameterName, (issue as { received?: unknown }).received) }),
    }).describe(schemaDescription);
}

export function dataChainInputSchema(parameterName = "dataChain", description?: string) {
    return dataChainValueSchema(parameterName, description).optional();
}

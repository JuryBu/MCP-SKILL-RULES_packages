export const CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code"] as const;
export const CHAIN_INPUT_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc"] as const;
export const DATA_CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code", "windsurf"] as const;
export const DATA_CHAIN_INPUT_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc", "windsurf", "wsf"] as const;

export type Chain = typeof CHAIN_VALUES[number];
export type ChainInput = typeof CHAIN_INPUT_VALUES[number];
export type DataChain = typeof DATA_CHAIN_VALUES[number];
export type DataChainInput = typeof DATA_CHAIN_INPUT_VALUES[number];

export type ConversationLinkMode = "reference" | "summary" | "expand_children";

export const DEFAULT_CHAIN: Chain = "auto";

export const DEFAULT_LINK_MODE: ConversationLinkMode = "summary";

export interface ChainSplitInput {
    chain?: ChainInput | DataChainInput | string;
    dataChain?: DataChainInput | string;
    modelChain?: ChainInput | string;
}

export interface ChainSplit {
    chain: Chain;
    dataChain: DataChain;
    modelChain: Chain;
}

export function isWindsurfAlias(input: unknown): boolean {
    const value = String(input || "").trim().toLowerCase();
    return value === "windsurf" || value === "wsf";
}

export function assertValidModelChainInput(input: unknown, parameterName = "modelChain"): void {
    if (isWindsurfAlias(input)) {
        throw new Error(`${parameterName} 不支持 windsurf/wsf：Windsurf 只提供对话数据链路。请使用 dataChain="windsurf"，并把 modelChain 设为 auto|antigravity|codex|claude-code|cc`);
    }
}

export function normalizeChain(input: ChainInput | string | undefined, fallback: Chain = DEFAULT_CHAIN): Chain {
    if (!input) return fallback;
    const value = String(input).trim().toLowerCase();
    if (value === "cc") return "claude-code";
    if ((CHAIN_VALUES as readonly string[]).includes(value)) return value as Chain;
    return fallback;
}

export function normalizeDataChain(input: DataChainInput | ChainInput | string | undefined, fallback: DataChain = DEFAULT_CHAIN): DataChain {
    if (!input) return fallback;
    const value = String(input).trim().toLowerCase();
    if (value === "cc") return "claude-code";
    if (value === "wsf") return "windsurf";
    if ((DATA_CHAIN_VALUES as readonly string[]).includes(value)) return value as DataChain;
    return fallback;
}

/**
 * Backward-compatible chain routing:
 * - chain defaults to auto.
 * - dataChain defaults to chain.
 * - modelChain defaults to chain.
 * - chain="windsurf"/"wsf" only affects dataChain; modelChain falls back to auto.
 */
export function resolveChainSplit(input: ChainSplitInput = {}): ChainSplit {
    assertValidModelChainInput(input.modelChain, "modelChain");
    const chain = normalizeChain(input.chain);
    const dataFallback = normalizeDataChain(input.chain, chain);
    return {
        chain,
        dataChain: normalizeDataChain(input.dataChain, dataFallback),
        modelChain: normalizeChain(input.modelChain, chain),
    };
}

export function resolveModelOnlyChainSplit(input: Pick<ChainSplitInput, "chain" | "modelChain"> = {}): ChainSplit {
    assertValidModelChainInput(input.chain, "chain");
    assertValidModelChainInput(input.modelChain, "modelChain");
    return resolveChainSplit(input);
}

export function formatChainSplit(split: ChainSplit): string {
    if (split.dataChain === split.modelChain) {
        return `chain=${split.chain}, data/model=${split.dataChain}`;
    }
    return `chain=${split.chain}, data=${split.dataChain}, model=${split.modelChain}`;
}

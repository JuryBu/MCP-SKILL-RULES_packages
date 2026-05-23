export const CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code"] as const;
export const CHAIN_INPUT_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc"] as const;

export type Chain = typeof CHAIN_VALUES[number];
export type ChainInput = typeof CHAIN_INPUT_VALUES[number];

export type ConversationLinkMode = "reference" | "summary" | "expand_children";

export const DEFAULT_CHAIN: Chain = "auto";

export const DEFAULT_LINK_MODE: ConversationLinkMode = "summary";

export interface ChainSplitInput {
    chain?: ChainInput | string;
    dataChain?: ChainInput | string;
    modelChain?: ChainInput | string;
}

export interface ChainSplit {
    chain: Chain;
    dataChain: Chain;
    modelChain: Chain;
}

export function normalizeChain(input: ChainInput | string | undefined, fallback: Chain = DEFAULT_CHAIN): Chain {
    if (!input) return fallback;
    const value = String(input).trim().toLowerCase();
    if (value === "cc") return "claude-code";
    if ((CHAIN_VALUES as readonly string[]).includes(value)) return value as Chain;
    return fallback;
}

/**
 * Backward-compatible chain routing:
 * - chain defaults to auto.
 * - dataChain defaults to chain.
 * - modelChain defaults to chain.
 */
export function resolveChainSplit(input: ChainSplitInput = {}): ChainSplit {
    const chain = normalizeChain(input.chain);
    return {
        chain,
        dataChain: normalizeChain(input.dataChain, chain),
        modelChain: normalizeChain(input.modelChain, chain),
    };
}

export function formatChainSplit(split: ChainSplit): string {
    if (split.dataChain === split.modelChain) {
        return `chain=${split.chain}, data/model=${split.dataChain}`;
    }
    return `chain=${split.chain}, data=${split.dataChain}, model=${split.modelChain}`;
}

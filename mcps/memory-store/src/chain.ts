export const CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code", "grok"] as const;
export const CHAIN_INPUT_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc", "grok"] as const;
export const DATA_CHAIN_VALUES = ["auto", "antigravity", "codex", "claude-code", "windsurf"] as const;
export const DATA_CHAIN_INPUT_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc", "windsurf", "wsf"] as const;
export const CHAIN_COMPAT_INPUT_VALUES = ["auto", "antigravity", "codex", "claude-code", "cc", "windsurf", "wsf", "grok"] as const;

export type Chain = typeof CHAIN_VALUES[number];
export type ChainInput = typeof CHAIN_INPUT_VALUES[number];
export type DataChain = typeof DATA_CHAIN_VALUES[number];
export type DataChainInput = typeof DATA_CHAIN_INPUT_VALUES[number];
export type ChainCompatInput = typeof CHAIN_COMPAT_INPUT_VALUES[number];

export type ConversationLinkMode = "reference" | "summary" | "expand_children";
export type ConversationLogicalChainMode = "off" | "explain" | "auto" | "strict";

export const DEFAULT_CHAIN = "auto";

export const DEFAULT_LINK_MODE: ConversationLinkMode = "summary";

export interface ChainSplitInput {
    chain?: ChainCompatInput | string;
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

export function isGrokAlias(input: unknown): boolean {
    const value = String(input || "").trim().toLowerCase();
    return value === "grok";
}

export function assertValidModelChainInput(input: unknown, parameterName = "modelChain"): void {
    if (isWindsurfAlias(input)) {
        throw new Error(`${parameterName} 不支持 windsurf/wsf：Windsurf 只提供对话数据链路。请使用 dataChain="windsurf"，并把 modelChain 设为 auto|antigravity|codex|claude-code|cc|grok`);
    }
}

export function assertValidDataChainInput(input: unknown, parameterName = "dataChain"): void {
    if (isGrokAlias(input)) {
        throw new Error(`${parameterName} 不支持 grok：Grok 只提供模型链路。请使用 modelChain="grok"，并把 dataChain 设为 auto|antigravity|codex|claude-code|cc|windsurf|wsf`);
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
 * - chain="grok" only affects modelChain; dataChain falls back to auto.
 */
export function resolveChainSplit(input: ChainSplitInput = {}): ChainSplit {
    assertValidModelChainInput(input.modelChain, "modelChain");
    assertValidDataChainInput(input.dataChain, "dataChain");
    const chain = normalizeChain(input.chain);
    const dataFallback = isGrokAlias(input.chain) ? DEFAULT_CHAIN : normalizeDataChain(input.chain, chain === "grok" ? DEFAULT_CHAIN : chain);
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

/**
 * 旧兼容用的重链路判定：codex 链路走本地 CLI 调用，长模型任务易撞宿主同步超时。
 * Plan_30 后新工具优先由 handler 显式传 autoMode；本函数只保留给旧的 heavy-chain 默认策略。
 */
export function isHeavyChain(chain: Chain): boolean {
    return chain === "codex";
}

export interface BackgroundDecision {
    /** 是否走后台 */
    useBackground: boolean;
    /** 是否因默认策略自动转的（用于给返回文案加提示） */
    auto: boolean;
}

export type BackgroundAutoMode = "heavy-chain" | "always" | "never";

/**
 * 三态 background 决策（C3 块B / Plan_30）——record update / batch/export / stage_guard check / golden_extract 共用。
 * ⚠️ 三态布尔陷阱：必须严格区分 `=== false` 与 `=== undefined`，不能写 `if(background)`
 * 把两者混为一谈：
 *   - background === true  → 强制后台
 *   - background === false → 强制同步（即便 heavy 链路也同步）
 *   - background === undefined → 由 autoMode 决定：
 *     - "always": 自动后台（record update / golden_extract）
 *     - "never": 保持同步（stage_guard check）
 *     - "heavy-chain": 仅 heavy 链路（codex）自动后台（旧兼容）
 */
export function decideBackground(background: boolean | undefined, modelChain: Chain, autoMode: BackgroundAutoMode = "heavy-chain"): BackgroundDecision {
    if (background === true) return { useBackground: true, auto: false };
    if (background === false) return { useBackground: false, auto: false };
    // background === undefined
    const auto = autoMode === "always" ? true : autoMode === "never" ? false : isHeavyChain(modelChain);
    return { useBackground: auto, auto };
}

export function formatChainSplit(split: ChainSplit): string {
    if (split.dataChain === split.modelChain) {
        return `chain=${split.chain}, data/model=${split.dataChain}`;
    }
    return `chain=${split.chain}, data=${split.dataChain}, model=${split.modelChain}`;
}

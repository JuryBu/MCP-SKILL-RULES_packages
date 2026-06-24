// Record 生成引擎 —— 共享类型定义（依赖图最底层，零业务模块依赖）。
// 由 record-generator.ts 拆分而来（E2-B2），纯结构搬运、零行为变更。
import type { ConversationRound } from "./trajectory.js";
import type { Chain } from "./chain.js";

export interface RecordModelCallResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
}

export interface FormattedRecordRound {
    round: ConversationRound;
    text: string;
    chars: number;
}

export interface RecordChunk {
    startRound: number;
    endRound: number;
    rounds: ConversationRound[];
    text: string;
    chars: number;
}

export interface RecordPatch {
    startRound: number;
    endRound: number;
    title: string;
    files: string[];
    tags: string[];
    risks: string[];
    status: string;
    markdown: string;
}

export type RecordParallelMode = "off" | "auto" | "force";

export interface RecordPatchCheckpoint {
    version: number;
    kind: "map" | "compress";
    status: "done" | "failed" | "timeout" | "invalid";
    conversationId: string;
    workspace: string;
    modelChain: Chain;
    startRound: number;
    endRound: number;
    promptHash: string;
    savedAt: string;
    patch?: RecordPatch;
    error?: string;
}

export interface ParsedRecordPhase {
    number: number;
    title: string;
    startRound: number;
    endRound: number;
    content: string;
}

export interface ParsedRecordDocument {
    header: string;
    phases: ParsedRecordPhase[];
    tail: string;
    tags: string[];
    manualSupplementSnippets: string[];
    parseWarnings: string[];
}

export interface LocalComposeBoundary {
    stablePhases: ParsedRecordPhase[];
    rollbackPhases: ParsedRecordPhase[];
    stableEndRound: number;
    rewriteStartRound: number;
    rollbackCount: number;
    reason: string;
}

export interface LocalComposeDelta {
    rewriteStartRound: number;
    rewriteEndRound: number;
    phaseMarkdown: string;
    tailMarkdown: string;
    tags: string[];
    warnings: string[];
}

export interface ComposeValidationResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
    candidatePath?: string;
}

/** 超大轮的某个 step 区间子片段，对应一个待压缩的 part。 */
export interface RoundSplitPart {
    /** 该 part 覆盖的 step 起点（含）。 */
    startStep: number;
    /** 该 part 覆盖的 step 终点（含）。 */
    endStep: number;
    /** 该 part 用合成子轮 formatRound 出来的原始文本（可能已被 capSingleRoundText 兜底）。 */
    rawText: string;
}

// ============= 核心生成逻辑 =============

export interface GenerateRecordResult {
    success: boolean;
    content?: string;
    error?: string;
    batches?: number;
    coveredRounds?: number;
    tags?: string[];
    pipeline?: "serial" | "parallel";
    upToDate?: boolean;
    warnings?: string[];
}

export interface GenerateRecordOptions {
    background?: boolean;
    allowClaudeCodeFallback?: boolean;
    parallelMode?: RecordParallelMode;
    force?: boolean;
    onProgress?: (progress: {
        stage?: string;
        detail?: string;
        current?: number;
        total?: number;
        unit?: string;
    }) => void;
}

/** 串行步累积器状态 */
export interface SerialComposeAccumulator {
    closedPhaseMarkdown: string[];
    openPhase: { startRound: number; endRound: number; markdown: string } | null;
    lastEndRound: number;
    warnings: string[];
    tags: string[];
}

/** 串行步模型输出的单个 Phase 增量 */
export interface SerialStepPhase {
    title?: string;
    startRound?: number;
    endRound?: number;
    open?: boolean;
    markdown?: string;
}

export interface SerialStepDelta {
    phases: SerialStepPhase[];
    warnings: string[];
}

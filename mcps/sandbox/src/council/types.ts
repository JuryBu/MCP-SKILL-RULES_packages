export type CouncilProvider =
    | "antigravity"
    | "codex"
    | "openai"
    | "anthropic"
    | "gemini"
    | "geminiCli"
    | "grok"
    | "claudeCode"
    | "customOpenAICompatible";

export type CouncilMode = "red_blue_black" | "design" | "review" | "guard_check" | "custom";
export type CouncilContextMode = "none" | "summary" | "full" | "manual";
export type CouncilToolName = "webSearch" | "webFetchText" | "simpleScript";

export interface CouncilModelConfig {
    id: string;
    role: string;
    provider: CouncilProvider;
    model?: string;
    params?: Record<string, unknown>;
    supportsVision?: boolean;
}

export interface CouncilFileInput {
    path: string;
    range?: string;
    label?: string;
}

export interface CouncilLargeInputConfig {
    enabled?: boolean;
    thresholdChars?: number;
    chunkSize?: number;
    overlap?: number;
    maxChunks?: number;
    previewChars?: number;
    contextMaxChars?: number;
    includeChunkText?: boolean;
}

export interface CouncilLargeInputArtifact {
    id: string;
    label?: string;
    sourceKind: "input" | "manualContext" | "file";
    sourcePath?: string;
    sourceCharCount: number;
    sourceSha256: string;
    chunkCount: number;
    chunkSize: number;
    overlap: number;
    duplicatedCharCount: number;
    coverageRatio: number;
    checkpointPath: string;
    indexPath: string;
    sourceTextPath?: string;
    warnings?: string[];
}

export interface CouncilToolConfig {
    webSearch?: boolean;
    webFetchText?: boolean;
    simpleScript?: boolean;
}

export interface CouncilToolCall {
    tool: CouncilToolName;
    args: Record<string, unknown>;
    reason?: string;
}

export interface CouncilToolResult {
    tool: CouncilToolName;
    args: Record<string, unknown>;
    reason?: string;
    ok: boolean;
    text: string;
}

export interface CouncilTurnMessage {
    round: number;
    participantId: string;
    role: string;
    provider: CouncilProvider;
    model?: string;
    text: string;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface CouncilModeratorDecision {
    action: "continue" | "tool" | "ask" | "terminate";
    summary: string;
    targetParticipantId?: string;
    instruction?: string;
    toolCall?: CouncilToolCall;
    toolCalls?: CouncilToolCall[];
    toolResults?: CouncilToolResult[];
    afterToolInstruction?: string;
    finalAnswer?: string;
    rawText: string;
    metadata?: Record<string, unknown>;
}

export interface CouncilTranscript {
    id: string;
    mode: CouncilMode;
    input: string;
    contextMode: CouncilContextMode;
    participants: CouncilModelConfig[];
    moderator: CouncilModelConfig;
    files: Array<{
        path: string;
        label?: string;
        range?: string;
        ok: boolean;
        text: string;
        kind?: string;
        ingestMode?: string;
        parser?: string;
        warnings?: string[];
        artifactPath?: string;
        metadata?: Record<string, unknown>;
    }>;
    largeInputs?: CouncilLargeInputArtifact[];
    images: string[];
    imageObservations: string;
    textProjection?: string;
    rounds: Array<{
        round: number;
        messages: CouncilTurnMessage[];
        moderator: CouncilModeratorDecision;
        moderatorSteps?: CouncilModeratorDecision[];
        toolResult?: CouncilToolResult;
        toolResults?: CouncilToolResult[];
    }>;
    terminationReason: string;
    finalAnswer: string;
    createdAt: string;
    markdownPath?: string;
    jsonPath?: string;
}

export type CouncilCheckpointPhase = "prepared" | "participants" | "moderator" | "round_complete";

export interface CouncilCheckpoint {
    taskId?: string;
    transcriptId: string;
    currentRound: number;
    lastCompletedRound: number;
    phase: CouncilCheckpointPhase;
    roundComplete: boolean;
    updatedAt: string;
}

export interface CouncilResumeState {
    sourceTaskId: string;
    checkpoint: CouncilCheckpoint;
    transcript: CouncilTranscript;
}

export interface CouncilRunParams {
    participants: CouncilModelConfig[];
    moderator: CouncilModelConfig;
    input: string;
    files?: CouncilFileInput[];
    images?: string[];
    contextMode?: CouncilContextMode;
    manualContext?: string;
    mode?: CouncilMode;
    roles?: Record<string, string>;
    tools?: CouncilToolConfig;
    maxRounds?: number;
    maxToolCalls?: number;
    transcriptPath?: string;
    outputDir?: string;
    transcriptionModel?: CouncilModelConfig;
    textProjectionModel?: CouncilModelConfig;
    largeInput?: CouncilLargeInputConfig;
    modelTimeoutMs?: number;
    pressureModelTimeoutMs?: number;
    checkpointPath?: string;
    resumeState?: CouncilResumeState;
    ownerId?: string;
    onProgress?: (progress: string) => void;
}

import type { ConversationRound } from "./trajectory.js";
import type { CorpusConversation, CorpusMessage, CorpusSearchRequest } from "./conversation-corpus-types.js";
import type { CorpusConversationMatch } from "./conversation-corpus-search.js";

export interface ProgressiveSource {
    conversationId: string;
    host: string;
    revision: string;
    snapshot: unknown;
    totalRounds?: number;
    conversation?: CorpusConversation;
}

export interface ProgressiveCoverage {
    kind: "absolute" | "relative";
    startRound: number;
    endRound: number;
}

export interface ProgressivePublishInput {
    coverage: ProgressiveCoverage;
    anchor: unknown;
    sourceSnapshot?: unknown;
    sourceRevision?: string;
    order?: number;
    rounds: readonly ConversationRound[];
    messages: readonly CorpusMessage[];
}

export interface ProgressiveWriter {
    token: string;
    sourceKey: string;
}

export interface ProgressiveBlock {
    blockId: string;
    sha256: string;
    anchorId: string;
    coverage: ProgressiveCoverage;
    sourceSnapshot: unknown;
    anchor: unknown;
    bytes: number;
    roundCount: number;
    messageCount: number;
    order?: number;
}

export interface ProgressiveReadyRange extends ProgressiveCoverage {
    blockId: string;
    anchorId: string;
}

export interface ProgressiveStatus {
    source: ProgressiveSource;
    sourceKey: string;
    version: number;
    state: "idle" | "running" | "cancelled" | "complete";
    complete: boolean;
    completeRanges: ProgressiveReadyRange[];
    absoluteRanges: Array<{ startRound: number; endRound: number }>;
    coveredAbsoluteRounds: number;
    relativeReadyRounds: number;
    blocks: ProgressiveBlock[];
}

export interface ProgressiveSelection {
    blockId?: string;
    blockIds?: readonly string[];
    blockOrder?: "source" | "publication";
    kind?: ProgressiveCoverage["kind"];
    startRound?: number;
    endRound?: number;
    direction?: "latest" | "oldest";
    isCancelled?: () => boolean;
}

export interface ProgressiveRow {
    round: ConversationRound;
    messages: CorpusMessage[];
    ref: string;
    blockId: string;
    anchorId: string;
    kind: ProgressiveCoverage["kind"];
}

export interface ProgressiveReadResult {
    status: ProgressiveStatus;
    rows: ProgressiveRow[];
    rounds: ConversationRound[];
    messages: CorpusMessage[];
    requestedRangeComplete: boolean;
}

export interface ProgressiveLatestReadResult extends ProgressiveReadResult {
    selectionScope: "published";
    requestedRounds: number;
    returnedRounds: number;
}

export interface ProgressiveSearchResult {
    semanticVersion: string;
    status: ProgressiveStatus;
    match: CorpusConversationMatch | null;
    hits: Array<{ ref: string; round: number; blockId: string; kind: ProgressiveCoverage["kind"] }>;
    scannedRounds: number;
    scannedMessages: number;
    searchedRanges: ProgressiveReadyRange[];
    requestedRangeComplete: boolean;
    provisional: boolean;
}

export interface ProgressiveLimits {
    maxBlockBytes: number;
    maxRowBytes: number;
    maxManifestBytes: number;
    maxBlocks: number;
    maxRoundsPerBlock: number;
    maxResultBytes: number;
    maxSearchMessages: number;
    maxSearchRounds: number;
}

export interface ProgressiveCacheOptions {
    root: string;
    source: ProgressiveSource;
    limits?: Partial<ProgressiveLimits>;
}

export interface ProgressiveCache {
    readonly root: string;
    readonly sourceKey: string;
    beginWrite(): Promise<ProgressiveWriter>;
    publish(writer: ProgressiveWriter, input: ProgressivePublishInput): Promise<ProgressiveBlock>;
    release(writer: ProgressiveWriter): Promise<ProgressiveStatus>;
    cancel(writer: ProgressiveWriter): Promise<ProgressiveStatus>;
    finish(writer: ProgressiveWriter): Promise<ProgressiveStatus>;
    status(): Promise<ProgressiveStatus>;
    iterate(selection?: ProgressiveSelection): AsyncGenerator<ProgressiveRow>;
    read(selection?: ProgressiveSelection): Promise<ProgressiveReadResult>;
    readLatest(selection: ProgressiveSelection, lastRounds: number): Promise<ProgressiveLatestReadResult>;
    search(request: CorpusSearchRequest, selection?: ProgressiveSelection): Promise<ProgressiveSearchResult>;
    locate(ref: string): Promise<ProgressiveRow>;
}

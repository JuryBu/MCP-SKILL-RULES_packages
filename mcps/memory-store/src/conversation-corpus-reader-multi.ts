import type {
    CorpusConversation, CorpusFastReadRequest, CorpusProjection, CorpusProvider,
    CorpusRangeProvider, CorpusReadControl, CorpusRoundReadRequest, CorpusSearchRequest, CorpusSourceStatus,
} from "./conversation-corpus-types.js";
import { corpusConversationKey, normalizeCorpusSource, type CorpusSource } from "./conversation-corpus-sources.js";
import { corpusProjectionIdentityMatches } from "./conversation-host-binary.js";

export interface MultiCorpusOptions {
    providers?: Partial<Record<CorpusSource, CorpusRangeProvider>>;
}

export function createMultiCorpusProvider(options: MultiCorpusOptions = {}): CorpusRangeProvider {
    const pending = new Map<CorpusSource, Promise<CorpusRangeProvider>>();
    let statuses: CorpusSourceStatus[] = [];
    const providerFor = (source: CorpusSource): Promise<CorpusRangeProvider> => {
        const provided = options.providers?.[source];
        if (provided) return Promise.resolve(provided);
        let provider = pending.get(source);
        if (!provider) {
            provider = source === "codex"
                ? import("./conversation-corpus-reader-codex.js").then(module => module.codexCorpusProvider)
                : import("./conversation-corpus-reader-hosts.js").then(module => module.createHostCorpusProvider(source));
            pending.set(source, provider);
        }
        return provider;
    };
    const validateIdentity = <Projection extends { conversation: CorpusConversation }>(projection: Projection, conversation: CorpusConversation): Projection => {
        if (!corpusProjectionIdentityMatches(projection.conversation, conversation)) {
            throw new Error("Conversation projection source identity changed");
        }
        return projection;
    };
    const bindReadControl = (conversation: CorpusConversation, control: CorpusReadControl): CorpusReadControl => ({
        ...control,
        ...(control.onChunk ? { onChunk: async chunk => {
            validateIdentity(chunk, conversation);
            await control.onChunk!(chunk);
        } } : {}),
    });
    const list = async (request: CorpusSearchRequest, control: CorpusReadControl): Promise<CorpusConversation[]> => {
        const sources = [...new Set((request.dataChains ?? ["codex"]).map(normalizeCorpusSource))];
        if (!sources.length) throw new Error("Select at least one corpus data source");
        statuses = [];
        const lists = await Promise.all(sources.map(async source => {
            try {
                const provider = await providerFor(source);
                const candidates = await provider.list({ ...request, dataChains: [source] }, control);
                if (candidates.some(candidate => candidate.source !== source)) throw new Error("Provider returned a conversation from another source");
                const declared = provider.sourceStatuses?.().find(status => status.source === source);
                const warnings = [...new Set([...(declared?.warnings ?? []), ...candidates.flatMap(candidate => candidate.sourceWarnings ?? [])])];
                const partial = declared?.status === "partial" || declared?.status === "error"
                    || candidates.some(candidate => candidate.sourceWarnings?.some(warning => /partial|limit|truncat|incomplete/iu.test(warning)));
                statuses.push({ source, status: declared?.status === "error" ? "error" : partial ? "partial" : "ok",
                    candidateCount: candidates.length, warnings, ...(declared?.error ? { error: declared.error } : {}) });
                if (declared?.status === "error" && request.sourceFailureMode === "fail") throw new Error(declared.error || "Corpus source listing failed");
                if (!candidates.length && declared?.status === "partial" && request.sourceFailureMode === "fail") {
                    throw Object.assign(new Error(`${source} source listing is incomplete: ${warnings.join("; ") || "source metadata is not fully available"}`), { code: "SOURCE_WORKER_UNAVAILABLE" });
                }
                return candidates;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                statuses = statuses.filter(status => status.source !== source);
                statuses.push({ source, status: "error", candidateCount: 0, warnings: [], error: message });
                if (request.sourceFailureMode === "fail" || control.isCancelled?.()) throw error;
                return [];
            }
        }));
        statuses.sort((left, right) => sources.indexOf(left.source) - sources.indexOf(right.source));
        return [...new Map(lists.flat().map(candidate => [corpusConversationKey(candidate), candidate])).values()];
    };
    const read = async (conversation: CorpusConversation, control: CorpusReadControl): Promise<CorpusProjection> => {
        const provider = await providerFor(normalizeCorpusSource(conversation.source));
        return validateIdentity(await provider.read(conversation, bindReadControl(conversation, control)), conversation);
    };
    const readCached: NonNullable<CorpusProvider["readCached"]> = async (conversation, control) => {
        const provider = await providerFor(normalizeCorpusSource(conversation.source));
        const projection = await provider.readCached?.(conversation, bindReadControl(conversation, control));
        return projection ? validateIdentity(projection, conversation) : null;
    };
    const readRounds = async (conversation: CorpusConversation, request: CorpusRoundReadRequest, control: CorpusReadControl = {}): Promise<CorpusProjection> => {
        const provider = await providerFor(normalizeCorpusSource(conversation.source));
        const result = validateIdentity(await provider.readRounds(conversation, request, bindReadControl(conversation, control)), conversation);
        if (result.revision !== request.revision) throw new Error("Conversation source revision changed; repeat the search or use read_fast");
        return result;
    };
    const readFast = async (conversation: CorpusConversation, request: CorpusFastReadRequest, control: CorpusReadControl = {}): Promise<CorpusProjection> => {
        const provider = await providerFor(normalizeCorpusSource(conversation.source));
        return validateIdentity(await provider.readFast(conversation, request, bindReadControl(conversation, control)), conversation);
    };
    return { semanticVersion: "multi-host-corpus/v2", list, read, readCached, readFast, readRounds,
        sourceStatuses: () => statuses.map(status => ({ ...status, warnings: [...status.warnings] })) };
}

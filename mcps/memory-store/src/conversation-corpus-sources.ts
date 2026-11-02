export const CORPUS_SOURCES = ["codex", "claude-code", "windsurf", "antigravity", "dsh"] as const;

export type CorpusSource = typeof CORPUS_SOURCES[number];

export function normalizeCorpusSource(value: string): CorpusSource {
    const source = value === "cc" ? "claude-code"
        : value === "wsf" ? "windsurf"
            : value === "deepseek-harness" ? "dsh" : value;
    if (!(CORPUS_SOURCES as readonly string[]).includes(source)) {
        throw new Error("Specify a concrete dataChain: codex, claude-code, windsurf, antigravity or dsh");
    }
    return source as CorpusSource;
}

export function resolveCorpusSources(input: {
    dataChain?: string;
    dataChains?: readonly string[];
    chain?: string;
}): CorpusSource[] {
    const single = input.dataChain ?? (input.chain === "auto" ? undefined : input.chain);
    if (input.dataChains !== undefined) {
        if (!Array.isArray(input.dataChains) || !input.dataChains.length) {
            throw new Error("dataChains must contain at least one concrete conversation source");
        }
        const sources = [...new Set(input.dataChains.map(normalizeCorpusSource))];
        if (single !== undefined && (sources.length !== 1 || sources[0] !== normalizeCorpusSource(single))) {
            throw new Error("dataChain and dataChains must select the same source; use dataChains alone for multiple sources");
        }
        return sources;
    }
    if (single === undefined) {
        throw new Error("Pass the current host as a concrete dataChain, or explicitly select multiple dataChains");
    }
    return [normalizeCorpusSource(single)];
}

export function corpusConversationKey(conversation: { source: CorpusSource; id: string }): string {
    return JSON.stringify([conversation.source, conversation.id]);
}

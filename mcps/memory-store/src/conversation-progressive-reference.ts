export interface CompactProgressiveReference {
    blockId: string;
    kind: "absolute" | "relative";
    round: number;
}

export function compactProgressiveRef(reference: string): string | undefined {
    const matched = /^pcache:v1:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64}):(absolute|relative):([1-9][0-9]*)$/u.exec(reference);
    if (!matched || !Number.isSafeInteger(Number(matched[5]))) return undefined;
    return `p2:${Buffer.from(matched[2]!, "hex").toString("base64url")}:${matched[4] === "absolute" ? "a" : "r"}:${matched[5]}`;
}

export function parseCompactProgressiveRef(reference: string): CompactProgressiveReference | undefined {
    const matched = /^p2:([A-Za-z0-9_-]{43}):(a|r):([1-9][0-9]*)$/u.exec(reference);
    if (!matched) return undefined;
    const bytes = Buffer.from(matched[1]!, "base64url");
    const round = Number(matched[3]);
    if (bytes.length !== 32 || bytes.toString("base64url") !== matched[1] || !Number.isSafeInteger(round)) return undefined;
    return { blockId: bytes.toString("hex"), kind: matched[2] === "a" ? "absolute" : "relative", round };
}

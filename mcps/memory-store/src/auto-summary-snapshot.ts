import crypto from "node:crypto";
import { parseMemoryFile } from "./store.js";

export interface AutoSummarySnapshot {
    title: string;
    tags: string[];
    updated: string;
    body: string;
    fingerprint: string;
    expectedSummary?: string;
    sourceFingerprint?: string;
}

export function captureAutoSummarySnapshot(input: {
    title: string;
    tags: string[];
    updated: string;
    body: string;
}): AutoSummarySnapshot {
    const normalized = {
        title: input.title.replace(/\r\n/g, "\n"),
        tags: [...input.tags],
        updated: input.updated.replace(/\r\n/g, "\n"),
        body: input.body.replace(/\r\n/g, "\n").replace(/^\n/u, ""),
    };
    return { ...normalized, fingerprint: crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

export function splitAutoSummaryFile(content: string): { prefix: string; metadata: string; suffix: string } | null {
    const match = content.match(/^(---\r?\n)([\s\S]*?)(^---(?:\r?\n|$)[\s\S]*)$/mu);
    return match ? { prefix: match[1], metadata: match[2], suffix: match[3] } : null;
}

export function stripAutoSummaryFields(metadata: string): string {
    return metadata.replace(/^(?:autoSummary|autoSummaryProvenance):[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gmu, "");
}

export function autoSummarySourceFingerprint(content: string): string | null {
    const parts = splitAutoSummaryFile(content);
    if (!parts) return null;
    return crypto.createHash("sha256").update(parts.prefix + stripAutoSummaryFields(parts.metadata) + parts.suffix).digest("hex");
}

export function captureAutoSummaryFileSnapshot(content: string, fallbackTitle = "", fallbackTags: string[] = []): AutoSummarySnapshot | null {
    const parsed = parseMemoryFile(content);
    const sourceFingerprint = autoSummarySourceFingerprint(content);
    if (!parsed || !sourceFingerprint) return null;
    return {
        ...captureAutoSummarySnapshot({
            title: String(parsed.frontmatter.title || fallbackTitle),
            tags: Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags as string[] : fallbackTags,
            updated: String(parsed.frontmatter.updated || ""),
            body: parsed.body,
        }),
        expectedSummary: typeof parsed.frontmatter.autoSummary === "string" ? parsed.frontmatter.autoSummary : undefined,
        sourceFingerprint,
    };
}

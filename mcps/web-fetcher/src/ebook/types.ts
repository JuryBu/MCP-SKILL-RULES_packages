import type { InspectMetadataValue } from "../inspector/types.js";

export interface EbookMetadata {
    title?: string;
    creators: string[];
    language?: string;
    identifiers: string[];
    publisher?: string;
    date?: string;
}

export interface EbookTocItem {
    title: string;
    href?: string;
    level: number;
}

export interface EbookChapter {
    index: number;
    id: string;
    title: string;
    href: string;
    mediaType?: string;
    markdown: string;
    textLength: number;
}

export interface EbookLimits {
    maxFileSizeBytes: number;
    maxEntries: number;
    maxTotalUncompressedBytes: number;
    maxEntryUncompressedBytes: number;
    maxCompressionRatio: number;
    maxChapters: number;
    maxOutputChars: number;
}

export interface EbookDocument {
    route: "ebook";
    format: "epub";
    sourcePath: string;
    metadata: EbookMetadata;
    toc: EbookTocItem[];
    chapters: EbookChapter[];
    assets: {
        images: number;
        stylesheets: number;
        fonts: number;
        other: number;
    };
    warnings: string[];
    limits: EbookLimits;
    truncated: boolean;
}

export interface EbookStructureElement {
    type: string;
    name: string;
    text: string;
    metadata?: Record<string, InspectMetadataValue>;
}

export class EbookError extends Error {
    readonly code: string;
    readonly stage: string;
    readonly suggestion: string;

    constructor(code: string, stage: string, message: string, suggestion: string) {
        super(message);
        this.name = "EbookError";
        this.code = code;
        this.stage = stage;
        this.suggestion = suggestion;
    }
}


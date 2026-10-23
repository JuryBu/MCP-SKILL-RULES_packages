export const CODEX_JSONL_DEFAULT_RECORD_BYTES = 64 * 1024 * 1024;
export const CODEX_JSONL_COMPACTION_RECORD_BYTES = 128 * 1024 * 1024;

export function codexJsonlRecordByteLimit(prefix: string | Uint8Array): number {
    const text = typeof prefix === "string" ? prefix.slice(0, 4096) : Buffer.from(prefix.buffer, prefix.byteOffset, Math.min(prefix.byteLength, 4096)).toString("utf8");
    const boundary = text.search(/,\s*"payload"\s*:/u);
    if (boundary < 0) return CODEX_JSONL_DEFAULT_RECORD_BYTES;
    try {
        const envelope = JSON.parse(`${text.slice(0, boundary)}}`);
        if (envelope && typeof envelope === "object" && envelope.type === "compacted") return CODEX_JSONL_COMPACTION_RECORD_BYTES;
    } catch {}
    return CODEX_JSONL_DEFAULT_RECORD_BYTES;
}

export function codexJsonlRecordExceedsLimit(record: string | Uint8Array): boolean {
    const length = typeof record === "string" ? Buffer.byteLength(record, "utf8") : record.byteLength;
    if (length <= CODEX_JSONL_DEFAULT_RECORD_BYTES) return false;
    return length > codexJsonlRecordByteLimit(record);
}

export const MIN_PROCESS_TREE_MEMORY_MB = 16;
export const DEFAULT_PROCESS_TREE_MAX_MEMORY_MB = 4096;

export function readConfiguredMemoryMB(
    name: string,
    fallback: number,
    minimum: number = MIN_PROCESS_TREE_MEMORY_MB,
    maximum?: number,
): number {
    const raw = process.env[name];
    const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
        const range = maximum === undefined ? `>= ${minimum}` : `${minimum}～${maximum}`;
        throw new Error(`${name} 必须是 ${range} 的整数 MB，当前值为 ${raw ?? fallback}`);
    }
    return value;
}

export const PROCESS_TREE_MAX_MEMORY_MB = readConfiguredMemoryMB(
    "SANDBOX_PROCESS_TREE_MAX_MEMORY_MB",
    DEFAULT_PROCESS_TREE_MAX_MEMORY_MB,
);

export const CODEX_DEFAULT_MAX_MEMORY_MB = readConfiguredMemoryMB(
    "SANDBOX_CODEX_MAX_MEMORY_MB",
    Math.min(1536, PROCESS_TREE_MAX_MEMORY_MB),
    MIN_PROCESS_TREE_MEMORY_MB,
    PROCESS_TREE_MAX_MEMORY_MB,
);

export const CODEX_DEFAULT_MEMORY_REQUEST_MB = readConfiguredMemoryMB(
    process.env.SANDBOX_CODEX_MEMORY_REQUEST_MB !== undefined
        ? "SANDBOX_CODEX_MEMORY_REQUEST_MB"
        : "SANDBOX_CODEX_RESERVATION_MB",
    Math.min(384, CODEX_DEFAULT_MAX_MEMORY_MB),
    MIN_PROCESS_TREE_MEMORY_MB,
    CODEX_DEFAULT_MAX_MEMORY_MB,
);

export function inferMemoryRequestMB(maxMemoryMB: number): number {
    return Math.min(maxMemoryMB, Math.max(64, Math.ceil(maxMemoryMB / 4)));
}

export function validateProcessTreeMemory(
    maxMemoryMB: number,
    memoryRequestMB?: number,
    label: string = "",
): string | null {
    const prefix = label ? `${label} ` : "";
    if (!Number.isSafeInteger(maxMemoryMB)
        || maxMemoryMB < MIN_PROCESS_TREE_MEMORY_MB
        || maxMemoryMB > PROCESS_TREE_MAX_MEMORY_MB) {
        return `${prefix}maxMemoryMB 必须在 ${MIN_PROCESS_TREE_MEMORY_MB}～${PROCESS_TREE_MAX_MEMORY_MB} 之间`;
    }
    if (memoryRequestMB !== undefined
        && (!Number.isSafeInteger(memoryRequestMB)
            || memoryRequestMB < MIN_PROCESS_TREE_MEMORY_MB
            || memoryRequestMB > maxMemoryMB)) {
        return `${prefix}memoryRequestMB 必须在 ${MIN_PROCESS_TREE_MEMORY_MB} 与 maxMemoryMB 之间`;
    }
    return null;
}

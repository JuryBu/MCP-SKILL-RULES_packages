import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalPbSourceFlavor } from "./local-pb-reader.js";

export interface LocalPbConversationCandidate {
    id: string;
    kinds: Array<"active" | "implicit">;
    updatedAt: string;
    bytes: number;
    files: number;
}

function rootsForHost(host: LocalPbSourceFlavor): Array<{ kind: "active" | "implicit"; root: string }> {
    const home = os.homedir();
    if (host === "windsurf") {
        return [
            { kind: "active", root: process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT || path.join(home, ".codeium", "windsurf", "cascade") },
            { kind: "implicit", root: process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT || path.join(home, ".codeium", "windsurf", "implicit") },
        ];
    }
    return [
        { kind: "active", root: process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT || path.join(home, ".gemini", "antigravity", "conversations") },
        { kind: "implicit", root: process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT || path.join(home, ".gemini", "antigravity", "implicit") },
    ];
}

function safePbId(fileName: string): string | null {
    if (!fileName.toLowerCase().endsWith(".pb")) return null;
    const id = fileName.slice(0, -3);
    return /^[a-zA-Z0-9_-]+$/u.test(id) ? id : null;
}

export function listLocalPbConversationCandidates(
    host: LocalPbSourceFlavor,
    options: { limit?: number; query?: string } = {},
): LocalPbConversationCandidate[] {
    const merged = new Map<string, { kinds: Set<"active" | "implicit">; updatedAtMs: number; bytes: number; files: number }>();
    const query = (options.query || "").trim().toLowerCase();
    for (const { kind, root } of rootsForHost(host)) {
        if (!fs.existsSync(root)) continue;
        const realRoot = fs.realpathSync(root);
        for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const id = safePbId(entry.name);
            if (!id || (query && !id.toLowerCase().includes(query))) continue;
            const filePath = path.join(realRoot, entry.name);
            const realFile = fs.realpathSync(filePath);
            const relative = path.relative(realRoot, realFile);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
            const stat = fs.lstatSync(realFile);
            if (!stat.isFile()) continue;
            const current = merged.get(id) || { kinds: new Set<"active" | "implicit">(), updatedAtMs: 0, bytes: 0, files: 0 };
            current.kinds.add(kind);
            current.updatedAtMs = Math.max(current.updatedAtMs, stat.mtimeMs);
            current.bytes += stat.size;
            current.files += 1;
            merged.set(id, current);
        }
    }
    return [...merged.entries()]
        .map(([id, value]) => ({
            id,
            kinds: [...value.kinds].sort((left, right) => left === right ? 0 : left === "active" ? -1 : 1),
            updatedAt: new Date(value.updatedAtMs).toISOString(),
            bytes: value.bytes,
            files: value.files,
        }))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, Math.min(Math.max(options.limit || 50, 1), 20_000));
}

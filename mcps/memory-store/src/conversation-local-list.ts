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

export interface ConversationDiscoveryDiagnostic {
    code: string;
    message: string;
    sourceKind: string;
    sourcePath?: string;
    conversationId?: string;
}

export interface LocalPbDiscoveryOptions {
    limit?: number;
    query?: string;
    conversationIds?: string[];
    deadlineAt?: number;
    isCancelled?: () => boolean;
    onDiagnostic?: (diagnostic: ConversationDiscoveryDiagnostic) => void;
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
    options: LocalPbDiscoveryOptions = {},
): LocalPbConversationCandidate[] {
    const merged = new Map<string, { kinds: Set<"active" | "implicit">; updatedAtMs: number; bytes: number; files: number }>();
    const query = (options.query || "").trim().toLowerCase();
    const check = () => {
        if (options.isCancelled?.()) throw new Error("PB discovery cancelled");
        if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new Error("PB_DISCOVERY_DEADLINE");
    };
    for (const { kind, root } of rootsForHost(host)) {
        let directory: fs.Dir | undefined;
        try {
            check();
            if (!fs.existsSync(root)) continue;
            const realRoot = fs.realpathSync(root);
            directory = fs.opendirSync(realRoot);
            for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
                check();
                if (!entry.isFile()) continue;
                const id = safePbId(entry.name);
                if (!id || (query && !id.toLowerCase().includes(query)) || (options.conversationIds?.length && !options.conversationIds.includes(id))) continue;
                try {
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
                } catch (error) {
                    if (!options.onDiagnostic) throw error;
                    options.onDiagnostic({ code: "PB_FILE_DISCOVERY_FAILED", message: String(error), sourceKind: `${host}-pb`, sourcePath: root, conversationId: id });
                }
            }
        } catch (error) {
            if (options.isCancelled?.() || !options.onDiagnostic) throw error;
            const deadline = error instanceof Error && error.message === "PB_DISCOVERY_DEADLINE";
            options.onDiagnostic({ code: deadline ? "PB_DISCOVERY_DEADLINE" : "PB_DISCOVERY_FAILED", message: String(error), sourceKind: `${host}-pb`, sourcePath: root });
            if (deadline) break;
        } finally { directory?.closeSync(); }
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 0), 20_000);
    if (merged.size > limit) options.onDiagnostic?.({ code: "PB_CANDIDATE_LIMIT", message: "PB metadata candidates exceeded the requested limit.", sourceKind: `${host}-pb` });
    return [...merged.entries()]
        .map(([id, value]) => ({
            id,
            kinds: [...value.kinds].sort((left, right) => left === right ? 0 : left === "active" ? -1 : 1),
            updatedAt: new Date(value.updatedAtMs).toISOString(),
            bytes: value.bytes,
            files: value.files,
        }))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, limit);
}

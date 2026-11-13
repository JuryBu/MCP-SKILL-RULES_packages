import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalPbReaderOptions } from "./local-pb-reader.js";

export interface AntigravityDataRoot {
    kind: "gui" | "cli";
    root: string;
}

export interface AntigravityLocalOptions {
    roots?: AntigravityDataRoot[];
    maxBytes?: number;
    maxLineBytes?: number;
    maxRecords?: number;
    limit?: number;
    conversationIds?: string[];
    query?: string;
    deadlineMs?: number;
    isCancelled?: () => boolean;
    signal?: AbortSignal;
    pbReaderOptions?: Omit<LocalPbReaderOptions, "sourceFlavor">;
    onDiagnostic?: (diagnostic: AntigravityLocalDiagnostic) => void;
    threadMode?: "main" | "children" | "all";
    parentConversationId?: string;
}

export interface AntigravityLocalDiagnostic {
    code: string;
    message: string;
    sourcePath?: string;
    conversationId?: string;
    occurrences?: number;
}

export interface AntigravityLocalCandidate {
    id: string;
    nativeId: string;
    title: string;
    workspace: string;
    workspaces: string[];
    updatedAt: string;
    sourceKind: string;
    sourcePath: string;
    root: AntigravityDataRoot;
    parentConversationId?: string;
    isChildThread: boolean;
    agentName?: string;
    stepCount?: number;
    bytes: number;
    files: AntigravityLocalFile[];
}

export interface AntigravityLocalFile {
    path: string;
    kind: "pb" | "jsonl" | "db";
    pbKind?: "active" | "implicit";
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
}

export function assertAntigravityReadActive(options: AntigravityLocalOptions): void {
    if (options.signal?.aborted || options.isCancelled?.()) {
        const error = new Error("Antigravity local read cancelled");
        error.name = "AbortError";
        throw error;
    }
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) throw new Error("ANTIGRAVITY_LOCAL_DEADLINE");
}

export function antigravityDataRoots(options: AntigravityLocalOptions = {}): AntigravityDataRoot[] {
    return options.roots || [
        { kind: "gui", root: process.env.MEMORY_STORE_ANTIGRAVITY_ROOT || path.join(os.homedir(), ".gemini", "antigravity") },
        { kind: "cli", root: process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT || path.join(os.homedir(), ".gemini", "antigravity-cli") },
    ];
}

export function antigravityQualifiedId(id: string, kind: AntigravityDataRoot["kind"]): string {
    return kind === "cli" ? `antigravity-cli:${id}` : id;
}

export function splitAntigravityId(id: string): { nativeId: string; kind: "gui" | "cli" } {
    const kind = id.startsWith("antigravity-cli:") ? "cli" : "gui";
    const nativeId = kind === "cli" ? id.slice("antigravity-cli:".length) : id;
    if (!/^[a-zA-Z0-9_-]+$/u.test(nativeId)) throw new Error("Invalid Antigravity conversation filename");
    return { nativeId, kind };
}

export async function antigravitySourceFile(root: string, relative: string, kind: AntigravityLocalFile["kind"], pbKind?: "active" | "implicit"): Promise<AntigravityLocalFile | null> {
    try {
        const realRoot = await fs.realpath(root);
        const filename = await fs.realpath(path.join(realRoot, relative));
        const contained = path.relative(realRoot, filename);
        if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) throw new Error("Antigravity local source escaped its data root");
        const stat = await fs.stat(filename);
        if (!stat.isFile()) return null;
        return { path: filename, kind, pbKind, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function antigravityConversationFiles(root: AntigravityDataRoot, id: string, options: AntigravityLocalOptions = {}): Promise<AntigravityLocalFile[]> {
    splitAntigravityId(id);
    assertAntigravityReadActive(options);
    const files: AntigravityLocalFile[] = [];
    const specifications: Array<[string, AntigravityLocalFile["kind"], ("active" | "implicit")?]> = [
        [`conversations/${id}.pb`, "pb", "active"], [`implicit/${id}.pb`, "pb", "implicit"],
        [`conversations/${id}.db`, "db"],
        [`conversations/${id}.db-wal`, "db"],
        [`brain/${id}/.system_generated/logs/transcript_full.jsonl`, "jsonl"],
        [`brain/${id}/.system_generated/logs/transcript.jsonl`, "jsonl"],
    ];
    for (const [relative, kind, pbKind] of specifications) {
        assertAntigravityReadActive(options);
        const override = root.kind === "gui" && kind === "pb" && !options.roots
            ? process.env[pbKind === "active" ? "MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT" : "MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT"] : undefined;
        const file = await antigravitySourceFile(override || root.root, override ? `${id}.pb` : relative, kind, pbKind);
        if (file) files.push(file);
    }
    return files;
}

function workspaceUris(value: unknown): string[] {
    if (typeof value !== "string" || !value) return [];
    let values: unknown = value;
    try { values = JSON.parse(value); } catch { values = value.split(/\n/u); }
    return (Array.isArray(values) ? values : [values]).filter((item): item is string => typeof item === "string" && Boolean(item)).map(item => {
        try { return item.startsWith("file:") ? fileURLToPath(item) : item; } catch { return item; }
    });
}

async function metadataRows(root: AntigravityDataRoot, options: AntigravityLocalOptions): Promise<Record<string, unknown>[]> {
    const filename = path.join(root.root, "conversation_summaries.db");
    try { await fs.access(filename); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(filename, { readOnly: true, allowExtension: false, timeout: 100 });
    try {
        database.exec("PRAGMA query_only=ON");
        const columns = new Set(database.prepare("PRAGMA table_info(conversation_summaries)").all().map(row => String(row.name)));
        if (!columns.has("conversation_id")) throw new Error("Antigravity summary index has no conversation_id");
        const fields = ["conversation_id", "title", "preview", "workspace_uris", "step_count", "last_modified_time", "parent_conversation_id", "agent_name", "nesting_depth"]
            .filter(field => columns.has(field));
        const selected = options.conversationIds?.map(splitAntigravityId).filter(item => item.kind === root.kind).map(item => item.nativeId);
        if (options.conversationIds?.length && !selected?.length) return [];
        const limit = Math.min(20_000, Math.max(0, options.limit ?? 10_000));
        const predicates: string[] = [];
        const bindings: string[] = [];
        if (selected?.length) {
            predicates.push(`conversation_id IN (${selected.map(() => "?").join(",")})`);
            bindings.push(...selected);
        }
        if (options.threadMode === "children") {
            const parent = splitAntigravityId(options.parentConversationId!);
            if (parent.kind !== root.kind || !columns.has("parent_conversation_id")) return [];
            predicates.push("parent_conversation_id = ? AND conversation_id <> ?");
            bindings.push(parent.nativeId, parent.nativeId);
        } else if (options.threadMode === "main") {
            if (columns.has("parent_conversation_id")) predicates.push("coalesce(parent_conversation_id,'') = ''");
            if (columns.has("nesting_depth")) predicates.push("coalesce(nesting_depth,0) = 0");
        }
        const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
        const ordering = columns.has("last_modified_time") ? " ORDER BY last_modified_time DESC" : "";
        const statement = database.prepare(`SELECT ${fields.join(",")} FROM conversation_summaries${where}${ordering} LIMIT ?`);
        const rows: Record<string, unknown>[] = [];
        for (const row of statement.iterate(...bindings, limit)) {
            assertAntigravityReadActive(options);
            rows.push(row);
            if (rows.length % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        return rows;
    } finally { database.close(); }
}

export async function listAntigravityLocalConversations(options: AntigravityLocalOptions = {}): Promise<AntigravityLocalCandidate[]> {
    const output: AntigravityLocalCandidate[] = [];
    const limit = Math.min(20_000, Math.max(0, options.limit ?? 10_000));
    if (options.threadMode === "children" && !options.parentConversationId) throw new Error("Antigravity children discovery requires an exact parentConversationId");
    const report = (root: AntigravityDataRoot, error: unknown) => {
        assertAntigravityReadActive(options);
        options.onDiagnostic?.({ code: "ANTIGRAVITY_METADATA_UNAVAILABLE", message: String(error), sourcePath: root.root });
    };
    for (const root of antigravityDataRoots(options)) {
        assertAntigravityReadActive(options);
        const metadata = new Map<string, Record<string, unknown>>();
        try { for (const row of await metadataRows(root, options)) metadata.set(String(row.conversation_id), row); }
        catch (error) { report(root, error); }
        const ids = new Set(metadata.keys());
        if (options.conversationIds?.length) {
            for (const target of options.conversationIds.map(splitAntigravityId)) if (target.kind === root.kind) ids.add(target.nativeId);
        } else {
            for (const folder of ["conversations", "implicit", "brain"]) {
                try {
                    const directory = await fs.opendir(path.join(root.root, folder));
                    for await (const entry of directory) {
                        assertAntigravityReadActive(options);
                        const id = folder === "brain" && entry.isDirectory() ? entry.name : entry.isFile() && /\.(pb|db)$/iu.test(entry.name) ? entry.name.slice(0, -3) : "";
                        if (id && /^[a-zA-Z0-9_-]+$/u.test(id)) ids.add(id);
                        if (ids.size > 20_000) {
                            options.onDiagnostic?.({ code: "ANTIGRAVITY_CANDIDATE_LIMIT", message: "Antigravity discovery reached 20000 candidates", sourcePath: root.root });
                            break;
                        }
                    }
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(root, error); }
            }
        }
        for (const nativeId of ids) {
            assertAntigravityReadActive(options);
            if (!/^[a-zA-Z0-9_-]+$/u.test(nativeId)) continue;
            const row = metadata.get(nativeId) || {};
            const id = antigravityQualifiedId(nativeId, root.kind);
            if (options.conversationIds?.length && !options.conversationIds.includes(id)) continue;
            const parentConversationId = row.parent_conversation_id ? antigravityQualifiedId(String(row.parent_conversation_id), root.kind) : undefined;
            const isChildThread = Boolean(parentConversationId || Number(row.nesting_depth));
            if (options.threadMode === "children" && (id === options.parentConversationId || parentConversationId !== options.parentConversationId)) continue;
            if (options.threadMode === "main" && isChildThread) continue;
            const files = await antigravityConversationFiles(root, nativeId, options);
            if (!files.length && !metadata.has(nativeId)) continue;
            const workspaces = workspaceUris(row.workspace_uris);
            const query = options.query?.trim().toLowerCase();
            if (query && ![id, row.title, row.preview, ...workspaces, row.agent_name].join("\n").toLowerCase().includes(query)) continue;
            const hasPb = files.some(file => file.kind === "pb");
            const hasJsonl = files.some(file => file.kind === "jsonl");
            if (!files.length) options.onDiagnostic?.({ code: "ANTIGRAVITY_METADATA_ONLY", conversationId: id,
                sourcePath: path.join(root.root, "conversation_summaries.db"),
                message: `${id}: directory metadata only; no local conversation body. GUI and CLI IDs are independent; no title-based association was made.` });
            const lastModified = Math.max(0, ...files.map(file => file.mtimeMs), Date.parse(String(row.last_modified_time || "")) || 0);
            output.push({ id, nativeId, root, title: String(row.title || row.preview || id), workspace: workspaces[0] || "", workspaces,
                updatedAt: new Date(lastModified).toISOString(), sourceKind: `antigravity-${root.kind}-${hasPb && hasJsonl ? "pb+jsonl" : hasJsonl ? "jsonl" : hasPb ? "pb" : "sqlite-metadata"}`,
                sourcePath: files.find(file => file.kind === "jsonl")?.path || files[0]?.path || path.join(root.root, "conversation_summaries.db"),
                parentConversationId,
                isChildThread, agentName: String(row.agent_name || "") || undefined,
                stepCount: typeof row.step_count === "number" ? row.step_count : undefined, bytes: files.reduce((sum, file) => sum + file.size, 0), files });
        }
    }
    const sorted = output.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    if (sorted.length > limit) options.onDiagnostic?.({ code: "ANTIGRAVITY_CANDIDATE_LIMIT", message: "Antigravity discovery exceeded the requested limit" });
    return sorted.slice(0, limit);
}

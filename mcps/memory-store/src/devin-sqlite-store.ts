import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import type { DevinReadOptions } from "./devin-types.js";

export class DevinReadError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = "DevinReadError";
    }
}

export class ReadBudget {
    readonly maxNodes: number;
    readonly maxBytes: number;
    readonly maxDesktopFiles: number;
    readonly deadline: number;
    nodes = 0;
    bytes = 0;

    constructor(private readonly options: DevinReadOptions = {}) {
        this.maxNodes = this.limit(options.maxNodes, 100_000, "maxNodes");
        this.maxBytes = this.limit(options.maxBytes, 128 * 1024 * 1024, "maxBytes");
        this.maxDesktopFiles = this.limit(options.maxDesktopFiles, 512, "maxDesktopFiles");
        this.deadline = options.deadlineMs ?? Date.now() + 30_000;
        if (!Number.isFinite(this.deadline)) {
            throw new DevinReadError("DEVIN_INVALID_BUDGET", "Devin deadlineMs must be an absolute epoch-millisecond deadline.");
        }
        this.check();
    }

    private limit(value: number | undefined, fallback: number, name: string): number {
        const result = value ?? fallback;
        if (!Number.isSafeInteger(result) || result < 0) {
            throw new DevinReadError("DEVIN_INVALID_BUDGET", `Devin ${name} must be a non-negative safe integer.`);
        }
        return result;
    }

    check(): void {
        if (this.options.signal?.aborted || this.options.isCancelled?.()) {
            throw new DevinReadError("DEVIN_ABORTED", "Devin SQLite reading was cancelled.");
        }
        if (Date.now() >= this.deadline) {
            throw new DevinReadError("DEVIN_DEADLINE", "Devin SQLite reading exceeded its deadline; no complete result was returned.");
        }
    }

    async take(bytes = 0): Promise<void> {
        this.check();
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytes + bytes > this.maxBytes) {
            throw new DevinReadError("DEVIN_BYTE_BUDGET", "Devin SQLite reading exceeded maxBytes; no complete result was returned.");
        }
        if (++this.nodes > this.maxNodes) {
            throw new DevinReadError("DEVIN_NODE_BUDGET", "Devin SQLite reading exceeded maxNodes; no complete result was returned.");
        }
        this.bytes += bytes;
        if (this.nodes % 64 === 0) {
            await yieldImmediate();
            this.check();
        }
    }

    get remainingBytes(): number {
        return Math.max(0, this.maxBytes - this.bytes);
    }
}

export interface DevinPaths {
    cli: string | null;
    desktop: string | null;
}

export function devinPaths(): DevinPaths {
    const cliOverride = process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH;
    const desktopOverride = process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT;
    const applicationData = process.env.APPDATA;
    const cli = cliOverride !== undefined ? path.resolve(cliOverride) : process.platform === "win32"
        ? applicationData ? path.join(applicationData, "Devin", "cli", "sessions.db") : null
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "devin", "cli", "sessions.db");
    const desktop = desktopOverride !== undefined ? path.resolve(desktopOverride) : process.platform === "win32" && applicationData
        ? path.join(applicationData, "Devin", "User", "acp-messages") : null;
    return { cli, desktop };
}

export function isFile(filename: string | null): filename is string {
    if (!filename) return false;
    try { return fs.statSync(filename).isFile(); } catch (error: any) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw new DevinReadError("DEVIN_SOURCE_ACCESS", "A configured Devin SQLite source is not accessible.");
    }
}

const desktopFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/i;

export function desktopFiles(root: string | null, limit: number, check?: () => void): string[] {
    if (!root) return [];
    const filenames: string[] = [];
    let directory: fs.Dir;
    try { directory = fs.opendirSync(root); } catch (error: any) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
        throw new DevinReadError("DEVIN_SOURCE_ACCESS", "The configured Devin Desktop directory is not accessible.");
    }
    try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            check?.();
            if (!entry.isFile() || !desktopFilename.test(entry.name)) continue;
            if (filenames.length >= limit) {
                throw new DevinReadError("DEVIN_DESKTOP_BUDGET", "Devin Desktop discovery exceeded maxDesktopFiles; alias uniqueness was not established.");
            }
            filenames.push(path.join(root, entry.name));
        }
    } finally { directory.closeSync(); }
    return filenames.sort();
}

export function sourceIdentity(filename: string): string {
    const stat = fs.statSync(filename, { bigint: true });
    return [fs.realpathSync(filename), stat.dev, stat.ino, stat.birthtimeNs].join("|");
}

export function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function jsonObject(value: unknown, required = false): Record<string, any> {
    if (value === null || value === undefined || value === "") {
        if (required) throw new DevinReadError("DEVIN_INVALID_JSON", "A required Devin SQLite JSON record is empty.");
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8"));
    } catch {
        throw new DevinReadError("DEVIN_INVALID_JSON", "A Devin SQLite record contains invalid JSON.");
    }
    if (parsed === null && !required) return {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new DevinReadError("DEVIN_INVALID_JSON", "A Devin SQLite record must contain a JSON object.");
    }
    return parsed as Record<string, any>;
}

export function asTimestamp(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim() && !/^\d+(\.\d+)?$/.test(value)) return value;
    const numeric = Number(value);
    if (value === null || value === undefined || value === "" || !Number.isFinite(numeric)) return undefined;
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function nodeId(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function columns(database: DatabaseSync, table: string): Set<string> {
    return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
}

export async function inSnapshot<Result>(filename: string, budget: ReadBudget,
    read: (database: DatabaseSync, identity: string, schema: string) => Promise<Result>): Promise<Result> {
    budget.check();
    let sqlite: typeof import("node:sqlite");
    try {
        sqlite = await import("node:sqlite");
    } catch {
        throw new DevinReadError("DEVIN_SQLITE_UNAVAILABLE", "Devin SQLite reading requires Node.js with node:sqlite and readOnly support (Node 22.16+ or 24+). Legacy WSF/PB reading remains available.");
    }
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (!(major >= 24 || (major === 22 && minor >= 16))) {
        throw new DevinReadError("DEVIN_SQLITE_UNAVAILABLE", "Devin SQLite reading requires readOnly-capable Node.js 22.16+ or 24+.");
    }
    let database: DatabaseSync | undefined;
    let transaction = false;
    try {
        const identity = sourceIdentity(filename);
        database = new sqlite.DatabaseSync(filename, { readOnly: true, allowExtension: false });
        const timeout = Math.max(0, Math.min(250, budget.deadline - Date.now()));
        database.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${Math.floor(timeout)}; BEGIN DEFERRED;`);
        transaction = true;
        const schemaRows = database.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
        const schema = digest([schemaRows, database.prepare("PRAGMA user_version").get(), database.prepare("PRAGMA schema_version").get()]);
        await budget.take(Buffer.byteLength(JSON.stringify(schemaRows)));
        const result = await read(database, identity, schema);
        budget.check();
        if (identity !== sourceIdentity(filename)) {
            throw new DevinReadError("DEVIN_SOURCE_REPLACED", "A Devin database was replaced during reading; the snapshot was discarded.");
        }
        database.exec("COMMIT");
        transaction = false;
        return result;
    } catch (error) {
        if (error instanceof DevinReadError) throw error;
        const code = (error as { code?: string }).code;
        throw new DevinReadError("DEVIN_SQLITE_READ", `Devin read-only SQLite snapshot failed${code ? ` (${code})` : ""}; the source was not modified.`);
    } finally {
        try { if (transaction && database) database.exec("ROLLBACK"); } finally { database?.close(); }
    }
}

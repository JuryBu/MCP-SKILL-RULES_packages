import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DevinReadError, ReadBudget, digest, sourceIdentity } from "./devin-sqlite-store.js";
import type { DevinSqliteValidation } from "./devin-types.js";

export class DevinIdentityCache {
    private readonly observers = new Map<string, { database: DatabaseSync; identity: string; token: string }>();
    private cached: { key: string; version: string; value: unknown } | undefined;
    private closed = false;
    private sources: DevinSqliteValidation[] = [];

    async version(filenames: string[], budget: ReadBudget): Promise<string> {
        if (this.closed) throw new DevinReadError("DEVIN_CACHE_CLOSED", "Create a new DevinIdentityCache after close().");
        const selected = new Set(filenames);
        for (const [filename, observer] of this.observers) {
            if (selected.has(filename)) continue;
            observer.database.close();
            this.observers.delete(filename);
        }
        const [major, minor] = process.versions.node.split(".").map(Number);
        if (!(major >= 24 || (major === 22 && minor >= 16))) throw new DevinReadError("DEVIN_SQLITE_UNAVAILABLE", "Devin identity validation requires readOnly-capable Node.js 22.16+ or 24+.");
        let sqlite: typeof import("node:sqlite");
        try { sqlite = await import("node:sqlite"); }
        catch { throw new DevinReadError("DEVIN_SQLITE_UNAVAILABLE", "Devin identity validation requires node:sqlite."); }
        const states: unknown[] = [];
        const sources: DevinSqliteValidation[] = [];
        for (const filename of filenames) {
            budget.check();
            const identity = sourceIdentity(filename);
            let observer = this.observers.get(filename);
            if (observer && observer.identity !== identity) {
                observer.database.close();
                this.observers.delete(filename);
                observer = undefined;
            }
            if (!observer) {
                const database = new sqlite.DatabaseSync(filename, { readOnly: true, allowExtension: false });
                try { database.exec("PRAGMA query_only=ON; PRAGMA cache_size=-64; PRAGMA busy_timeout=0;"); }
                catch (error) { database.close(); throw error; }
                observer = { database, identity, token: randomUUID() };
                this.observers.set(filename, observer);
            }
            const version = observer.database.prepare("PRAGMA data_version").get();
            states.push([filename, identity, observer.token, version]);
            sources.push({ sourcePath: filename, identity, dataVersion: Number(version?.data_version), epoch: observer.token });
            await budget.take(0);
        }
        this.sources = sources;
        return digest(states);
    }

    evidence(): DevinSqliteValidation[] {
        return structuredClone(this.sources);
    }

    get<Value>(key: string, version: string): Value | undefined {
        return this.cached?.key === key && this.cached.version === version ? structuredClone(this.cached.value) as Value : undefined;
    }

    set(key: string, version: string, value: unknown): void {
        this.cached = { key, version, value: structuredClone(value) };
    }

    close(): void {
        for (const observer of this.observers.values()) observer.database.close();
        this.observers.clear();
        this.cached = undefined;
        this.sources = [];
        this.closed = true;
    }
}

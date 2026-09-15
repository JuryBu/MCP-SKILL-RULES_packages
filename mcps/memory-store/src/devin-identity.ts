import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";
import type { DevinConversationSummary } from "./devin-types.js";

function identityPath(alias: string): string {
    const digest = createHash("sha256").update(alias.trim().toLowerCase()).digest("hex");
    return path.join(DATA_ROOT, "conversation-cache", "devin-identities", `${digest}.json`);
}

export function resolveCachedDevinIdentity(id: string): string {
    const child = /^(.*)--subagent-([a-zA-Z0-9_-]+)$/u.exec(id);
    if (child) return `${resolveCachedDevinIdentity(child[1])}--subagent-${child[2]}`;
    const filename = identityPath(id);
    if (!fs.existsSync(filename)) return id;
    const entry = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (entry.version !== 1 || entry.alias !== id.trim().toLowerCase() || typeof entry.canonicalId !== "string") {
        throw new Error("Devin cached identity is invalid; rebuild the verified identity mapping before reading this alias");
    }
    return entry.canonicalId;
}

export function rememberDevinIdentity(summary: DevinConversationSummary): void {
    const aliases = [...new Set([summary.canonicalId, ...summary.aliases].map(alias => alias.trim().toLowerCase()))];
    for (const alias of aliases) {
        const existing = resolveCachedDevinIdentity(alias);
        if (fs.existsSync(identityPath(alias)) && existing !== summary.canonicalId) {
            throw new Error(`Devin identity changed for ${alias}; existing cache/Record ownership requires explicit migration`);
        }
    }
    for (const alias of aliases) {
        const filename = identityPath(alias);
        if (fs.existsSync(filename)) continue;
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        writeJsonAtomic(filename, { version: 1, alias, canonicalId: summary.canonicalId });
    }
}

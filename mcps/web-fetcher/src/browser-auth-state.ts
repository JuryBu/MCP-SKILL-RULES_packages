import fs from "fs";
import { createHash } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { COOKIES_BACKUP_FILE } from "./constants.js";
import { cookieStorageKey, getLocalStorageForOrigin, saveCookieChangesToBackup, saveLocalStorageChangesToBackup } from "./chrome-helper.js";

const contextStorageBases = new WeakMap<BrowserContext, Map<string, Record<string, string>>>();

function storageBases(context: BrowserContext): Map<string, Record<string, string>> {
    let origins = contextStorageBases.get(context);
    if (!origins) {
        origins = new Map();
        contextStorageBases.set(context, origins);
    }
    return origins;
}

type StoredCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
interface ContextState {
    baseline: Map<string, StoredCookie>;
    backupCookies: StoredCookie[];
    backupText: string | null;
}

function cookieSignature(cookie: StoredCookie | undefined): string {
    if (!cookie) return "";
    return JSON.stringify([cookie.name, cookie.value, cookie.domain, cookie.path, cookie.expires,
        cookie.httpOnly, cookie.secure, cookie.sameSite, (cookie as any).partitionKey ?? null]);
}

export class BrowserAuthState {
    private states = new WeakMap<BrowserContext, ContextState>();
    private operations = new WeakMap<BrowserContext, Promise<void>>();

    private async serialized(context: BrowserContext, operation: () => Promise<void>): Promise<void> {
        const previous = this.operations.get(context) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(operation);
        this.operations.set(context, pending);
        try {
            await pending;
        } finally {
            if (this.operations.get(context) === pending) this.operations.delete(context);
        }
    }

    private state(context: BrowserContext): ContextState {
        let state = this.states.get(context);
        if (!state) {
            state = { baseline: new Map(), backupCookies: [], backupText: null };
            this.states.set(context, state);
        }
        return state;
    }

    async refresh(context: BrowserContext): Promise<void> {
        await this.serialized(context, async () => {
            const state = this.state(context);
            let text: string;
            try {
                text = fs.readFileSync(COOKIES_BACKUP_FILE, "utf8");
            } catch (error: any) {
                if (error?.code !== "ENOENT") throw error;
                text = "[]";
            }
            if (text === state.backupText) return;
            const cookies: StoredCookie[] = JSON.parse(text);
            if (!Array.isArray(cookies)) throw new Error("Cookie backup must be an array");
            const previous = new Map(state.backupCookies.map(cookie => [cookieStorageKey(cookie), cookie]));
            const current = new Map(cookies.map(cookie => [cookieStorageKey(cookie), cookie]));
            const changed = cookies.filter(cookie => cookieSignature(cookie) !== cookieSignature(previous.get(cookieStorageKey(cookie))));
            if (changed.length) await context.addCookies(changed);
            for (const [key, cookie] of previous) {
                if (current.has(key)) continue;
                await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
                state.baseline.delete(key);
            }
            if (changed.length) {
                const actual = new Map((await context.cookies()).map(cookie => [cookieStorageKey(cookie), cookie]));
                for (const cookie of changed) {
                    const key = cookieStorageKey(cookie);
                    const imported = actual.get(key);
                    if (imported) state.baseline.set(key, imported);
                }
            }
            state.backupCookies = cookies;
            state.backupText = text;
        });
    }

    async save(context: BrowserContext): Promise<void> {
        await this.serialized(context, async () => {
            const state = this.state(context);
            const cookies = await context.cookies();
            const changed = cookies.filter(cookie => cookieSignature(cookie) !== cookieSignature(state.baseline.get(cookieStorageKey(cookie))));
            if (changed.length) {
                const result = saveCookieChangesToBackup(changed, state.backupCookies);
                const updated = new Map(state.backupCookies.map(cookie => [cookieStorageKey(cookie), cookie]));
                for (const cookie of result.acceptedCookies) updated.set(cookieStorageKey(cookie), cookie);
                state.backupCookies = [...updated.values()];
            }
            state.baseline = new Map(cookies.map(cookie => [cookieStorageKey(cookie), cookie]));
        });
    }

    async saveLocalStorage(context: BrowserContext): Promise<boolean> {
        let allSaved = true;
        await this.serialized(context, async () => {
            const state = await context.storageState();
            const origins = storageBases(context);
            for (const entry of state.origins) {
                if (!/^https?:\/\//.test(entry.origin)) continue;
                const base = origins.get(entry.origin) ?? {};
                const changed = Object.fromEntries(entry.localStorage
                    .filter(item => item.name !== "__mcp_web_fetcher_restore_revision__" && item.value !== base[item.name])
                    .map(item => [item.name, item.value]));
                if (Object.keys(changed).length === 0) continue;
                const result = saveLocalStorageChangesToBackup(entry.origin, changed, base);
                origins.set(entry.origin, { ...base, ...result.acceptedValues });
                if (result.rejectedKeys.length > 0) allSaved = false;
            }
        });
        return allSaved;
    }
}

export async function installOriginStorage(page: Page, url: string): Promise<void> {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return;
    const entries = getLocalStorageForOrigin(parsed.origin);
    if (!entries || Object.keys(entries).length === 0) return;
    const revision = createHash("sha256").update(JSON.stringify(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)))).digest("hex");
    await page.addInitScript(({ origin, values, revision }) => {
        if (location.origin !== origin) return;
        const marker = "__mcp_web_fetcher_restore_revision__";
        if (localStorage.getItem(marker) === revision) return;
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        localStorage.setItem(marker, revision);
    }, { origin: parsed.origin, values: entries, revision });
    if (typeof page.context === "function") storageBases(page.context()).set(parsed.origin, { ...entries });
}

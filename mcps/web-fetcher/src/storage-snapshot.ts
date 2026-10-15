export interface StorageSnapshotIssue {
    area: "cookies" | "localStorage" | "recovery";
    phase: "capture" | "persist" | "navigate" | "coverage" | "cleanup" | "ownership";
    code: string;
    origin?: string;
}

export interface StorageCaptureEvidence {
    status: "saved" | "empty" | "capture-failed" | "persist-failed" | "pending";
    keyCount: number;
    capturedAt?: string;
    savedAt?: string;
}

export interface OriginStorageEvidence extends StorageCaptureEvidence {
    origin: string;
}

export interface BrowserStorageSnapshotResult {
    reason: string;
    cookieCount: number;
    mergedCookieCount?: number;
    localStorageDomains: Array<{ domain: string; keyCount: number }>;
    errors: string[];
    cookies: any[];
    savedCookieCount: number;
    savedAt?: string;
    capturedAt?: string;
    recoveryBrowserClosed?: boolean;
    recoveryWorkingCopy?: string;
    recoveryComplete?: boolean;
    cookieEvidence?: StorageCaptureEvidence;
    originEvidence?: OriginStorageEvidence[];
    observedOrigins?: string[];
    originTrackingComplete?: boolean;
    issues?: StorageSnapshotIssue[];
}

export interface BrowserStorageSnapshotOptions {
    reason?: string;
    saveCookies?: boolean;
    saveLocalStorage?: boolean;
    cookieTimeoutMs?: number;
    localStorageTimeoutMs?: number;
    totalTimeoutMs?: number;
}

interface StorageWriters {
    saveCookies(cookies: any[], budgetMs: number): number;
    saveLocalStorage(origin: string, values: Record<string, string>, budgetMs: number): number;
}

export function storageOrigin(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
}

export function storageFailureCode(error: unknown): string {
    const typed = error as { code?: string; name?: string; message?: string } | undefined;
    if (["EACCES", "EPERM", "ENOSPC", "EROFS", "backup-conflict", "deletion-unresolved", "baseline-missing", "profile-link-rejected", "profile-size-limit", "profile-entry-rejected", "recovery-disk-space"].includes(typed?.code ?? "")) return typed!.code!;
    const message = String(typed?.message ?? "");
    if (/timeout|deadline/i.test(message) || typed?.name === "TimeoutError") return "timeout";
    if (/closed|disconnected|destroyed/i.test(message)) return "context-unavailable";
    if (typed?.name === "SecurityError") return "storage-access-denied";
    return "unavailable";
}

export function storageIssueText(issue: StorageSnapshotIssue): string {
    return `${issue.area}: ${issue.phase} failed (${issue.code}${issue.origin ? `; ${issue.origin}` : ""})`;
}

export function addStorageIssue(result: BrowserStorageSnapshotResult, issue: StorageSnapshotIssue): void {
    result.issues ??= [];
    const text = storageIssueText(issue);
    if (!result.issues.some(existing => storageIssueText(existing) === text)) result.issues.push(issue);
    if (!result.errors.includes(text)) result.errors.push(text);
}

function completed(evidence: StorageCaptureEvidence | undefined): boolean {
    return evidence?.status === "saved" || evidence?.status === "empty";
}

export function mergeStorageSnapshots(previous: BrowserStorageSnapshotResult, next: BrowserStorageSnapshotResult): BrowserStorageSnapshotResult {
    const origins = new Map((previous.originEvidence ?? []).map(entry => [entry.origin, entry]));
    for (const entry of next.originEvidence ?? []) origins.set(entry.origin, entry);
    const domains = new Map(previous.localStorageDomains.map(entry => [entry.domain, entry]));
    for (const entry of next.localStorageDomains) domains.set(entry.domain, entry);
    const nextOrigins = new Map((next.originEvidence ?? []).map(entry => [entry.origin, entry]));
    const unresolved = (previous.issues ?? []).filter(issue => {
        if (issue.area === "localStorage" && issue.origin) return !completed(nextOrigins.get(issue.origin));
        if (issue.area === "cookies") return !completed(next.cookieEvidence);
        return true;
    });
    const issues = [...new Map([...unresolved, ...(next.issues ?? [])].map(issue => [storageIssueText(issue), issue])).values()];
    const legacyErrors = [
        ...previous.errors.filter(error => !(previous.issues ?? []).some(issue => storageIssueText(issue) === error)),
        ...next.errors.filter(error => !(next.issues ?? []).some(issue => storageIssueText(issue) === error)),
    ];
    const hasSavedCookies = next.savedCookieCount > 0;
    return {
        ...previous,
        ...next,
        cookies: (hasSavedCookies ? next.cookies : previous.cookies).map(cookie => ({ ...cookie })),
        cookieCount: hasSavedCookies ? next.cookieCount : previous.cookieCount,
        savedCookieCount: hasSavedCookies ? next.savedCookieCount : previous.savedCookieCount,
        mergedCookieCount: next.mergedCookieCount ?? previous.mergedCookieCount,
        savedAt: next.savedAt ?? previous.savedAt,
        cookieEvidence: next.cookieEvidence ?? previous.cookieEvidence,
        localStorageDomains: [...domains.values()].map(entry => ({ ...entry })),
        observedOrigins: [...new Set([...(previous.observedOrigins ?? []), ...(next.observedOrigins ?? [])])],
        originEvidence: [...origins.values()].map(entry => ({ ...entry })),
        issues,
        errors: [...new Set([...legacyErrors, ...issues.map(storageIssueText)])],
    };
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("storage capture timeout")), Math.max(1, timeoutMs));
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}

export async function captureBrowserStorage(context: any, writers: StorageWriters, options?: BrowserStorageSnapshotOptions): Promise<BrowserStorageSnapshotResult> {
    const deadline = Date.now() + (options?.totalTimeoutMs ?? 15_000);
    const remaining = () => Math.max(1, deadline - Date.now());
    const result: BrowserStorageSnapshotResult = {
        reason: options?.reason ?? "manual", cookieCount: 0, savedCookieCount: 0,
        cookies: [], localStorageDomains: [], errors: [], issues: [], originEvidence: [], observedOrigins: [],
        capturedAt: new Date().toISOString(),
    };
    if (options?.saveCookies !== false) {
        try {
            const cookies = await bounded(context.cookies(), Math.min(options?.cookieTimeoutMs ?? 5000, remaining()));
            if (!Array.isArray(cookies)) throw new Error("invalid cookie snapshot");
            result.cookies = cookies;
            result.cookieCount = result.cookies.length;
            result.cookieEvidence = { status: result.cookieCount ? "persist-failed" : "empty", keyCount: result.cookieCount, capturedAt: new Date().toISOString() };
            if (result.cookieCount) {
                try {
                    result.mergedCookieCount = writers.saveCookies(result.cookies, remaining());
                    result.savedCookieCount = result.cookieCount;
                    result.savedAt = new Date().toISOString();
                    result.cookieEvidence.status = "saved";
                    result.cookieEvidence.savedAt = result.savedAt;
                } catch (error) {
                    addStorageIssue(result, { area: "cookies", phase: "persist", code: storageFailureCode(error) });
                }
            } else {
                try { writers.saveCookies([], remaining()); }
                catch (error) {
                    result.cookieEvidence.status = "persist-failed";
                    addStorageIssue(result, { area: "cookies", phase: "persist", code: storageFailureCode(error) });
                }
            }
        } catch (error) {
            result.cookieEvidence = { status: "capture-failed", keyCount: 0 };
            addStorageIssue(result, { area: "cookies", phase: "capture", code: storageFailureCode(error) });
        }
    }
    if (options?.saveLocalStorage === false) return result;
    const pagesByOrigin = new Map<string, any[]>();
    try {
        for (const page of typeof context.pages === "function" ? context.pages() : []) {
            try {
                if (page.isClosed?.()) continue;
                const origin = storageOrigin(page.url());
                if (!origin) continue;
                const pages = pagesByOrigin.get(origin) ?? [];
                pages.push(page);
                pagesByOrigin.set(origin, pages);
            } catch { }
        }
    } catch (error) {
        addStorageIssue(result, { area: "localStorage", phase: "capture", code: storageFailureCode(error) });
    }
    result.observedOrigins = [...pagesByOrigin.keys()];
    let pendingOrigins = pagesByOrigin.size;
    for (const [origin, pages] of pagesByOrigin) {
        const evidence: OriginStorageEvidence = { origin, status: "pending", keyCount: 0 };
        result.originEvidence!.push(evidence);
        const originDeadline = Math.min(deadline, Date.now() + Math.max(1, Math.floor(remaining() / pendingOrigins--)));
        let values: Record<string, string> | undefined;
        let failure = "budget-exhausted";
        for (const page of pages) {
            if (Date.now() >= originDeadline) break;
            try {
                const captured = await bounded<{ origin: string; data: Record<string, string> }>(page.evaluate(() => {
                    const data: Record<string, string> = Object.create(null);
                    for (let index = 0; index < localStorage.length; index++) {
                        const key = localStorage.key(index);
                        if (key !== null) data[key] = localStorage.getItem(key) ?? "";
                    }
                    return { origin: location.origin, data };
                }), Math.min(options?.localStorageTimeoutMs ?? 5000, Math.max(1, Math.floor((originDeadline - Date.now()) / pages.length))));
                if (captured.origin !== origin) { failure = "origin-changed"; continue; }
                values = captured.data ?? {};
                evidence.capturedAt = new Date().toISOString();
                break;
            } catch (error) {
                failure = storageFailureCode(error);
            }
        }
        if (values === undefined) {
            evidence.status = "capture-failed";
            addStorageIssue(result, { area: "localStorage", phase: "capture", code: failure, origin });
            continue;
        }
        evidence.keyCount = Object.keys(values).length;
        try {
            if (Date.now() >= originDeadline) throw new Error("storage persistence timeout");
            const savedKeys = writers.saveLocalStorage(origin, values, Math.max(1, Math.min(remaining(), originDeadline - Date.now())));
            evidence.keyCount = savedKeys;
            evidence.status = savedKeys ? "saved" : "empty";
            if (savedKeys) {
                evidence.savedAt = new Date().toISOString();
                result.savedAt = evidence.savedAt;
                result.localStorageDomains.push({ domain: origin, keyCount: savedKeys });
            }
        } catch (error) {
            evidence.status = "persist-failed";
            addStorageIssue(result, { area: "localStorage", phase: "persist", code: storageFailureCode(error), origin });
        }
    }
    return result;
}

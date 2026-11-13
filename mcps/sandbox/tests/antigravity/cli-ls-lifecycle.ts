import assert from "node:assert/strict";
import { openOwnedAntigravityLs } from "../../src/antigravity-cli-ls.js";
import { readAntigravityWindowsProcesses } from "../../src/antigravity-discovery.js";

if (process.env.SANDBOX_AGY_LIFECYCLE_TEST !== "1") throw new Error("Set SANDBOX_AGY_LIFECYCLE_TEST=1 to explicitly run the owned CLI initialization/cleanup check");

const startedAt = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new DOMException("Lifecycle deadline", "TimeoutError")), 22_000);
let owned: Awaited<ReturnType<typeof openOwnedAntigravityLs>> | undefined;
try {
    owned = await openOwnedAntigravityLs(controller.signal, startedAt + 25_000);
    const pid = owned.info.pid;
    assert.equal(owned.info.transport, "cli-ls");
    assert.equal(owned.info.csrfToken, "");
    assert.ok(owned.info.startedAt);
    await owned.close();
    owned = undefined;
    const after = await readAntigravityWindowsProcesses(undefined, pid);
    assert.equal(after.length, 0);
    console.log(JSON.stringify({ state: "passed", transport: "cli-ls", ownedPid: pid, cleanupConfirmed: true,
        getUserStatusRequests: 0, generationRequests: 0, acpPromptRequests: 0, elapsedMs: Date.now() - startedAt }));
} catch (error) {
    const failure = error as Error & { kind?: string; safeToFallback?: boolean; cause?: unknown };
    const cause = failure.cause as { toJSON?: () => unknown } | undefined;
    console.log(JSON.stringify({ state: "failed", message: failure.message, kind: failure.kind, safeToFallback: failure.safeToFallback,
        admission: cause?.toJSON?.(), getUserStatusRequests: 0, generationRequests: 0, acpPromptRequests: 0, elapsedMs: Date.now() - startedAt }));
    process.exitCode = 1;
} finally {
    clearTimeout(timer);
    if (owned) await owned.close();
}

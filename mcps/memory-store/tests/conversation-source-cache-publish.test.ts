import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cache = await import("../src/conversation-source-cache.ts");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-source-publish-"));
const fingerprint = { path: "fixture.jsonl", size: 2, mtime: 1, revision: "v1" };

interface Round {
    roundIndex: number;
    text: string;
}

function preparedBuild(key: { source: string; conversationId: string }, revision: string) {
    const spool = cache.createConversationSourceCacheRoundSpool<Round>({
        key,
        getRoundNumber: round => round.roundIndex,
    });
    spool.append({ roundIndex: 1, text: `${revision} 😀` });
    spool.append({ roundIndex: 2, text: "second" });
    return {
        snapshot: { revision },
        preparedRounds: spool.finish(),
    };
}

const originalRename = fs.promises.rename;
const originalOpen = fs.promises.open;

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);

    const exdevKey = { source: "codex", conversationId: "publish-exdev" };
    let exdevInjected = 0;
    Object.defineProperty(fs.promises, "rename", {
        configurable: true,
        value: async (source: fs.PathLike, target: fs.PathLike) => {
            if (exdevInjected === 0 && path.basename(String(source)).startsWith(".rounds-build-")) {
                exdevInjected += 1;
                const error = new Error("injected EXDEV") as NodeJS.ErrnoException;
                error.code = "EXDEV";
                throw error;
            }
            return await originalRename(source, target);
        },
    });
    try {
        const published = await cache.readOrBuild({
            key: exdevKey,
            fingerprint,
            build: () => preparedBuild(exdevKey, "exdev"),
        });
        assert.equal(published.cacheState, "built");
    } finally {
        Object.defineProperty(fs.promises, "rename", { configurable: true, value: originalRename });
    }
    assert.equal(exdevInjected, 1, "prepared rounds must exercise the cross-device staged copy fallback");
    assert.deepEqual(cache.readCachedRounds<Round>({ key: exdevKey })?.rounds.map(round => round.text), ["exdev 😀", "second"]);
    assert.deepEqual(
        fs.readdirSync(cache.getConversationSourceCacheEntryDirectory(exdevKey)).filter(name => name.startsWith(".publish-")),
        [],
        "cross-device publication must not leave hidden staging files",
    );

    const retryKey = { source: "codex", conversationId: "publish-windows-retry" };
    let transientRenameFailures = 0;
    Object.defineProperty(fs.promises, "rename", {
        configurable: true,
        value: async (source: fs.PathLike, target: fs.PathLike) => {
            if (transientRenameFailures < 4 && /snapshot\..+\.json\.tmp-/u.test(String(source))) {
                transientRenameFailures += 1;
                const error = new Error("injected EPERM") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            }
            return await originalRename(source, target);
        },
    });
    try {
        const published = await cache.readOrBuild<unknown, Round>({
            key: retryKey,
            fingerprint,
            build: () => ({
                snapshot: { revision: "retry" },
                rounds: [{ roundIndex: 1, text: "retry" }],
            }),
            getRoundNumber: round => round.roundIndex,
        });
        assert.equal(published.cacheState, "built");
    } finally {
        Object.defineProperty(fs.promises, "rename", { configurable: true, value: originalRename });
    }
    assert.equal(transientRenameFailures, 4, "Windows artifact rename must retry four transient failures before succeeding");

    const lostLeaseKey = { source: "codex", conversationId: "publish-lost-lease" };
    const lostLeaseDirectory = cache.getConversationSourceCacheEntryDirectory(lostLeaseKey);
    let leaseRemovedBeforeCommit = false;
    Object.defineProperty(fs.promises, "open", {
        configurable: true,
        value: async (filePath: fs.PathLike, flags: string | number, ...rest: unknown[]) => {
            const handle = await (originalOpen as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.promises.open>>>)(filePath, flags, ...rest);
            if (!leaseRemovedBeforeCommit && path.basename(String(filePath)).startsWith("manifest.json.tmp.") && flags === "wx") {
                leaseRemovedBeforeCommit = true;
                fs.rmSync(path.join(lostLeaseDirectory, "build.lock"), { force: true });
            }
            return handle;
        },
    });
    try {
        await assert.rejects(() => cache.readOrBuild<unknown, Round>({
            key: lostLeaseKey,
            fingerprint,
            build: () => ({
                snapshot: { revision: "must-not-publish" },
                rounds: [{ roundIndex: 1, text: "must-not-publish" }],
            }),
            getRoundNumber: round => round.roundIndex,
        }), /lease lost/u);
    } finally {
        Object.defineProperty(fs.promises, "open", { configurable: true, value: originalOpen });
    }
    assert.equal(leaseRemovedBeforeCommit, true);
    assert.equal(fs.existsSync(path.join(lostLeaseDirectory, "manifest.json")), false, "a builder that lost its lease must not switch the public manifest");
    assert.deepEqual(
        fs.existsSync(lostLeaseDirectory)
            ? fs.readdirSync(lostLeaseDirectory).filter(name => name.includes("must-not-publish") || name.startsWith("manifest."))
            : [],
        [],
        "failed lease publication must clean unpublished generation metadata",
    );

    const retryLeaseKey = { source: "codex", conversationId: "publish-lost-lease-during-retry" };
    await cache.readOrBuild<unknown, Round>({
        key: retryLeaseKey,
        fingerprint,
        build: () => ({ snapshot: { revision: "old" }, rounds: [{ roundIndex: 1, text: "old" }] }),
        getRoundNumber: round => round.roundIndex,
    });
    const retryLeaseDirectory = cache.getConversationSourceCacheEntryDirectory(retryLeaseKey);
    let publicRenameAttempts = 0;
    Object.defineProperty(fs.promises, "rename", {
        configurable: true,
        value: async (source: fs.PathLike, target: fs.PathLike) => {
            if (path.basename(String(target)) === "manifest.json" && path.basename(String(source)).startsWith("manifest.json.tmp.")) {
                publicRenameAttempts += 1;
                if (publicRenameAttempts === 1) {
                    fs.rmSync(path.join(retryLeaseDirectory, "build.lock"), { force: true });
                    const error = new Error("injected EPERM after first lease check") as NodeJS.ErrnoException;
                    error.code = "EPERM";
                    throw error;
                }
            }
            return await originalRename(source, target);
        },
    });
    let retryLeaseResult: Awaited<ReturnType<typeof cache.readOrBuild<unknown, Round>>> | undefined;
    try {
        retryLeaseResult = await cache.readOrBuild<unknown, Round>({
            key: retryLeaseKey,
            fingerprint: { ...fingerprint, mtime: 2, revision: "v2" },
            build: () => ({ snapshot: { revision: "new" }, rounds: [{ roundIndex: 1, text: "new" }] }),
            getRoundNumber: round => round.roundIndex,
        });
    } finally {
        Object.defineProperty(fs.promises, "rename", { configurable: true, value: originalRename });
    }
    assert.equal(retryLeaseResult?.cacheState, "stale");
    assert.match(JSON.stringify(retryLeaseResult?.buildFailure || ""), /lease lost/u);
    assert.equal(publicRenameAttempts, 1, "lease must be checked again before a transient rename retry");
    assert.equal(cache.readCachedRounds<Round>({ key: retryLeaseKey })?.rounds[0]?.text, "old", "retry-window lease loss must preserve the previous public generation");

    const postCommitLeaseKey = { source: "codex", conversationId: "publish-lost-lease-after-check" };
    await cache.readOrBuild<unknown, Round>({
        key: postCommitLeaseKey,
        fingerprint,
        build: () => ({ snapshot: { revision: "old" }, rounds: [{ roundIndex: 1, text: "old" }] }),
        getRoundNumber: round => round.roundIndex,
    });
    const postCommitLeaseDirectory = cache.getConversationSourceCacheEntryDirectory(postCommitLeaseKey);
    let removedImmediatelyBeforePublicRename = false;
    Object.defineProperty(fs.promises, "rename", {
        configurable: true,
        value: async (source: fs.PathLike, target: fs.PathLike) => {
            if (!removedImmediatelyBeforePublicRename
                && path.basename(String(target)) === "manifest.json"
                && path.basename(String(source)).startsWith("manifest.json.tmp.")) {
                removedImmediatelyBeforePublicRename = true;
                fs.rmSync(path.join(postCommitLeaseDirectory, "build.lock"), { force: true });
            }
            return await originalRename(source, target);
        },
    });
    let postCommitLeaseResult: Awaited<ReturnType<typeof cache.readOrBuild<unknown, Round>>> | undefined;
    try {
        postCommitLeaseResult = await cache.readOrBuild<unknown, Round>({
            key: postCommitLeaseKey,
            fingerprint: { ...fingerprint, mtime: 3, revision: "v3" },
            build: () => ({ snapshot: { revision: "new" }, rounds: [{ roundIndex: 1, text: "new" }] }),
            getRoundNumber: round => round.roundIndex,
        });
    } finally {
        Object.defineProperty(fs.promises, "rename", { configurable: true, value: originalRename });
    }
    assert.equal(postCommitLeaseResult?.cacheState, "stale");
    assert.match(JSON.stringify(postCommitLeaseResult?.buildFailure || ""), /lease lost/u);
    assert.equal(removedImmediatelyBeforePublicRename, true);
    assert.equal(cache.readCachedRounds<Round>({ key: postCommitLeaseKey })?.rounds[0]?.text, "old", "post-commit lease verification must roll the public manifest back to the previous generation");

    const sourceFenceKey = { source: "codex", conversationId: "publish-source-version-fence" };
    await cache.readOrBuild<unknown, Round>({
        key: sourceFenceKey,
        fingerprint,
        build: () => ({ snapshot: { revision: "old" }, rounds: [{ roundIndex: 1, text: "old" }] }),
        getRoundNumber: round => round.roundIndex,
    });
    let sourceFenceChecks = 0;
    const sourceFenceResult = await cache.readOrBuild<unknown, Round>({
        key: sourceFenceKey,
        fingerprint: { ...fingerprint, mtime: 4, revision: "v4" },
        assertPublishable: () => {
            sourceFenceChecks += 1;
            if (sourceFenceChecks >= 2) throw new Error("source changed after publication");
        },
        build: () => ({ snapshot: { revision: "new" }, rounds: [{ roundIndex: 1, text: "new" }] }),
        getRoundNumber: round => round.roundIndex,
    });
    assert.equal(sourceFenceResult.cacheState, "stale");
    assert.match(JSON.stringify(sourceFenceResult.buildFailure || ""), /source changed/u);
    assert.equal(sourceFenceChecks, 2, "source version must be checked immediately before and after the public manifest rename");
    assert.equal(cache.readCachedRounds<Round>({ key: sourceFenceKey })?.rounds[0]?.text, "old", "source mutation during publication must roll back to the previous public generation");

    console.log("conversation source cache async publication tests passed");
} finally {
    Object.defineProperty(fs.promises, "rename", { configurable: true, value: originalRename });
    Object.defineProperty(fs.promises, "open", { configurable: true, value: originalOpen });
    cache.resetConversationSourceCacheForTests();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}

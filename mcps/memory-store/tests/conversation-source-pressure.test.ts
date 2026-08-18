import assert from "node:assert/strict";
import {
    getConversationSourcePressureSnapshot,
    resetConversationSourcePressureForTests,
    withConversationSourcePressure,
} from "../src/conversation-source-pressure.ts";

const environmentNames = [
    "MEMORY_STORE_CONVERSATION_SOURCE_CONCURRENCY",
    "MEMORY_STORE_CONVERSATION_SOURCE_BACKGROUND_CONCURRENCY",
];
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

try {
    process.env.MEMORY_STORE_CONVERSATION_SOURCE_CONCURRENCY = "2";
    process.env.MEMORY_STORE_CONVERSATION_SOURCE_BACKGROUND_CONCURRENCY = "1";
    resetConversationSourcePressureForTests();

    const firstRelease = deferred();
    const secondRelease = deferred();
    const foregroundRelease = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const foregroundStarted = deferred();

    const first = withConversationSourcePressure("background", async () => {
        firstStarted.resolve();
        await firstRelease.promise;
    });
    await firstStarted.promise;

    const second = withConversationSourcePressure("background", async () => {
        secondStarted.resolve();
        await secondRelease.promise;
    });
    const foreground = withConversationSourcePressure("foreground", async () => {
        foregroundStarted.resolve();
        await foregroundRelease.promise;
    });

    await Promise.race([
        foregroundStarted.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("foreground source operation was blocked by background recovery")), 500)),
    ]);
    assert.equal(getConversationSourcePressureSnapshot().total.active, 2);
    assert.equal(getConversationSourcePressureSnapshot().background.active, 1);

    let secondObserved = false;
    secondStarted.promise.then(() => { secondObserved = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(secondObserved, false, "background source scans must serialize even while their model stages remain concurrent");

    foregroundRelease.resolve();
    firstRelease.resolve();
    await secondStarted.promise;
    secondRelease.resolve();
    await Promise.all([first, second, foreground]);

    const completed = getConversationSourcePressureSnapshot();
    assert.equal(completed.total.peakActive, 2);
    assert.equal(completed.background.peakActive, 1);
    assert.equal(completed.total.active, 0);
    assert.equal(completed.background.active, 0);

    process.env.MEMORY_STORE_CONVERSATION_SOURCE_CONCURRENCY = "1";
    process.env.MEMORY_STORE_CONVERSATION_SOURCE_BACKGROUND_CONCURRENCY = "99";
    assert.equal(getConversationSourcePressureSnapshot().total.limit, 2, "foreground reserve requires at least two total source slots");
    assert.equal(getConversationSourcePressureSnapshot().background.limit, 1, "background source work is a hard single lane even when the environment requests more");

    process.env.MEMORY_STORE_CONVERSATION_SOURCE_CONCURRENCY = "3";
    process.env.MEMORY_STORE_CONVERSATION_SOURCE_BACKGROUND_CONCURRENCY = "2";
    assert.equal(getConversationSourcePressureSnapshot().total.limit, 3);
    assert.equal(getConversationSourcePressureSnapshot().background.limit, 1, "background source pressure must never expand beyond one lane");

    const detachedTrigger = deferred();
    const detachedStarted = deferred();
    const detachedRelease = deferred();
    let detachedPromise: Promise<void> | undefined;
    await withConversationSourcePressure("background", async () => {
        detachedPromise = detachedTrigger.promise.then(() => withConversationSourcePressure("background", async () => {
            detachedStarted.resolve();
            await detachedRelease.promise;
        }));
    });
    const blockerStarted = deferred();
    const blockerRelease = deferred();
    const blocker = withConversationSourcePressure("background", async () => {
        blockerStarted.resolve();
        await blockerRelease.promise;
    });
    await blockerStarted.promise;
    detachedTrigger.resolve();
    let detachedObserved = false;
    detachedStarted.promise.then(() => { detachedObserved = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(detachedObserved, false, "detached async work must reacquire a background permit after its parent permit is released");
    blockerRelease.resolve();
    await detachedStarted.promise;
    detachedRelease.resolve();
    await Promise.all([blocker, detachedPromise]);

    console.log("✅ conversation-source-pressure 通过：后台读源单路、前台保留槽、动态并发钳制、detached 上下文重新取证");
} finally {
    for (const name of environmentNames) {
        const original = originalEnvironment.get(name);
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
    resetConversationSourcePressureForTests();
}

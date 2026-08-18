import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const recordToolSource = fs.readFileSync(path.join(repoRoot, "src", "tools", "record.ts"), "utf-8");
const lifecycleSource = fs.readFileSync(path.join(repoRoot, "src", "lifecycle.ts"), "utf-8");
const conversationSource = fs.readFileSync(path.join(repoRoot, "src", "tools", "conversation.ts"), "utf-8");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

assert.match(recordToolSource, /from "\.\.\/record-update-coordination\.js"/u);
assert.match(recordToolSource, /buildAndPersistRecordReaderIndex/u);
assert.match(lifecycleSource, /await import\("\.\/tools\/record\.js"\)/u);
assert.match(conversationSource, /await import\("\.\/record\.js"\)/u);
assert.match(lifecycleSource, /admitRecordAutoUpdate\(/u);
assert.match(conversationSource, /admitRecordAutoUpdate\(/u);
assert.doesNotMatch(lifecycleSource, /acquireRecordSingleFlightPermit|withRecordPersistenceWrite|buildAndPersistRecordReaderIndex/u);
assert.doesNotMatch(conversationSource, /acquireRecordSingleFlightPermit|withRecordPersistenceWrite|buildAndPersistRecordReaderIndex/u);

process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "1";
delete process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS;

const {
    RecordSingleFlightAbortError,
    __recordUpdateCoordinationTest,
    acquireRecordSingleFlightPermit,
    withRecordPersistenceWrite,
} = await import("../src/record-update-coordination.ts");

const firstGenerationEntered = deferred<void>();
const releaseFirstGeneration = deferred<void>();
const events: string[] = [];
let activeGenerations = 0;
let peakGenerations = 0;

async function runRecordUpdatePath(pathName: "manual" | "automatic", holdGeneration = false): Promise<void> {
    const singleFlightPermit = await acquireRecordSingleFlightPermit("shared-conversation");
    try {
        events.push(`${pathName}:generate:start`);
        activeGenerations += 1;
        peakGenerations = Math.max(peakGenerations, activeGenerations);
        if (holdGeneration) {
            firstGenerationEntered.resolve();
            await releaseFirstGeneration.promise;
        }
        activeGenerations -= 1;
        events.push(`${pathName}:generate:end`);
        await withRecordPersistenceWrite(async () => {
            events.push(`${pathName}:commit`);
        });
    } finally {
        singleFlightPermit.release();
    }
}

const manualUpdate = runRecordUpdatePath("manual", true);
await firstGenerationEntered.promise;
const automaticUpdate = runRecordUpdatePath("automatic");
await sleep(40);
assert.deepEqual(events, ["manual:generate:start"]);
releaseFirstGeneration.resolve();
await Promise.all([manualUpdate, automaticUpdate]);
assert.equal(peakGenerations, 1, "automatic and manual updates must share the conversation single-flight");
assert.deepEqual(events, [
    "manual:generate:start",
    "manual:generate:end",
    "manual:commit",
    "automatic:generate:start",
    "automatic:generate:end",
    "automatic:commit",
]);

await assert.rejects(
    withRecordPersistenceWrite(async () => {
        throw new Error("forced persistence failure");
    }),
    /forced persistence failure/u,
);

let secondWriteRan = false;
await withRecordPersistenceWrite(async () => {
    secondWriteRan = true;
});
assert.equal(secondWriteRan, true);
assert.deepEqual(
    __recordUpdateCoordinationTest.persistenceStats(),
    {
        active: 0,
        pending: 0,
        peakActive: 1,
        limit: 1,
        current: 1,
        max: 1,
        min: 1,
        successes: 3,
        failures: 0,
    },
    "a failed persistence transaction must release the shared permit",
);

assert.equal(__recordUpdateCoordinationTest.singleFlightGateCount(), 0, "released single-flight gates must not stay cached");

const cancelledHolder = await acquireRecordSingleFlightPermit("cancelled-single-flight");
let cancelled = false;
const cancelledWaiter = acquireRecordSingleFlightPermit("cancelled-single-flight", {
    isCancelled: () => cancelled,
});
await sleep(5);
cancelled = true;
cancelledHolder.release();
await assert.rejects(
    cancelledWaiter,
    error => error instanceof RecordSingleFlightAbortError && error.reason === "cancelled",
);
assert.equal(
    __recordUpdateCoordinationTest.singleFlightStats("cancelled-single-flight"),
    null,
    "a cancelled waiter that drains the gate must clear its cached single-flight entry",
);

process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS = "40";
const timeoutHolder = await acquireRecordSingleFlightPermit("timed-out-single-flight");
let legacyTimeoutWaiterSettled = false;
const legacyTimeoutWaiter = acquireRecordSingleFlightPermit("timed-out-single-flight").then(permit => {
    legacyTimeoutWaiterSettled = true;
    return permit;
}, error => {
    legacyTimeoutWaiterSettled = true;
    throw error;
});
try {
    await sleep(80);
    assert.equal(legacyTimeoutWaiterSettled, false, "the retired queue-timeout env must not terminate a single-flight waiter");
    assert.deepEqual(
        __recordUpdateCoordinationTest.singleFlightStats("timed-out-single-flight"),
        { active: 1, pending: 1, peakActive: 1, limit: 1 },
        "the waiter must remain queued until the holder releases",
    );
} finally {
    timeoutHolder.release();
}
const legacyTimeoutPermit = await legacyTimeoutWaiter;
legacyTimeoutPermit.release();
assert.equal(
    __recordUpdateCoordinationTest.singleFlightStats("timed-out-single-flight"),
    null,
    "the final release after an unbounded wait must clear the cached single-flight entry",
);
delete process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS;

process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "4";
const adaptiveInitial = __recordUpdateCoordinationTest.persistenceStats();
assert.deepEqual(
    adaptiveInitial,
    {
        active: 0,
        pending: 0,
        peakActive: 1,
        limit: 2,
        current: 2,
        max: 4,
        min: 1,
        successes: 0,
        failures: 0,
    },
    "the Record persistence gate must start at the AIMD initial capacity",
);

await withRecordPersistenceWrite(async () => {});
const firstWriteEntered = deferred<void>();
const releaseFirstWrite = deferred<void>();
const secondWriteEntered = deferred<void>();
const releaseSecondWrite = deferred<void>();
let followerEntered = false;
const firstWrite = withRecordPersistenceWrite(async () => {
    firstWriteEntered.resolve();
    await releaseFirstWrite.promise;
});
await firstWriteEntered.promise;
const secondWrite = withRecordPersistenceWrite(async () => {
    secondWriteEntered.resolve();
    await releaseSecondWrite.promise;
});
await secondWriteEntered.promise;
const followerWrite = withRecordPersistenceWrite(async () => {
    followerEntered = true;
});
await sleep(20);
assert.equal(__recordUpdateCoordinationTest.persistenceStats().pending, 1, "the follower must wait at the initial capacity");
releaseFirstWrite.resolve();
for (let attempt = 0; !followerEntered && attempt < 20; attempt += 1) await sleep(10);
assert.equal(followerEntered, true, "AIMD growth must notify the FIFO gate and admit queued writes");
assert.equal(__recordUpdateCoordinationTest.persistenceStats().current, 3, "two successful writes must grow capacity from two to three");
releaseSecondWrite.resolve();
await Promise.all([firstWrite, secondWrite, followerWrite]);

process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "3";
await withRecordPersistenceWrite(async () => {});
await withRecordPersistenceWrite(async () => {});
assert.equal(__recordUpdateCoordinationTest.persistenceStats().current, 3);
const congestionError = Object.assign(new Error("file descriptor exhaustion"), { code: "EMFILE" });
await assert.rejects(withRecordPersistenceWrite(async () => { throw congestionError; }), /file descriptor exhaustion/u);
assert.deepEqual(
    __recordUpdateCoordinationTest.persistenceStats(),
    {
        active: 0,
        pending: 0,
        peakActive: 3,
        limit: 1,
        current: 1,
        max: 3,
        min: 1,
        successes: 2,
        failures: 1,
    },
    "filesystem congestion must halve the adaptive capacity",
);

await withRecordPersistenceWrite(async () => {});
await withRecordPersistenceWrite(async () => {});
const causeCongestionError = Object.assign(new Error("reader index sidecar blocked"), {
    cause: Object.assign(new Error("temporary resource busy"), { code: "EBUSY" }),
});
await assert.rejects(
    withRecordPersistenceWrite(async () => { throw causeCongestionError; }),
    /reader index sidecar blocked/u,
);
assert.deepEqual(
    __recordUpdateCoordinationTest.persistenceStats(),
    {
        active: 0,
        pending: 0,
        peakActive: 3,
        limit: 1,
        current: 1,
        max: 3,
        min: 1,
        successes: 4,
        failures: 2,
    },
    "a congestion code in the cause chain must also feed AIMD failure feedback",
);

process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "4";
await withRecordPersistenceWrite(async () => {});
await withRecordPersistenceWrite(async () => {});
const beforeNonCongestionFailure = __recordUpdateCoordinationTest.persistenceStats();
const businessError = new Error("record validation failed");
await assert.rejects(withRecordPersistenceWrite(async () => { throw businessError; }), /record validation failed/u);
assert.deepEqual(
    __recordUpdateCoordinationTest.persistenceStats(),
    {
        ...beforeNonCongestionFailure,
        active: 0,
        pending: 0,
        peakActive: 3,
    },
    "ordinary persistence errors must not reduce adaptive capacity",
);
const missingFileError = Object.assign(new Error("missing Record file"), { code: "ENOENT" });
await assert.rejects(withRecordPersistenceWrite(async () => { throw missingFileError; }), /missing Record file/u);
assert.deepEqual(
    __recordUpdateCoordinationTest.persistenceStats(),
    {
        ...beforeNonCongestionFailure,
        active: 0,
        pending: 0,
        peakActive: 3,
    },
    "ENOENT must not reduce adaptive capacity",
);

process.env.MEMORY_STORE_RECORD_UPDATE_CONCURRENCY = "2";
const queueHolderOne = await __recordUpdateCoordinationTest.acquirePersistenceGate();
const queueHolderTwo = await __recordUpdateCoordinationTest.acquirePersistenceGate();
process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS = "40";
let legacyPersistenceWaiterSettled = false;
let legacyPersistenceWriteRan = false;
const legacyPersistenceWaiter = withRecordPersistenceWrite(async () => {
    legacyPersistenceWriteRan = true;
}).finally(() => {
    legacyPersistenceWaiterSettled = true;
});
try {
    await sleep(80);
    const whileQueued = __recordUpdateCoordinationTest.persistenceStats();
    assert.equal(legacyPersistenceWaiterSettled, false, "the retired queue-timeout env must not terminate a persistence waiter");
    assert.equal(whileQueued.pending, 1);
    assert.equal(whileQueued.failures, 0, "pure queue wait must not feed AIMD failure feedback");
    assert.equal(whileQueued.successes, 0, "pure queue wait must not count as persistence success");
    queueHolderOne.release();
    await legacyPersistenceWaiter;
    assert.equal(legacyPersistenceWriteRan, true);
} finally {
    queueHolderOne.release();
    queueHolderTwo.release();
}
delete process.env.MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS;

console.log("✅ record update coordination tests passed");

import assert from "node:assert/strict";
import { runSharedCodexSourceWork } from "../src/codex-source-work.ts";

const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
let executions = 0;
let firstCancelled = false;
let sharedCancelled = false;
const work = async (isCancelled: () => boolean): Promise<string> => {
    executions += 1;
    for (let iteration = 0; iteration < 12; iteration += 1) {
        await pause(10);
        if (isCancelled()) {
            sharedCancelled = true;
            throw new Error("all source work waiters cancelled");
        }
    }
    return "verified";
};

const first = runSharedCodexSourceWork("shared-fixture", work, () => firstCancelled);
const firstOutcome = first.then(value => ({ value }), error => ({ error }));
const second = runSharedCodexSourceWork("shared-fixture", work);
await pause(15);
firstCancelled = true;
const cancelledOutcome = await firstOutcome;
assert.ok("error" in cancelledOutcome);
assert.equal(cancelledOutcome.error.name, "AbortError");
assert.equal(await second, "verified");
assert.equal(executions, 1);
assert.equal(sharedCancelled, false);
assert.equal(await runSharedCodexSourceWork("shared-fixture", work), "verified");
assert.equal(executions, 2, "completed work must not become a freshness cache");

let allCancelled = false;
const cancelledGroup = [
    runSharedCodexSourceWork("cancelled-fixture", work, () => allCancelled),
    runSharedCodexSourceWork("cancelled-fixture", work, () => allCancelled),
].map(promise => promise.then(value => ({ value }), error => ({ error })));
await pause(15);
allCancelled = true;
const cancelledResults = await Promise.all(cancelledGroup);
assert.ok(cancelledResults.every(result => "error" in result));
await pause(30);
assert.equal(sharedCancelled, true);
assert.equal(await runSharedCodexSourceWork("cancelled-fixture", work), "verified");
await assert.rejects(() => runSharedCodexSourceWork("never-started", work, () => true), { name: "AbortError" });
console.log("PASS codex-source-work: in-flight sharing, independent waiter cancellation, all-cancel cleanup, no completed reuse");

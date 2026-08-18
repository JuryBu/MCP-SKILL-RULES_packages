import assert from "node:assert/strict";
import { AdaptiveConcurrencyGate } from "../src/adaptive-concurrency.ts";
import { FifoConcurrencyGate } from "../src/concurrency-gate.ts";

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        }
        await sleep(5);
    }
}

{
    const gate = new AdaptiveConcurrencyGate(5, 1, 1);
    assert.deepEqual(gate.snapshot(), {
        current: 1,
        max: 5,
        min: 1,
        successes: 0,
        failures: 0,
    });
    assert.equal(gate.onSuccess(), true);
    assert.equal(gate.limit, 2);
    assert.equal(gate.onSuccess(), false);
    assert.equal(gate.onSuccess(), true);
    assert.equal(gate.limit, 3);
    assert.equal(gate.onSuccess(), false);
    gate.onFailure();
    assert.deepEqual(gate.snapshot(), {
        current: 1,
        max: 5,
        min: 1,
        successes: 4,
        failures: 1,
    });
    assert.equal(gate.onSuccess(), true, "failure should reset the success streak before growth resumes");
}

{
    const gate = new AdaptiveConcurrencyGate(8, 3, 8);
    gate.onFailure();
    assert.equal(gate.limit, 4);
    gate.onFailure();
    assert.equal(gate.limit, 3);
    gate.onFailure();
    assert.equal(gate.limit, 3, "failure must not reduce below the configured minimum");
    const capped = new AdaptiveConcurrencyGate(2, 1, 2);
    assert.equal(capped.onSuccess(), false);
    assert.equal(capped.onSuccess(), false);
    assert.equal(capped.limit, 2, "success must not grow beyond the configured maximum");
}

{
    assert.deepEqual(new AdaptiveConcurrencyGate(5, 3, 1).snapshot(), {
        current: 3,
        max: 5,
        min: 3,
        successes: 0,
        failures: 0,
    });
    assert.deepEqual(new AdaptiveConcurrencyGate(2.9, 8.8, 99).snapshot(), {
        current: 2,
        max: 2,
        min: 2,
        successes: 0,
        failures: 0,
    });
    assert.deepEqual(new AdaptiveConcurrencyGate(Number.NaN, 0, Number.POSITIVE_INFINITY).snapshot(), {
        current: 1,
        max: 1,
        min: 1,
        successes: 0,
        failures: 0,
    });
}

{
    let capacity = 1;
    const gate = new FifoConcurrencyGate(() => capacity);
    const first = await gate.acquire();
    const started: string[] = [];
    const secondPromise = gate.acquire().then(permit => {
        started.push("second");
        return permit;
    });
    const thirdPromise = gate.acquire().then(permit => {
        started.push("third");
        return permit;
    });

    await waitFor(() => gate.stats().pending === 2);
    capacity = 3;
    gate.notifyCapacityIncrease();

    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    assert.deepEqual(started, ["second", "third"], "capacity increase must preserve FIFO order");
    assert.equal(gate.stats().active, 3, "capacity notification should admit all newly available waiters");
    first.release();
    second.release();
    third.release();
    assert.equal(gate.stats().active, 0);
}

{
    let capacity = 1;
    const gate = new FifoConcurrencyGate(() => capacity);
    const first = await gate.acquire();
    let cancelled = false;
    const cancelledAcquire = gate.acquire({
        shouldCancel: () => cancelled,
        cancelMessage: "cancelled waiter",
    });
    const follower = gate.acquire();

    await waitFor(() => gate.stats().pending === 2);
    cancelled = true;
    await assert.rejects(cancelledAcquire, /cancelled waiter/u);
    capacity = 2;
    gate.notifyCapacityIncrease();

    const permit = await follower;
    assert.equal(gate.stats().active, 2, "cancelled waiters must not block a later FIFO waiter");
    first.release();
    permit.release();
}

{
    const gate = new FifoConcurrencyGate(() => 1);
    const first = await gate.acquire();
    await assert.rejects(
        gate.acquire({ timeoutMs: 10, timeoutMessage: "timed out waiter" }),
        /timed out waiter/u,
    );
    gate.notifyCapacityIncrease();
    assert.equal(gate.stats().pending, 0, "timed out waiters must remain removed after notification");
    first.release();
}

console.log("✅ adaptive concurrency tests passed");

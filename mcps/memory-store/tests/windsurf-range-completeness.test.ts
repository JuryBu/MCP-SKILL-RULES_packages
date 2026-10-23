import assert from "node:assert/strict";
import { readWindsurfCascadeSteps, type WindsurfLsTransport } from "../src/windsurf-client.ts";

const offsets: number[] = [];
const endless: WindsurfLsTransport = async (_method, payload) => {
    const offset = Number(payload.stepOffset);
    offsets.push(offset);
    return { steps: [{ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { text: `虚构问题${offset}` } }] };
};
const limited = await readWindsurfCascadeSteps(endless, "fictional-cascade", { startOffset: 5, maxPages: 2 });
assert.equal(limited.partial, true, "a page budget must retain incomplete-source status");
assert.deepEqual(offsets, [5, 6]);
assert.equal(limited.steps.length, 2);
assert.equal(limited.pagesRead, 2);
const terminated: WindsurfLsTransport = async (_method, payload) => Number(payload.stepOffset) === 0
    ? { steps: [{ type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { text: "虚构完整问题" } }] }
    : { steps: [] };
const complete = await readWindsurfCascadeSteps(terminated, "fictional-cascade", { maxPages: 2 });
assert.equal(complete.partial, false);
assert.equal(complete.steps.length, 1);
assert.equal(complete.pagesRead, 2);
const empty = await readWindsurfCascadeSteps(async () => ({ steps: [] }), "fictional-empty", { maxPages: 1 });
assert.equal(empty.partial, false);
assert.equal(empty.steps.length, 0);
console.log("PASS WSF step range completeness: budget exhausted, empty terminal page, empty source");

import assert from "node:assert/strict";
import {
    DEFAULT_ANTIGRAVITY_LS_MODEL,
    DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS,
} from "../src/ls-model-defaults.ts";
import { getLsModelCandidates } from "../src/ls-client.ts";

const expectedOrder = [
    "MODEL_PLACEHOLDER_M132",
    "MODEL_PLACEHOLDER_M20",
    "MODEL_PLACEHOLDER_M18",
    "MODEL_PLACEHOLDER_M16",
    "MODEL_PLACEHOLDER_M36",
];

assert.equal(DEFAULT_ANTIGRAVITY_LS_MODEL, "MODEL_PLACEHOLDER_M132");
assert.deepEqual(DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS, expectedOrder);

assert.deepEqual(getLsModelCandidates(DEFAULT_ANTIGRAVITY_LS_MODEL), expectedOrder);
assert.deepEqual(getLsModelCandidates("MODEL_PLACEHOLDER_M47"), [
    "MODEL_PLACEHOLDER_M47",
    ...expectedOrder,
]);

assert.equal(DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS.includes("MODEL_PLACEHOLDER_M37"), false);
assert.equal(DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS.includes("MODEL_GOOGLE_GEMINI_2_5_FLASH"), false);

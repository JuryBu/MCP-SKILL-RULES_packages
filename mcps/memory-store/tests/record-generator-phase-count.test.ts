import assert from "node:assert/strict";
import { countPhasesInRecord } from "../src/record-generator.ts";

assert.equal(countPhasesInRecord("## Phase 1：A\n\n## Phase 2 - B"), 2);
assert.equal(countPhasesInRecord("## Phase: A\n\n## Phase：B"), 2);
assert.equal(countPhasesInRecord("## Not Phase\n\n### Phase: inner"), 0);

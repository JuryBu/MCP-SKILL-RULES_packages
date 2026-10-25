import assert from "node:assert/strict";
import fs from "node:fs";
import { GUIDE_TEXT } from "../src/guide-text.ts";

const section = GUIDE_TEXT.split("### stage_guard")[1]?.split("\n### ")[0] || "";
assert.ok(section, "the actual guide resource includes the Guard section");
for (const term of ["完整绝对路径", "stageId", "scopeSelectors", "maxChars", "budget", "executionEvidenceRole", "reference/context/optional", "必需原件", "includedStart/includedEnd"]) {
    assert.ok(section.includes(term), `Guard guide explains ${term}`);
}
assert.ok(!section.includes("执行记录是 ground truth"), "reference execution is not forced to prove required originals");
assert.ok(!section.includes("尾部、小本本、标题邻近块"), "the current guide does not promise unrelated document-tail extraction");
const document = fs.readFileSync(new URL("../docs/stage-guard.md", import.meta.url), "utf8");
for (const term of ["sourceBodyChars", "sourceMetadataChars", "requiredChars", "grantedChars", "shortfallChars", "completeSourceKnown", "2015", "1800", "215", "固定读取边界"]) {
    assert.ok(document.includes(term), `public Guard documentation explains ${term}`);
}
const example = JSON.parse(document.match(/```json\n([\s\S]*?)\n```/u)![1]);
assert.equal(example.action, "start");
assert.ok(example.stageId);
assert.ok(example.taskFiles[0].startsWith("C:/project/"));
assert.ok(example.planFiles[0].startsWith("C:/project/"));
assert.doesNotMatch(document, /C:[\\/]Users[\\/][^\\/\s]+[\\/]|\b\d{9,12}\b/u);
console.log("stage guard guide: PASS binding/reference/budget/ranges/example/private-data separation");

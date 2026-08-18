import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-reader-tools-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { deleteRecord, writeRecord } = await import("../src/record-store.ts");
const { resolveWorkspaceHashForRecord } = await import("../src/record-store.ts");
const { buildStructuredRecordSearchBlocks, buildRecordGuideRecommendations, handleGuide } = await import("../src/tools/record.ts");
const { search } = await import("../src/search-engine.ts");
const { waitForBackgroundTask } = await import("../src/background-tasks.ts");

const workspace = path.join(dataRoot, "demo-workspace");
const hash = resolveWorkspaceHashForRecord(workspace);
const conversationId = "reader-tools-demo";
const record = [
    "# Record Reader 工具层测试",
    "",
    "- 总轮次：6",
    "- 总 steps：99",
    "",
    "## Phase 1：规划（轮次 1-3）",
    "",
    "### 用户要求",
    "- 主人要求只读产出文件和状态。",
    "",
    "### 产出文件",
    "- `src/record-reader.ts`",
    "- `tests/record-reader.test.ts`",
    "",
    "## Phase 2：实现（轮次 4-6）",
    "",
    "### 当前状态",
    "- 结构化 search 已经可以返回 block 来源。",
    "",
    "### 验证",
    "- `npm run build` 通过。",
].join("\n");

await writeRecord(hash, conversationId, record, {
    title: "Reader tools demo",
    totalRounds: 6,
    totalSteps: 99,
    lastUpdatedRound: 6,
    phases: 2,
    tags: ["reader", "tools"],
});

const outputBlocks = await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
    conversationId,
    sectionTypes: ["outputs"],
    searchScope: "section",
});
assert.equal(outputBlocks.length, 1);
assert.equal(outputBlocks[0].metadata?.recordId, conversationId);
assert.equal(outputBlocks[0].metadata?.sectionType, "outputs");
assert.deepEqual(outputBlocks[0].metadata?.readHint?.sectionTypes, ["outputs"]);

const phaseBlocks = await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
    conversationId,
    phaseIds: [2],
    searchScope: "phase",
});
assert.equal(phaseBlocks.length, 1);
assert.equal(phaseBlocks[0].metadata?.phaseId, "phase-2");
assert.match(phaseBlocks[0].content, /结构化 search/u);

const smartResults = await search(outputBlocks, "产出文件", { mode: "smart", limit: 1, modelChain: "codex" });
assert.ok(smartResults.length >= 1, "smart search should return structured block results or safe fuzzy fallback");
assert.equal(smartResults[0].metadata?.recordId, conversationId);
assert.equal(smartResults[0].metadata?.sectionType, "outputs");

await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
    conversationId,
    searchScope: "section",
    indexMode: "rebuild",
});
await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
    conversationId,
    searchScope: "section",
    indexMode: "reuse",
});
await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
    conversationId,
    searchScope: "section",
    indexMode: "off",
});

const guided = await buildRecordGuideRecommendations(hash, "workspace", false, {
    conversationId,
    goal: "产出文件",
    maxRecommendations: 3,
});
assert.ok(guided.length >= 1);
assert.equal(guided[0].type, "read");
assert.ok(guided[0].readHint, "guide should return readHint instead of a new summary");
assert.ok(guided[0].provenance, "guide should include provenance");
assert.equal(Object.prototype.hasOwnProperty.call(guided[0], "summary"), false);

const guideBackground = await handleGuide(hash, conversationId, undefined, "workspace", false, "当前状态", 2, "codex", Date.now(), {
    background: true,
    format: "json",
});
const guideBackgroundText = guideBackground.content.map(item => item.text).join("\n");
assert.match(guideBackgroundText, /taskId:/u);
const taskId = guideBackgroundText.match(/taskId:\s*([^\s]+)/u)?.[1];
assert.ok(taskId, "background guide should return taskId");
const backgroundTask = await waitForBackgroundTask(taskId, 5);
assert.equal(backgroundTask.status, "done");

const sidecarPath = path.join(dataRoot, "workspaces", hash, "records", `${conversationId}.record_index.json`);
assert.equal(fs.existsSync(sidecarPath), true, "structured search should lazily write reader index sidecar");
const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
assert.equal(sidecar.recordId, conversationId);

assert.equal(await deleteRecord(hash, conversationId), true);
assert.equal(fs.existsSync(sidecarPath), false, "deleteRecord should remove reader index sidecar");

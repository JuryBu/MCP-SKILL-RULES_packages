import assert from "node:assert/strict";
import fs from "node:fs";
import { GUIDE_TEXT } from "../src/guide-text.ts";

const section = GUIDE_TEXT.split("## 五端搜索与构建好即用")[1]?.split("\n## ")[0] || "";
assert.ok(section);
for (const value of ["codex", "claude-code", "windsurf", "antigravity", "dsh", "dataChains", "conversationIds", "search_all_status", "search_all_cancel", "search_all_resume", "read_hit", "read_fast", "prepare_status", "prepare_cancel", "prepare_resume", "read_ready", "search_ready", "locate_ready", "extract_ready", "requestedRangeComplete", "fullSourceComplete", "recall", "Record", "partial"]) {
    assert.ok(section.includes(value), `five-host runtime guide explains ${value}`);
}
assert.match(section, /新入口的conversationId是当前调用者/u);
assert.match(section, /必须显式选择具体 dataChain/u);
assert.match(section, /不把准备任务交给search_all_status/u);
assert.match(section, /cachePreparation.taskId/u);
assert.match(section, /afterProgressRevision/u);
assert.match(section, /原taskId与rangeRef/u);
assert.match(section, /省略rangeRef/u);
assert.match(section, /不使用forceRefresh=true/u);
assert.doesNotMatch(section, /forceRefresh或source=cache\/ls也沿兼容分支/u);
assert.doesNotMatch(GUIDE_TEXT, /系统自动用 Gemini 3 Flash|需要 LS 可用（IDE 运行中），LS 不可用时静默跳过|check\(Flash比对验证\)/u);

const document = fs.readFileSync(new URL("../docs/local-corpus-search.md", import.meta.url), "utf8");
const examples = [...document.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(match => JSON.parse(match[1]));
const hit = examples.find(example => example.action === "read_hit");
assert.equal(hit?.conversationId, "current-thread-id");
assert.deepEqual(hit?.conversationIds, ["matched-thread-id"]);
const fast = examples.find(example => example.action === "read_fast");
assert.equal(fast?.conversationId, "current-thread-id");
assert.deepEqual(fast?.conversationIds, ["target-thread-id"]);
assert.equal(fast?.dataChain, "codex");
assert.match(document, /prepare_status\/prepare_cancel\/prepare_resume/u);
assert.match(document, /兼容直接读取响应的`fullSourceProjectionComplete`/u);
assert.match(document, /cachePreparation\.taskId/u);
assert.doesNotMatch(document, /C:[\\/]Users[\\/][^\\/\s]+[\\/]|\b\d{9,12}\b/u);
console.log("five-host guide: PASS source selection, caller/target, task lifecycle, coverage and model wording");

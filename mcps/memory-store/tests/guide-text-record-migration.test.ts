import assert from "node:assert/strict";
import { GUIDE_TEXT } from "../src/guide-text.ts";

assert.match(GUIDE_TEXT, /migrate_unknown_chain/u, "guide must expose the unknown-chain migration action");
assert.match(GUIDE_TEXT, /默认只读扫描 Codex、Claude Code、Windsurf、Antigravity/u, "guide must name every authoritative host reader");
assert.match(GUIDE_TEXT, /仅一个宿主完整匹配且其余宿主可证明不存在/u, "guide must require a unique complete migration match");
assert.match(GUIDE_TEXT, /apply=true 才按 index revision\/hash CAS 写入 chain/u, "guide must document explicit CAS apply");
assert.match(GUIDE_TEXT, /Unresolved\/Conflict，不改索引，也不作为 batch_update 前置步骤/u, "guide must document safe conflict handling and batch isolation");

console.log("guide text record migration tests passed");

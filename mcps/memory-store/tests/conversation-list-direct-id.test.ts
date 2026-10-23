import assert from "node:assert/strict";
import { codexDirectListQueryId, loadCodexListQueryThreads } from "../src/tools/conversation.js";
import type { CodexThreadInfo } from "../src/codex-client.js";

const id = "12345678-1234-1234-1234-123456789abc";
const thread: CodexThreadInfo = { id, title: "Example", cwd: "/workspace", source: "vscode", rolloutPath: "/history/example.jsonl" };
assert.equal(codexDirectListQueryId(`codex://threads/${id.toUpperCase()}`), id);
assert.equal(codexDirectListQueryId(` ${id} `), id);
assert.equal(codexDirectListQueryId(`a title containing ${id}`), undefined);

let directCalls = 0;
let metadataCalls = 0;
const dependencies = {
    direct: async (input: string) => { directCalls++; assert.equal(input, id); return thread; },
    metadata: async () => { metadataCalls++; return [thread]; },
};
assert.deepEqual(await loadCodexListQueryThreads(id, 20000, dependencies), [thread]);
assert.equal(directCalls, 1);
assert.equal(metadataCalls, 0);
assert.deepEqual(await loadCodexListQueryThreads("Example", 20000, dependencies), [thread]);
assert.equal(directCalls, 1);
assert.equal(metadataCalls, 1);
assert.deepEqual(await loadCodexListQueryThreads(id, 20000, { ...dependencies, direct: async () => null }), []);
assert.equal(metadataCalls, 1);
console.log("PASS direct Codex ID lookup precedes metadata enumeration, preserves titles and accepts thread URLs");

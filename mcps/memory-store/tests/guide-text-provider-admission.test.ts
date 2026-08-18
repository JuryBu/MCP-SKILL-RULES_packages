import assert from "node:assert/strict";
import { GUIDE_TEXT } from "../src/guide-text.ts";

assert.match(GUIDE_TEXT, /provider 的统一 admission 默认 enforced/u);
assert.match(GUIDE_TEXT, /foreground 与 Record 请求共享一个物理池/u);
assert.match(GUIDE_TEXT, /先取得 permit，才会发 HTTP 请求或启动 CLI/u);
assert.match(GUIDE_TEXT, /总 deadline 和取消信号控制/u);
assert.match(GUIDE_TEXT, /exclusive-install 独占初始化/u);
assert.match(GUIDE_TEXT, /dispatchBlocked/u);
assert.match(GUIDE_TEXT, /MEMORY_STORE_GROK_QUEUE_\*/u);
assert.match(GUIDE_TEXT, /缺少 admission 的 legacy Record 保留原 taskId\/resumePayload 并转 error/u);
assert.doesNotMatch(GUIDE_TEXT, /record-batch 先受固定的 MEMORY_STORE_GROK_BATCH_CONCURRENCY/u);

console.log("guide text provider admission tests passed");

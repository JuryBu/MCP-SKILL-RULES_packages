import assert from "node:assert/strict";
import { assertDeepLocateTaskOwner } from "../src/tools/conversation.js";
import { buildDeepLocateResumePayload, parseDeepLocateResumePayload } from "../src/conversation-context-locate-task.js";
import type { BackgroundTask } from "../src/background-tasks.js";

const payload = buildDeepLocateResumePayload({ ownerConversationId: "caller-a", query: "example", dataChains: ["codex"], mode: "exact" });
const restored = parseDeepLocateResumePayload(JSON.parse(JSON.stringify(payload)));
assert.equal(restored.ownerConversationId, "caller-a");
assert.equal(restored.conversationIds, undefined);
const task: BackgroundTask = { id: "example-task", kind: "conversation-deep-locate", status: "done", startedAt: "", updatedAt: "", resumePayload: restored as never };
assert.doesNotThrow(() => assertDeepLocateTaskOwner(task, "caller-a"));
assert.throws(() => assertDeepLocateTaskOwner(task, "caller-b"), /另一调用者/u);
assert.throws(() => assertDeepLocateTaskOwner({ ...task, kind: "another-task" }, "caller-a"), /不存在/u);
const { ownerConversationId: _owner, ...legacy } = payload;
assert.equal(parseDeepLocateResumePayload(legacy).ownerConversationId, undefined);
assert.throws(() => assertDeepLocateTaskOwner({ ...task, resumePayload: legacy as never }, "caller-a"), /历史定位任务缺少/u);
assert.throws(() => parseDeepLocateResumePayload({ ...payload, ownerConversationId: "" }), /ownerConversationId/u);
console.log("PASS deep locate caller ownership survives persistence, remains separate from unknown targets, and rejects foreign or legacy unowned access");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProgressiveTaskPayload } from "../src/conversation-progressive-task-types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan61-host-progressive-cold-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.js");
const { executeHostProgressivePreparation } = await import("../src/conversation-progressive-worker-hosts.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filename = path.join(root, "controlled.jsonl");
const conversationId = "controlled-progressive-cold";
const totalRounds = 1024;
let firstHash = "";
let firstRef = "";
let firstDirectory = "";
let firstSource: Parameters<typeof openProgressiveCache>[0]["source"] | undefined;
try {
    const lines: string[] = [];
    for (let round = 1; round <= totalRounds; round++) {
        lines.push(JSON.stringify({ type: "user", uuid: "user-" + round, message: { role: "user", content: "question-" + round } }));
        lines.push(JSON.stringify({ type: "assistant", uuid: "assistant-" + round, message: { role: "assistant", content: [{ type: "text", text: "answer-" + round + "-" + "content-".repeat(1024) }] } }));
    }
    await fs.writeFile(filename, lines.join("\n") + "\n");
    lines.length = 0;
    const provider = createHostCorpusProvider("claude-code", { cacheRoot: path.join(root, "host-cache"), claudeThreads: () => [{ id: conversationId, jsonlPath: filename, source: "claude-code", title: "controlled progressive cold fixture", cwd: root }] });
    const job: ProgressiveTaskPayload = { version: 1, taskId: "progressive-22222222-2222-4222-8222-222222222222", directory: path.join(root, "task"),
        request: { ownerId: "controlled-caller", conversationId, dataChain: "claude-code", initialRounds: 2, buildFull: true, direction: "latest", messageRoles: ["user", "assistant"], depth: "normal" } };
    let usableBeforeFull = false;
    await executeHostProgressivePreparation(job, { provider, isCancelled: () => false, onActive: () => {}, onProgress: async message => {
        if ((message as { stage?: string }).stage !== "full-cache" || usableBeforeFull) return;
        const ready = JSON.parse(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"));
        const cache = await openProgressiveCache({ root: ready.current.directory, source: ready.current.source });
        const status = await cache.status();
        assert.equal(status.complete, false);
        assert.equal(status.relativeReadyRounds, 2);
        const rows = (await cache.read({ direction: "oldest" })).rows;
        assert.match(rows[0]!.messages.find(item => item.role === "user")!.text, /question-1023/u);
        assert.match(rows[1]!.messages.find(item => item.role === "user")!.text, /question-1024/u);
        firstHash = digest(rows[0]!.messages);
        firstRef = rows[0]!.ref;
        firstDirectory = cache.root;
        firstSource = ready.current.source;
        usableBeforeFull = true;
    } });
    assert.equal(usableBeforeFull, true);
    const final = JSON.parse(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"));
    const full = await openProgressiveCache({ root: final.current.directory, source: final.current.source });
    const fullStatus = await full.status();
    assert.equal(fullStatus.complete, true);
    assert.equal(fullStatus.coveredAbsoluteRounds, totalRounds);
    assert.equal(fullStatus.source.totalRounds, totalRounds);
    assert.ok(final.previous.some((item: { directory: string }) => item.directory === firstDirectory));
    const old = await openProgressiveCache({ root: firstDirectory, source: firstSource! });
    assert.equal(digest((await old.locate(firstRef)).messages), firstHash);
    assert.equal((await old.locate(firstRef)).kind, "relative");
    console.log(JSON.stringify({ sourceBytes: (await fs.stat(filename)).size, usableBeforeFull, fullRounds: fullStatus.coveredAbsoluteRounds, oldRefStableAfterReopen: true, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
} finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConversationData } from "../src/conversation-bridge.js";
import { createProductionSourceReader } from "../src/record-production-source-readers.js";
import {
    resetConversationSourceCacheForTests,
    setConversationSourceCacheDataRootForTests,
} from "../src/conversation-source-cache.js";

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function messageEvent(seq: number, sourceKind: string, text: string): Record<string, unknown> {
    return {
        type: "user/message",
        seq,
        time: `2026-08-14T00:00:0${seq}.000Z`,
        data: {
            message: {
                role: "user",
                source: { kind: sourceKind },
                content: [{ type: "text", text }],
            },
        },
    };
}

function assistantEvent(seq: number, text: string): Record<string, unknown> {
    return {
        type: "assistant/message",
        seq,
        time: `2026-08-14T00:00:0${seq}.000Z`,
        data: {
            turn: 1,
            step: 1,
            message: {
                role: "assistant",
                source: { kind: "model" },
                content: [{ type: "text", text }],
            },
        },
    };
}

async function run(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-conversation-bridge-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "dsh-conversation-cache-"));
    const previousRoot = process.env.MEMORY_STORE_DSH_SESSIONS_ROOT;
    try {
        process.env.MEMORY_STORE_DSH_SESSIONS_ROOT = root;
        setConversationSourceCacheDataRootForTests(cacheRoot);
        const sessionDirectory = path.join(root, "--workspace--", "session-directory");
        await mkdir(sessionDirectory, { recursive: true });
        const sourcePath = path.join(sessionDirectory, "session.jsonl");
        const sessionId = "dsh-session-1";
        await writeFile(sourcePath, [
            line({ type: "session", version: 0, id: sessionId, cwd: "C:\\workspace", createdAt: "2026-08-14T00:00:00.000Z" }),
            line(messageEvent(1, "user", "真人问题")),
            line(messageEvent(2, "plugin", "自动注入不能进入真人轮")),
            line(assistantEvent(3, "模型回答")),
        ].join(""), "utf8");

        const first = await loadConversationData("dsh", sessionId, { source: "local", refresh: true });
        assert.ok(first);
        assert.equal(first.chainUsed, "dsh");
        assert.equal(first.rounds.length, 1);
        assert.deepEqual(first.rounds[0].userMessages?.map(item => item.text), ["真人问题"]);
        assert.equal(first.rounds[0].semanticEvents?.some(item => item.text?.includes("自动注入不能进入真人轮")), true);
        assert.equal(first.dshData?.provenance.sourcePath, sourcePath);
        assert.equal(first.sourceRevision?.sequence, 3);
        assert.ok(first.cacheGeneration);

        const recordReader = createProductionSourceReader();
        const recordSource = await recordReader.scan({
            host: "dsh",
            conversationId: sessionId,
            workspaceId: "workspace-test",
            workspacePath: "C:\\workspace",
            cacheGeneration: {
                key: first.cacheKey!,
                generation: first.cacheGeneration,
                fingerprint: first.cacheFingerprint || null,
            },
        });
        assert.equal(recordSource.fullSourceRead.status, "complete");
        if (recordSource.fullSourceRead.status === "complete") {
            const document = JSON.parse(Buffer.from(recordSource.fullSourceRead.payload.bytes).toString("utf8")) as {
                source: { host: string };
                messages: Array<{ role: string; content: string }>;
            };
            assert.equal(document.source.host, "dsh");
            assert.deepEqual(document.messages.map(item => [item.role, item.content]), [
                ["user", "真人问题"],
                ["assistant", "模型回答"],
            ]);
        }
        await assert.rejects(
            () => recordReader.scan({ host: "dsh", conversationId: sessionId, workspaceId: "workspace-test", workspacePath: "C:\\workspace" }),
            /只从已验证 fetch 缓存读取/u,
        );

        const cached = await loadConversationData("dsh", sessionId, { source: "cache" });
        assert.ok(cached);
        assert.equal(cached.cacheGeneration, first.cacheGeneration);
        assert.deepEqual(cached.rounds[0].userMessages?.map(item => item.text), ["真人问题"]);

        await appendFile(sourcePath, line(messageEvent(4, "user", "追加的人类消息")), "utf8");
        const refreshed = await loadConversationData("dsh", sessionId, { source: "local", refresh: true });
        assert.ok(refreshed);
        assert.notEqual(refreshed.cacheGeneration, first.cacheGeneration);
        assert.equal(refreshed.rounds.some(round => round.userMessages?.some(item => item.text === "追加的人类消息")), true);

        await assert.rejects(
            () => loadConversationData("dsh", sessionId, { source: "ls" }),
            /source=ls 不支持 dsh/u,
        );
    } finally {
        resetConversationSourceCacheForTests();
        if (previousRoot === undefined) delete process.env.MEMORY_STORE_DSH_SESSIONS_ROOT;
        else process.env.MEMORY_STORE_DSH_SESSIONS_ROOT = previousRoot;
        await rm(root, { recursive: true, force: true });
        await rm(cacheRoot, { recursive: true, force: true });
    }
}

await run();
console.log("dsh-conversation-bridge tests passed");

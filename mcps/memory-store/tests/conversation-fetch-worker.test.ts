import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildCodexFetchTaskId,
    createCodexFetchWorkerPayload,
    runCodexFetchWorker,
} from "../src/conversation-fetch-worker-client.ts";
import {
    createCodexFetchWorkerLinkDiagnostics,
    isCodexFetchWorkerPayload,
    resolveCodexFetchWorkerLink,
} from "../src/conversation-fetch-worker-types.ts";
import { writeFetchedConversationArtifact } from "../src/conversation-fetch-artifact.ts";
import { getBackgroundTaskRecoveryHandler } from "../src/background-tasks.ts";
import {
    assertCodexSourceVersion,
    buildCodexRoundsFromRolloutForTest,
    captureCodexSourceVersion,
} from "../src/codex-client.ts";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-fetch-worker-"));
const fixturePath = path.join(testRoot, "fixture-worker.mjs");
const sourcePath = path.join(testRoot, "source.jsonl");
fs.writeFileSync(sourcePath, "fixture source\n", "utf8");
const sourceVersion = captureCodexSourceVersion(sourcePath);

function writeFixture(): void {
    fs.writeFileSync(fixturePath, `
import fs from "node:fs";

const mode = process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_MODE;
const artifactPath = process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_ARTIFACT;
let running = false;

process.on("message", message => {
    if (message?.type === "cancel") {
        if (mode === "cancel") return;
        process.disconnect?.();
        return;
    }
    if (running || message?.type !== "run") return;
    running = true;
    if (mode === "error") {
        process.stderr.write("fixture stderr tail\\n");
        process.send?.({ type: "error", name: "FixtureError", message: "fixture failed", stack: "FixtureError: fixture failed\\n    at fixture:1:1" }, () => process.disconnect?.());
        return;
    }
    fs.writeFileSync(artifactPath, "fixture artifact");
    process.send?.({ type: "artifact_path", path: artifactPath });
    if (mode === "cancel") {
        setInterval(() => undefined, 1_000);
        return;
    }
    process.send?.({ type: "progress", stage: "artifact", detail: "fixture progress" });
    process.send?.({
        type: "result",
        result: {
            artifact: { tempPath: artifactPath, roundCount: 3, aiResponseCount: 2, toolCallCount: 1, attachmentCount: 0 },
            chainUsed: "codex",
            conversationId: message.payload.conversationId,
            totalSteps: 9,
            roundCount: 3,
            sourceMode: "local",
            thread: { id: message.payload.conversationId, title: "fixture", cwd: "" },
            parentThread: null,
            timings: { cacheMs: 1, artifactMs: 2, totalMs: 3 }
        }
    }, () => process.disconnect?.());
});
`, "utf8");
}

function createContext(state: { cancelled: boolean; settled: boolean; progress: string[] }) {
    return {
        updateProgress: (progress: { stage?: string; detail?: string }) => state.progress.push(`${progress.stage || ""}:${progress.detail || ""}`),
        isCancelled: () => state.cancelled,
        isSettled: () => state.settled,
    };
}

async function waitForPath(filePath: string, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

const payload = createCodexFetchWorkerPayload({
    conversationId: "00000000-0000-0000-0000-000000000039",
    link: "reference",
    source: "local",
    estimate: {
        ...sourceVersion,
        thresholdBytes: 256 * 1024 * 1024,
        shouldBackground: true,
    },
    modelChain: "codex",
    now: 1_722_000_000_000,
});

try {
    writeFixture();
    assert.equal(isCodexFetchWorkerPayload(payload), true);
    assert.equal(isCodexFetchWorkerPayload({ ...payload, modelChain: "windsurf" }), false);
    const expandedLink = resolveCodexFetchWorkerLink("expand_children");
    assert.deepEqual(expandedLink, {
        requestedLink: "expand_children",
        effectiveLink: "reference",
    });
    assert.deepEqual(
        createCodexFetchWorkerLinkDiagnostics(expandedLink, [
            { threadId: "00000000-0000-0000-0000-000000000040", nickname: "child-a" },
            { threadId: "00000000-0000-0000-0000-000000000041" },
        ]),
        [
            {
                code: "expand_children_downgraded_to_reference",
                message: "Codex 后台 fetch 请求的 link=expand_children 已安全降级为 link=reference，不会递归加载父/子 raw JSONL；子代理请使用各自的 conversationId 单独发起 fetch。",
            },
            {
                code: "child_conversation_fetch_required",
                conversationId: "00000000-0000-0000-0000-000000000040",
                nickname: "child-a",
                message: "子代理未在父请求中展开，请使用 conversationId=00000000-0000-0000-0000-000000000040 单独发起 fetch。",
            },
            {
                code: "child_conversation_fetch_required",
                conversationId: "00000000-0000-0000-0000-000000000041",
                nickname: undefined,
                message: "子代理未在父请求中展开，请使用 conversationId=00000000-0000-0000-0000-000000000041 单独发起 fetch。",
            },
        ],
    );
    for (const link of ["reference", "summary"] as const) {
        const resolution = resolveCodexFetchWorkerLink(link);
        assert.deepEqual(resolution, { requestedLink: link, effectiveLink: link });
        assert.deepEqual(createCodexFetchWorkerLinkDiagnostics(resolution, [{ threadId: "child-id" }]), []);
    }
    assert.equal(buildCodexFetchTaskId(payload), buildCodexFetchTaskId({ ...payload }));
    assert.notEqual(buildCodexFetchTaskId(payload), buildCodexFetchTaskId({ ...payload, sourceMtimeMs: payload.sourceMtimeMs + 1 }));

    fs.appendFileSync(sourcePath, "appended tail\n", "utf8");
    await assert.doesNotReject(() => assertCodexSourceVersion(sourcePath, payload, "after append"));
    const sourceHandle = fs.openSync(sourcePath, "r+");
    try {
        fs.writeSync(sourceHandle, Buffer.from("X", "utf8"), 0, 1, payload.anchorStartByte);
    } finally {
        fs.closeSync(sourceHandle);
    }
    await assert.rejects(() => assertCodexSourceVersion(sourcePath, payload, "after prefix replacement"), /source changed/u);
    fs.writeFileSync(sourcePath, "fixture source\n", "utf8");
    Object.assign(payload, captureCodexSourceVersion(sourcePath));

    await assert.rejects(
        () => runCodexFetchWorker(
            { ...payload, sourceMtimeMs: payload.sourceMtimeMs + 1 },
            createContext({ cancelled: false, settled: false, progress: [] }),
            { target: { file: fixturePath } },
        ),
        /source changed|fresh fetch/u,
    );
    await assert.rejects(
        () => runCodexFetchWorker(
            payload,
            createContext({ cancelled: true, settled: false, progress: [] }),
            { target: { file: fixturePath } },
        ),
        /cancelled before start/u,
    );

    const successArtifact = path.join(testRoot, "success.md");
    process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_MODE = "success";
    process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_ARTIFACT = successArtifact;
    const successState = { cancelled: false, settled: false, progress: [] as string[] };
    const success = await runCodexFetchWorker(payload, createContext(successState), {
        target: { file: fixturePath },
        cancelGraceMs: 20,
    });
    assert.equal(success.artifact.tempPath, successArtifact);
    assert.ok(successState.progress.some(item => item.includes("fixture progress")));
    assert.equal(fs.existsSync(successArtifact), true, "successful artifacts must remain available to the caller");

    process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_MODE = "error";
    process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_ARTIFACT = path.join(testRoot, "unused.md");
    await assert.rejects(
        () => runCodexFetchWorker(payload, createContext({ cancelled: false, settled: false, progress: [] }), {
            target: { file: fixturePath },
        }),
        error => {
            assert.ok(error instanceof Error);
            assert.equal(error.name, "FixtureError");
            assert.match(error.message, /fixture failed/u);
            assert.match(error.stack || "", /fixture:1:1/u);
            assert.match(error.stack || "", /fixture stderr tail/u);
            return true;
        },
    );

    const cancelledArtifact = path.join(testRoot, "cancelled.md");
    process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_MODE = "cancel";
    process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_ARTIFACT = cancelledArtifact;
    const cancelledState = { cancelled: false, settled: false, progress: [] as string[] };
    const cancelled = runCodexFetchWorker(payload, createContext(cancelledState), {
        target: { file: fixturePath },
        cancelGraceMs: 20,
    });
    await waitForPath(cancelledArtifact);
    cancelledState.cancelled = true;
    await assert.rejects(cancelled, /cancelled/u);
    assert.equal(fs.existsSync(cancelledArtifact), false, "hard-cancelled workers must not leave their registered artifact behind");

    const cooperativePath = path.join(testRoot, "cooperative.jsonl");
    fs.writeFileSync(cooperativePath, "{}\n".repeat(400_000), "utf8");
    let cancellationChecks = 0;
    await assert.rejects(
        () => buildCodexRoundsFromRolloutForTest(cooperativePath, "summary", {
            retainRounds: false,
            isCancelled: () => ++cancellationChecks >= 8,
        }),
        /cancelled/u,
    );
    assert.ok(cancellationChecks >= 8, "Codex streaming reader must poll cooperative cancellation while reading");

    let openedArtifactPath = "";
    await assert.rejects(
        () => writeFetchedConversationArtifact(
            { conversationId: payload.conversationId, totalSteps: 0, rounds: [] },
            [],
            [],
            {
                isCancelled: () => true,
                onArtifactPath: artifactPath => { openedArtifactPath = artifactPath; },
            },
        ),
        /cancelled/u,
    );
    assert.ok(openedArtifactPath);
    assert.equal(fs.existsSync(openedArtifactPath), false, "cooperative artifact cancellation must remove the partially opened file");

    await import("../src/tools/conversation.ts");
    const recoveryHandler = getBackgroundTaskRecoveryHandler("conversation-fetch");
    assert.ok(recoveryHandler, "conversation-fetch must register a startup recovery handler");
    const recoveryAction = await recoveryHandler?.({
        id: buildCodexFetchTaskId(payload),
        kind: "conversation-fetch",
        status: "running",
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        resumePayload: payload,
    });
    assert.equal(recoveryAction?.mode, "restart");

    console.log("conversation fetch worker tests passed");
} finally {
    delete process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_MODE;
    delete process.env.MEMORY_STORE_FETCH_WORKER_FIXTURE_ARTIFACT;
    fs.rmSync(testRoot, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import {
    AsyncSemaphore,
    backgroundTaskQueueClass,
    classifyToolRequest,
    formatBusyMessage,
    installToolConcurrency,
    isToolConcurrencyBypassed,
    resetToolConcurrencyForTest,
    runWithoutToolConcurrency,
    withToolConcurrency,
} from "../src/tool-concurrency.js";

async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

{
    const semaphore = new AsyncSemaphore(2);
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
        const release = await semaphore.acquire(100);
        assert.ok(release);
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active--;
        release();
    }));
    assert.equal(maxActive, 2, "AsyncSemaphore should cap concurrent work");
    assert.equal(semaphore.activeCount, 0, "AsyncSemaphore should release slots");
}

{
    const semaphore = new AsyncSemaphore(1);
    const release = await semaphore.acquire(100);
    assert.ok(release);
    const blocked = await semaphore.acquire(5);
    assert.equal(blocked, null, "acquire should return null after timeout");
    release();
}

{
    process.env.MEMORY_STORE_TOOL_MIXED_LIMIT = "1";
    resetToolConcurrencyForTest();
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 3 }, async (_, index) => {
        await withToolConcurrency("mixed", `mixed-${index}`, async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(8);
            active--;
        });
    }));
    assert.equal(maxActive, 1, "withToolConcurrency should respect env mixed limit");
    delete process.env.MEMORY_STORE_TOOL_MIXED_LIMIT;
    resetToolConcurrencyForTest();
}

{
    process.env.MEMORY_STORE_TOOL_LIGHT_LIMIT = "1";
    resetToolConcurrencyForTest();
    let firstRelease: (() => void) | undefined;
    const first = withToolConcurrency("light", "first", async () => {
        await new Promise<void>(resolve => { firstRelease = resolve; });
    });
    await sleep(5);
    const busy = await withToolConcurrency("light", "second", async () => "unexpected", {
        timeoutMs: 5,
        onBusy: message => message,
    });
    assert.match(busy, /busy/u, "busy response should include busy keyword");
    firstRelease?.();
    await first;
    delete process.env.MEMORY_STORE_TOOL_LIGHT_LIMIT;
    resetToolConcurrencyForTest();
}

{
    process.env.MEMORY_STORE_TOOL_MIXED_LIMIT = "1";
    resetToolConcurrencyForTest();
    await assert.rejects(
        () => withToolConcurrency("mixed", "throws", async () => {
            throw new Error("boom");
        }),
        /boom/u,
    );
    await withToolConcurrency("mixed", "after-throw", async () => "ok", { timeoutMs: 5 });
    delete process.env.MEMORY_STORE_TOOL_MIXED_LIMIT;
    resetToolConcurrencyForTest();
}

{
    assert.equal(isToolConcurrencyBypassed(), false);
    await runWithoutToolConcurrency(async () => {
        assert.equal(isToolConcurrencyBypassed(), true);
        process.env.MEMORY_STORE_TOOL_MIXED_LIMIT = "1";
        resetToolConcurrencyForTest();
        await Promise.all([
            withToolConcurrency("mixed", "bypass-a", async () => sleep(5)),
            withToolConcurrency("mixed", "bypass-b", async () => sleep(5)),
        ]);
        delete process.env.MEMORY_STORE_TOOL_MIXED_LIMIT;
        resetToolConcurrencyForTest();
    });
    assert.equal(isToolConcurrencyBypassed(), false);
}

assert.equal(classifyToolRequest("memory_query", { query: "语义", mode: "smart" }), "mixed");
assert.equal(classifyToolRequest("memory_query", { grep: "literal" }), "light");
assert.equal(classifyToolRequest("memory_stats", { action: "enhance" }), "mixed");
assert.equal(classifyToolRequest("record_manage", { action: "update" }), "auto-background");
assert.equal(classifyToolRequest("record_manage", { action: "bulk_update" }), "auto-background");
assert.equal(classifyToolRequest("record_manage", { action: "batch_update" }), "auto-background");
assert.equal(classifyToolRequest("record_manage", { action: "task_status" }), "light");
assert.equal(classifyToolRequest("background_task_status", { taskId: "task-1" }), "light");
assert.equal(classifyToolRequest("background_task_cancel", { taskId: "task-1" }), "light");
assert.equal(classifyToolRequest("stage_guard", { action: "check" }), "mixed");
assert.equal(classifyToolRequest("stage_guard", { action: "check", taskId: "task-1" }), "light");
assert.equal(classifyToolRequest("conversation_golden_extract", { taskId: "task-1" }), "light");
assert.equal(classifyToolRequest("conversation_golden_extract", {}), "auto-background");
assert.equal(classifyToolRequest("conversation_read_original", { action: "deep_locate" }), "auto-background");
assert.equal(classifyToolRequest("conversation_read_original", { action: "export", exportBatch: true }), "auto-background");
assert.equal(classifyToolRequest("conversation_read_original", { action: "export", exportFormat: "pdf", conversationId: "abc" }), "mixed");
assert.equal(classifyToolRequest("conversation_read_original", { action: "list", dataChain: "claude-code", query: "slow metadata" }), "mixed");
assert.equal(classifyToolRequest("conversation_read_original", { action: "search", dataChain: "windsurf", query: "content keywords" }), "mixed");
assert.equal(classifyToolRequest("conversation_read_original", { action: "read" }), "mixed");
assert.equal(backgroundTaskQueueClass("record-update"), "background");
assert.equal(backgroundTaskQueueClass("record-batch-update"), "background");
assert.equal(backgroundTaskQueueClass("conversation-batch-export"), "background");
assert.equal(backgroundTaskQueueClass("record-guide"), "background");
assert.equal(backgroundTaskQueueClass("unknown-kind"), null);
assert.match(formatBusyMessage("mixed", "stage_guard.check", 1000), /busy/u);

{
    process.env.MEMORY_STORE_TOOL_LIGHT_LIMIT = "1";
    process.env.MEMORY_STORE_TOOL_QUEUE_TIMEOUT_MS = "5";
    resetToolConcurrencyForTest();
    const handlers: Array<(args?: Record<string, unknown>) => Promise<unknown>> = [];
    const fakeServer = {
        tool(_name: string, _description: string, _schema: unknown, handler: (args?: Record<string, unknown>) => Promise<unknown>) {
            handlers.push(handler);
        },
    };
    installToolConcurrency(fakeServer);
    fakeServer.tool("memory_read", "", {}, async () => {
        await sleep(50);
        return { content: [{ type: "text" as const, text: "ok" }] };
    });
    const first = handlers[0]({});
    await sleep(1);
    const second = await handlers[0]({}) as { content?: Array<{ text?: string }> };
    assert.match(second.content?.[0]?.text || "", /busy/u, "installed wrapper should return busy through the classified queue");
    await first;
    delete process.env.MEMORY_STORE_TOOL_LIGHT_LIMIT;
    delete process.env.MEMORY_STORE_TOOL_QUEUE_TIMEOUT_MS;
    resetToolConcurrencyForTest();
}

{
    process.env.MEMORY_STORE_TOOL_LIGHT_LIMIT = "1";
    process.env.MEMORY_STORE_TOOL_QUEUE_TIMEOUT_MS = "5";
    resetToolConcurrencyForTest();
    const handlers: Array<(args?: Record<string, unknown>) => Promise<unknown>> = [];
    const fakeServer = {
        tool(_name: string, _description: string, _schema: unknown, handler: (args?: Record<string, unknown>) => Promise<unknown>) {
            handlers.push(handler);
        },
    };
    installToolConcurrency(fakeServer);
    fakeServer.tool("record_manage", "", {}, async () => ({ content: [{ type: "text" as const, text: "auto ok" }] }));
    const result = await handlers[0]({ action: "update" }) as { content?: Array<{ text?: string }> };
    assert.equal(result.content?.[0]?.text, "auto ok", "auto-background requests should bypass foreground semaphore instead of busying");
    const syncResult = await handlers[0]({ action: "update", background: false }) as { content?: Array<{ text?: string }> };
    assert.equal(syncResult.content?.[0]?.text, "auto ok", "background=false auto-background requests should still bypass foreground semaphore");
    delete process.env.MEMORY_STORE_TOOL_LIGHT_LIMIT;
    delete process.env.MEMORY_STORE_TOOL_QUEUE_TIMEOUT_MS;
    resetToolConcurrencyForTest();
}

console.log("✅ tool-concurrency tests passed");

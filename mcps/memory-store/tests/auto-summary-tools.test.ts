import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-summary-tools-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
let mode: "failure" | "success" = "failure";
let modelCalls = 0;
const server = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[{"id":"fixture-model"}]}');
        return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    modelCalls++;
    request.resume();
    request.on("end", () => {
        setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ choices: [{ message: { content: mode === "failure" ? "HTTP 503: Service unavailable" : "合成工具入口的新摘要，记录正文更新后的实际结果。" }, finish_reason: "stop" }] }));
        }, 70);
    });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address.port}`;
const store = await import("../src/store.ts");
const transport = await import("../src/provider-transport-adapter.ts");
const { registerUpdate } = await import("../src/tools/update.ts");
const { registerWrite } = await import("../src/tools/write.ts");
const { autoSummarySourceFingerprint } = await import("../src/auto-summary.ts");
await transport.configureProviderTransportAdapterForTest({ mode: "shadow" });
const callbacks = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
const mockServer = { tool: (name: string, _description: string, _schema: unknown, callback: (args: Record<string, unknown>) => Promise<unknown>) => callbacks.set(name, callback) };
registerUpdate(mockServer as never);
registerWrite(mockServer as never);
const workspace = "C:/synthetic-summary-tools";
const { hash } = store.ensureWorkspace(workspace);

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Synthetic background summary did not settle");
        await delay(15);
    }
}

try {
    const frontmatter = { id: "update-existing", title: "合成更新", tags: [], category: "general", created: "2026-01-01", updated: "2026-01-02", workspace, searchSummary: "手写搜索说明", autoSummary: "更新前的正常摘要" };
    const original = store.buildMemoryFile(frontmatter, "旧正文");
    store.writeMemoryFile(hash, frontmatter.id, original);
    await store.mutateWorkspaceIndex(hash, index => {
        index.entries.push({ id: frontmatter.id, title: frontmatter.title, tags: [], category: "general", searchSummary: frontmatter.searchSummary, autoSummary: frontmatter.autoSummary, createdAt: frontmatter.created, updatedAt: frontmatter.updated, lastAccessed: frontmatter.updated, sizeBytes: Buffer.byteLength(original), lineCount: store.countLines(original) });
    });
    await store.syncGlobalIndexForWorkspace(hash);
    await callbacks.get("memory_update")!({ id: frontmatter.id, content: "更新后的正文", modelChain: "grok" });
    assert.equal(store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!)?.frontmatter.autoSummary, frontmatter.autoSummary);
    await waitFor(() => String(store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!)?.frontmatter.autoSummaryProvenance).includes('"status":"failed"'));
    const failed = store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!);
    assert.equal(failed?.frontmatter.autoSummary, frontmatter.autoSummary);
    assert.match(failed?.body || "", /更新后的正文/);
    assert.equal(failed?.frontmatter.searchSummary, frontmatter.searchSummary);
    assert.match(String(failed?.frontmatter.autoSummaryProvenance), /service-error-response/);
    assert.equal(JSON.parse(String(failed?.frontmatter.autoSummaryProvenance)).provider, "grok");
    mode = "success";
    await callbacks.get("memory_update")!({ id: frontmatter.id, title: "合成更新后的标题", modelChain: "grok" });
    assert.equal(store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!)?.frontmatter.autoSummary, frontmatter.autoSummary);
    await waitFor(() => store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!)?.frontmatter.autoSummary === "合成工具入口的新摘要，记录正文更新后的实际结果。");
    const success = store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!);
    assert.equal(JSON.parse(String(success?.frontmatter.autoSummaryProvenance)).provider, "grok");
    const priorCalls = modelCalls;
    await callbacks.get("memory_update")!({ id: frontmatter.id, searchSummary: "", pinned: true, modelChain: "grok" });
    await delay(100);
    assert.equal(modelCalls, priorCalls);
    const metadataOnly = store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!);
    assert.equal(metadataOnly?.frontmatter.autoSummary, success?.frontmatter.autoSummary);
    assert.equal(metadataOnly?.frontmatter.autoSummaryProvenance, success?.frontmatter.autoSummaryProvenance);
    assert.equal(metadataOnly?.frontmatter.searchSummary || "", "");
    const concurrentCalls = modelCalls;
    await callbacks.get("memory_update")!({ id: frontmatter.id, content: "并发更新的合成正文", modelChain: "grok" });
    await callbacks.get("memory_update")!({ id: frontmatter.id, searchSummary: "并发写入的手写搜索说明", modelChain: "grok" });
    await waitFor(() => modelCalls >= concurrentCalls + 2);
    await waitFor(() => JSON.parse(String(store.parseMemoryFile(store.readMemoryFile(hash, frontmatter.id)!)?.frontmatter.autoSummaryProvenance || "null"))?.status === "generated");
    await delay(120);
    const concurrentContent = store.readMemoryFile(hash, frontmatter.id)!;
    const concurrent = store.parseMemoryFile(concurrentContent)!;
    assert.match(concurrent.body, /并发更新的合成正文/);
    assert.equal(concurrent.frontmatter.searchSummary, "并发写入的手写搜索说明");
    assert.equal(JSON.parse(String(concurrent.frontmatter.autoSummaryProvenance)).summarySource.sourceFingerprint, autoSummarySourceFingerprint(concurrentContent));
    await callbacks.get("memory_write")!({ title: "合成新建", content: "新记忆的合成正文", tags: ["synthetic"], workspace, modelChain: "grok" });
    const newEntry = store.readWorkspaceIndex(hash).entries.find(entry => entry.id !== frontmatter.id)!;
    assert.ok(newEntry);
    await waitFor(() => !!store.parseMemoryFile(store.readMemoryFile(hash, newEntry.id)!)?.frontmatter.autoSummary);
    const created = store.parseMemoryFile(store.readMemoryFile(hash, newEntry.id)!);
    assert.equal(JSON.parse(String(created?.frontmatter.autoSummaryProvenance)).provider, "grok");
    assert.match(created?.body || "", /新记忆的合成正文/);
    console.log("auto-summary-tools: actual memory_update/write callbacks preserve old summary on failure, replace after validated success, persist actual provenance, preserve metadata-only summary and avoid extra generation");
} finally {
    await transport.resetProviderTransportAdapterForTest();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}

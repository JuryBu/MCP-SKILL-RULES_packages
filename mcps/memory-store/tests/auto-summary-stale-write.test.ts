import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-auto-summary-stale-"));

const {
    ensureWorkspace,
    buildMemoryFile,
    writeMemoryFile,
    readMemoryFile,
    parseMemoryFile,
    deleteMemoryFile,
    mutateWorkspaceIndex,
    readGlobalIndex,
    readWorkspaceIndex,
    syncGlobalIndexForWorkspace,
} = await import("../src/store.ts");
const {
    captureAutoSummarySnapshot,
    shouldGenerateAutoSummaryForUpdate,
    writeAutoSummaryIfUnchanged,
} = await import("../src/auto-summary.ts");
type MemoryFrontmatter = import("../src/store.ts").MemoryFrontmatter;

const workspacePath = "C:\\auto-summary-stale-write";
const { hash } = ensureWorkspace(workspacePath);

assert.equal(shouldGenerateAutoSummaryForUpdate({
    contentChanged: false,
    titleChanged: true,
    tagsChanged: false,
    existingAutoSummary: undefined,
}), true, "仅修改标题且旧摘要请求会 stale 时，必须补发新摘要");
assert.equal(shouldGenerateAutoSummaryForUpdate({
    contentChanged: false,
    titleChanged: false,
    tagsChanged: true,
    existingAutoSummary: "旧摘要",
}), true, "标签变化会改变摘要输入，应重新生成");
assert.equal(shouldGenerateAutoSummaryForUpdate({
    contentChanged: false,
    titleChanged: false,
    tagsChanged: false,
    existingAutoSummary: "已有摘要",
}), false, "仅修改与摘要无关的元数据且已有摘要时无需重跑");

async function seedMemory(params: {
    id: string;
    title: string;
    tags: string[];
    body: string;
    updated: string;
    autoSummary?: string;
}): Promise<void> {
    const frontmatter: MemoryFrontmatter = {
        id: params.id,
        title: params.title,
        tags: params.tags,
        category: "technical-note",
        created: "2026-07-10T00:00:00.000Z",
        updated: params.updated,
        workspace: workspacePath,
        searchSummary: "search summary",
        autoSummary: params.autoSummary,
    };
    const fileContent = buildMemoryFile(frontmatter, params.body);
    writeMemoryFile(hash, params.id, fileContent);
    await mutateWorkspaceIndex(hash, (wsIndex) => {
        wsIndex.entries = wsIndex.entries.filter(entry => entry.id !== params.id);
        wsIndex.entries.push({
            id: params.id,
            title: params.title,
            searchSummary: "search summary",
            autoSummary: params.autoSummary,
            tags: params.tags,
            category: "technical-note",
            createdAt: frontmatter.created,
            updatedAt: params.updated,
            lastAccessed: params.updated,
            sizeBytes: Buffer.byteLength(fileContent, "utf-8"),
            lineCount: fileContent.split(/\r?\n/).length,
        });
    });
}

{
    const id = "memory-written";
    const title = "Auto summary write";
    const tags = ["auto", "summary"];
    const updated = "2026-07-10T01:00:00.000Z";
    const body = "初始正文";

    await seedMemory({ id, title, tags, body, updated });
    await syncGlobalIndexForWorkspace(hash);
    const snapshot = captureAutoSummarySnapshot({ title, tags, updated, body });

    const result = await writeAutoSummaryIfUnchanged({
        hash,
        memoryId: id,
        summary: "这是最新摘要",
        expectedFingerprint: snapshot.fingerprint,
        fallbackTitle: title,
        fallbackTags: tags,
    });

    assert.equal(result, "written");
    const parsed = parseMemoryFile(readMemoryFile(hash, id) || "");
    assert.equal(parsed?.frontmatter.autoSummary, "这是最新摘要");
    const indexEntry = readWorkspaceIndex(hash).entries.find(entry => entry.id === id);
    assert.equal(indexEntry?.autoSummary, "这是最新摘要");
    const workspaceTotalSize = readWorkspaceIndex(hash).entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    assert.equal(readGlobalIndex().workspaces[hash]?.totalSizeBytes, workspaceTotalSize, "摘要写回后应同步 global index 尺寸");
}

{
    const id = "memory-stale";
    const title = "Old snapshot";
    const tags = ["stale"];
    const body = "旧正文";
    const updated = "2026-07-10T02:00:00.000Z";

    await seedMemory({ id, title, tags, body, updated });
    const staleSnapshot = captureAutoSummarySnapshot({ title, tags, updated, body });

    await seedMemory({
        id,
        title: "New snapshot",
        tags: ["fresh"],
        body: "新正文",
        updated: "2026-07-10T02:05:00.000Z",
    });

    const result = await writeAutoSummaryIfUnchanged({
        hash,
        memoryId: id,
        summary: "旧请求的摘要",
        expectedFingerprint: staleSnapshot.fingerprint,
        fallbackTitle: title,
        fallbackTags: tags,
    });

    assert.equal(result, "stale");
    const parsed = parseMemoryFile(readMemoryFile(hash, id) || "");
    assert.equal(parsed?.body.replace(/^\n/u, ""), "新正文");
    assert.equal(parsed?.frontmatter.autoSummary, undefined);
}

{
    const id = "memory-deleted";
    const title = "Delete target";
    const tags = ["delete"];
    const body = "会被删除的正文";
    const updated = "2026-07-10T03:00:00.000Z";

    await seedMemory({ id, title, tags, body, updated });
    const snapshot = captureAutoSummarySnapshot({ title, tags, updated, body });
    deleteMemoryFile(hash, id);
    await mutateWorkspaceIndex(hash, (wsIndex) => {
        wsIndex.entries = wsIndex.entries.filter(entry => entry.id !== id);
    });

    const result = await writeAutoSummaryIfUnchanged({
        hash,
        memoryId: id,
        summary: "删除后的旧摘要",
        expectedFingerprint: snapshot.fingerprint,
        fallbackTitle: title,
        fallbackTags: tags,
    });

    assert.equal(result, "missing");
}

{
    const id = "memory-duplicate";
    const title = "Duplicate request";
    const tags = ["duplicate"];
    const body = "重复请求正文";
    const updated = "2026-07-10T04:00:00.000Z";

    await seedMemory({ id, title, tags, body, updated });
    const snapshot = captureAutoSummarySnapshot({ title, tags, updated, body });

    const firstResult = await writeAutoSummaryIfUnchanged({
        hash,
        memoryId: id,
        summary: "新请求先写入的摘要",
        expectedFingerprint: snapshot.fingerprint,
        fallbackTitle: title,
        fallbackTags: tags,
    });
    assert.equal(firstResult, "written");

    const secondResult = await writeAutoSummaryIfUnchanged({
        hash,
        memoryId: id,
        summary: "旧请求晚到的摘要",
        expectedFingerprint: snapshot.fingerprint,
        fallbackTitle: title,
        fallbackTags: tags,
    });
    assert.equal(secondResult, "existing");

    const parsed = parseMemoryFile(readMemoryFile(hash, id) || "");
    assert.equal(parsed?.frontmatter.autoSummary, "新请求先写入的摘要");
}

console.log("✅ auto-summary-stale-write 通过：未变更时写入，变更/删除/重复请求不会回写旧结果");

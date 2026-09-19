import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "record-workspace-consistency-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

type ToolResponse = { content?: Array<{ text?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;
const textOf = (response: ToolResponse) => (response.content || []).map(item => item.text || "").join("\n");
const jsonOf = (response: ToolResponse) => {
    const text = textOf(response);
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
};

try {
    const { ensureWorkspaceAsync } = await import("../src/store.ts");
    const { writeRecord, readRecord, writeRecordSidecar, resolveRecordConversationId } = await import("../src/record-store.ts");
    const { registerRecord, buildStructuredRecordSearchBlocks, buildRecordGuideRecommendations } = await import("../src/tools/record.ts");
    const workspace = path.join(dataRoot, "current");
    const remoteWorkspace = path.join(dataRoot, "legacy");
    const missingWorkspace = path.join(dataRoot, "missing");
    const { hash } = await ensureWorkspaceAsync(workspace);
    const { hash: remoteHash } = await ensureWorkspaceAsync(remoteWorkspace);
    await ensureWorkspaceAsync(missingWorkspace);
    const conversationId = "scope-record-primary-unique";
    const title = "Workspace consistency fixture";
    const body = (rounds: number, marker: string) => [
        "# Record", `- 总轮次：${rounds}`, `- 总步骤：${rounds}`,
        `## Phase 1：验证（轮次 1-${rounds}）`, "### 产出文件", `- ${marker}`,
    ].join("\n");
    const localBody = body(6, "current-workspace-marker");
    const remoteBody = body(100, "legacy-workspace-marker");
    const seed = (recordHash: string, recordId: string, content: string, rounds: number) => writeRecord(recordHash, recordId, content, {
        title, totalRounds: rounds, totalSteps: rounds, lastUpdatedRound: rounds, phases: 1,
    });
    await seed(hash, conversationId, localBody, 6);
    await seed(remoteHash, conversationId, remoteBody, 100);
    await seed("general", conversationId, body(80, "general-workspace-marker"), 80);
    let recordManage: Handler | undefined;
    registerRecord({
        tool(name: string, _description: string, _schema: unknown, handler: Handler) {
            if (name === "record_manage") recordManage = handler;
        },
    } as never);
    assert.ok(recordManage);
    const read = async (requestedWorkspace?: string, requestedId = conversationId) => jsonOf(await recordManage!({
        action: "read", workspace: requestedWorkspace, conversationId: requestedId,
        dataChain: "codex", view: "outline", format: "json", indexMode: "off",
    }));

    assert.equal((await read(workspace)).hash, hash, "explicit workspace must beat a legacy copy with more rounds");
    assert.equal((await read(missingWorkspace)).hash, remoteHash, "missing local copy keeps legacy fallback");
    assert.equal((await read()).hash, remoteHash, "omitted workspace keeps global best-copy fallback");
    assert.equal((await read(workspace, conversationId.slice(0, 18))).recordId, conversationId);
    assert.equal((await read(workspace, title)).hash, hash);
    assert.equal(resolveRecordConversationId(conversationId.slice(0, 18), hash), conversationId);
    assert.equal(resolveRecordConversationId(title, hash), conversationId);

    await writeRecordSidecar(hash, conversationId, "ownership.json", { status: "superseded", supersededBy: remoteHash });
    await writeRecordSidecar(remoteHash, conversationId, "ownership.json", { status: "superseded", supersededBy: hash });
    assert.equal((await read(workspace)).hash, hash, "cyclic legacy ownership must not hide the explicitly selected copy");
    const edit = await recordManage({ action: "edit", workspace, conversationId, dataChain: "codex", append: "workspace-edit-sentinel" });
    assert.match(textOf(edit), /已更新/u);
    assert.match(readRecord(hash, conversationId) || "", /workspace-edit-sentinel/u);
    assert.equal(readRecord(remoteHash, conversationId), remoteBody, "edit must not rewrite the other workspace");
    for (const indexMode of ["auto", "rebuild", "reuse", "off"] as const) {
        const blocks = await buildStructuredRecordSearchBlocks(hash, "workspace", false, {
            conversationId, searchScope: "record", indexMode,
        });
        assert.equal(blocks.length, 1);
        assert.match(blocks[0].content, /workspace-edit-sentinel/u, `search ${indexMode} must use edited local body`);
    }
    const scopedSearch = await recordManage({
        action: "search", workspace, conversationId, query: "workspace-edit-sentinel", mode: "exact", dataChain: "codex", searchScope: "record",
    });
    assert.doesNotMatch(textOf(scopedSearch), /未找到|无匹配|0 条/u);
    assert.match(textOf(scopedSearch), /workspace-edit-sentinel/u);
    const recommendations = await buildRecordGuideRecommendations(hash, "workspace", false, {
        conversationId, maxRecommendations: 2, indexMode: "off",
    });
    assert.ok(recommendations.length > 0);
    assert.ok(JSON.stringify(recommendations).includes(hash), "guide provenance must point to the selected workspace");
    assert.equal(jsonOf(await recordManage(recommendations[0].readHint!)).hash, hash, "executing the guide hint retains the selected workspace");
    const goalRecommendations = await buildRecordGuideRecommendations(hash, "workspace", false, {
        conversationId, goal: "workspace-edit-sentinel", maxRecommendations: 1, indexMode: "off",
    });
    assert.equal(goalRecommendations.length, 1);
    assert.match(textOf(await recordManage(goalRecommendations[0].readHint!)), /workspace-edit-sentinel/u);
    assert.match(textOf(await recordManage({ ...goalRecommendations[0].searchHint!, mode: "exact" })), /workspace-edit-sentinel/u);
    const rawRead = await recordManage({ action: "read", workspace, conversationId, startLine: 1, endLine: 40 });
    assert.match(textOf(rawRead), /workspace-edit-sentinel/u);

    const redirectedId = "scope-record-directed";
    await seed(hash, redirectedId, body(200, "superseded-source"), 200);
    await seed(remoteHash, redirectedId, body(2, "official-target"), 2);
    await seed("general", redirectedId, body(300, "unrelated-fallback"), 300);
    await writeRecordSidecar(hash, redirectedId, "ownership.json", { status: "superseded", supersededBy: remoteHash });
    assert.equal((await read(workspace, redirectedId)).hash, remoteHash, "valid ownership target outranks unrelated fallback");
    const directedBefore = readRecord(hash, redirectedId);
    const rejectedEdit = await recordManage({ action: "edit", workspace, conversationId: redirectedId, append: "must-not-write" });
    assert.match(textOf(rejectedEdit), /superseded/u, "editing a superseded copy must not silently succeed");
    assert.equal(readRecord(hash, redirectedId), directedBefore);
    assert.doesNotMatch(readRecord(remoteHash, redirectedId) || "", /must-not-write/u);

    const { hash: terminalHash } = await ensureWorkspaceAsync(path.join(dataRoot, "terminal"));
    await seed(terminalHash, redirectedId, body(1, "terminal-target"), 1);
    await writeRecordSidecar(remoteHash, redirectedId, "ownership.json", { status: "superseded", supersededBy: terminalHash });
    assert.equal((await read(workspace, redirectedId)).hash, terminalHash, "transitive ownership follows the terminal target");
    for (const targetHash of [hash, "missing-target-hash"]) {
        await writeRecordSidecar(hash, conversationId, "ownership.json", { status: "superseded", supersededBy: targetHash });
        assert.equal((await read(workspace)).hash, hash, "self or missing ownership targets retain the local copy");
    }
    await seed(hash, "scope-record-primary-other", body(1, "other-identity"), 1);
    assert.equal(resolveRecordConversationId("scope-record-primary", hash), null, "different IDs remain ambiguous");
    assert.equal(resolveRecordConversationId(title, hash), null, "same title across different IDs remains ambiguous");

    console.log("PASS record workspace consistency: explicit/omitted/missing workspace, duplicate identities, ownership cycles/redirects, edit-read-search and immutable legacy copies");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}

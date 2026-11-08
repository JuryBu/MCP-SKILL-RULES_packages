import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-tool-material-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
const cache = await import("../src/conversation-source-cache.ts");
const { projectConversationRoundForRecord } = await import("../src/conversation-record-projection.ts");
const { createProductionSourceReader } = await import("../src/record-production-source-readers.ts");
const { restoreRecordToolMaterials, projectRecordToolMaterial } = await import("../src/record-tool-material.ts");
const { formatRoundsForRecord, formatRoundsForRecordAsync } = await import("../src/record-generator.ts");
const { conversationLoadFromFrozenSource } = await import("../src/tools/record.ts");

const conversationId = "record-tool-material-fixture";
const round: ConversationRound = {
    roundIndex: 1,
    startStep: 10,
    endStep: 202,
    userMessage: "读取工具回执并导出真实交接材料",
    userMessages: [{ text: "读取工具回执并导出真实交接材料", stepIndex: 10, semanticRole: "user" }],
    mediaAttachments: [],
    aiResponses: [{ stepIndex: 18, response: "早期说明", thinking: "THINKING-MUST-STAY-OUT", toolCalls: [] }],
    toolCalls: [
        { stepIndex: 19, name: "exec", argsSummary: "包装脚本", resultSummary: "导出完成",
            argsFull: `const result = await tools.mcp__memory_store__conversation_read_original({action:"export"});${"中间脚本".repeat(800)}text("LATEST-ARGUMENT");`,
            resultFull: `HEAD-RESULT\n${"大量旧输出".repeat(800)}\n已导出 C:/fixture/recent/conversation.md TAIL-RESULT` },
        { stepIndex: 100, name: "mcp__memory_store__record_manage", argsSummary: "action=read", resultSummary: "读回成功", resultFull: "直接 MCP 的真实回执" },
        { stepIndex: 193, name: "wait", argsSummary: "cell_id=fixture", resultSummary: "导出完成", resultFull: "C:/fixture/recent/manifest.json" },
        { stepIndex: 201, name: "exec", argsSummary: "最近的请求", resultSummary: "", argsFull: "await tools.mcp__memory_store__record_manage({action:'update'});" },
    ],
    taskBoundaries: [],
    codeActions: [],
    subagentSummaries: [],
};

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);
    const projected = projectConversationRoundForRecord(round, 0);
    assert.equal(projected.recordToolMaterialVersion, 1);
    assert.equal(projected.messages[0].recordToolMaterial?.toolCalls.length, 4);
    assert.doesNotMatch(JSON.stringify(projected), /THINKING-MUST-STAY-OUT/u);
    const multiReceiptRound = structuredClone(round);
    multiReceiptRound.toolCalls[0].resultFull = JSON.stringify([
        { type: "input_text", text: "Script completed" },
        { type: "input_text", text: `FIRST-RECEIPT ${"旧输出".repeat(900)} FIRST-PATH/conversation.md` },
        { type: "input_text", text: `SECOND-RECEIPT ${"新输出".repeat(900)} SECOND-PATH/manifest.json` },
    ]);
    const multiReceipt = projectRecordToolMaterial(multiReceiptRound).toolCalls[0].resultFull!;
    for (const token of ["FIRST-RECEIPT", "SECOND-RECEIPT", "FIRST-PATH/conversation.md", "SECOND-PATH/manifest.json"]) {
        assert.ok(multiReceipt.includes(token), `每个包装输出块都须保留头尾: ${token}`);
    }
    for (const legacy of [false, true]) {
        const key = { source: "codex:link=summary", conversationId: `${conversationId}-${legacy}` };
        const published = await cache.readOrBuild({
            key,
            fingerprint: null,
            build: () => ({ snapshot: { conversationId: key.conversationId }, rounds: [round] }),
            getRoundNumber: item => item.roundIndex,
            projectRecordRound: item => {
                const value = projectConversationRoundForRecord(item, 0);
                if (legacy) {
                    delete value.recordToolMaterialVersion;
                    for (const message of value.messages) {
                        delete message.recordToolMaterial;
                        delete message.stepIndex;
                    }
                }
                return value;
            },
        });
        const reader = createProductionSourceReader();
        const scan = await reader.scan({
            host: "codex",
            conversationId: key.conversationId,
            workspace: { workspaceId: "fixture", canonicalPath: "C:/fixture" },
            paths: { stateDbPath: path.join(dataRoot, "must-not-open.sqlite"), sessionsRoots: [] },
            cacheGeneration: { key, generation: published.generation, fingerprint: null },
            sourceSnapshot: { totalSteps: 202 },
        });
        assert.equal(scan.fullSourceRead.status, "complete");
        if (scan.fullSourceRead.status !== "complete") assert.fail("source must be complete");
        const document = JSON.parse(Buffer.from(scan.fullSourceRead.payload.bytes).toString("utf8"));
        assert.equal(document.messages[0].recordToolMaterial.toolCalls.length, 4);
        assert.equal(scan.cacheSourceSnapshot?.materializedSource, legacy ? "verified-rounds" : "recordProjection");
        const restored = conversationLoadFromFrozenSource({
            snapshot: {
                sourceSnapshotId: "tool-material-fixture", chain: "codex", conversationId: key.conversationId,
                contentHash: scan.fullSourceRead.payload.contentHash,
                contentRef: { hash: scan.fullSourceRead.payload.contentHash },
            },
            document,
            cacheSourceSnapshot: scan.cacheSourceSnapshot,
        } as never);
        restoreRecordToolMaterials(restored.rounds, document.messages);
        restoreRecordToolMaterials(restored.rounds, document.messages);
        assert.deepEqual(restored.rounds[0].toolCalls.map(tool => tool.stepIndex), [19, 100, 193, 201]);
        assert.equal(restored.rounds[0].startStep, 10);
        assert.equal(restored.rounds[0].endStep, 202);
        assert.equal(restored.rounds[0].aiResponses[0].stepIndex, 18);
        const formatted = formatRoundsForRecord(restored.rounds)[0].text;
        assert.match(formatted, /本轮工具事件数：4；直接 MCP：1；exec 脚本包装：2；wait：1；其它：0/u);
        assert.match(formatted, /LATEST-ARGUMENT/u);
        assert.match(formatted, /HEAD-RESULT/u);
        assert.match(formatted, /TAIL-RESULT/u);
        assert.match(formatted, /C:\/fixture\/recent\/conversation\.md/u);
        assert.match(formatted, /C:\/fixture\/recent\/manifest\.json/u);
        assert.match(formatted, /本次冻结材料尚无该调用回执/u);
        assert.match(formatted, /中段省略/u);
        assert.doesNotMatch(formatted, /THINKING-MUST-STAY-OUT/u);
        assert.deepEqual(await formatRoundsForRecordAsync(restored.rounds), formatRoundsForRecord(restored.rounds));
        const invalid = structuredClone(document.messages);
        invalid[0].recordToolMaterial.toolCalls[0].stepIndex = 203;
        assert.throws(() => restoreRecordToolMaterials(restored.rounds, invalid), /工具材料结构或步骤范围无效/u);
    }
    console.log("PASS Record tools survive new and legacy verified cache, canonical source, restoration and both formatters; wrapper/direct counts, latest arguments/results and missing receipts checked; no model invoked");
} finally {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(undefined);
    fs.rmSync(dataRoot, { recursive: true, force: true });
}

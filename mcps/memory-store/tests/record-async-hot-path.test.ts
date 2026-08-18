import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-hot-path-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

type ToolResponse = { content?: Array<{ text?: string }> };
type RecordManageHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function textOf(response: ToolResponse): string {
    return (response.content || []).map(item => item.text || "").join("\n");
}

function syncFsTrap(): () => void {
    const names = [
        "existsSync",
        "mkdirSync",
        "readFileSync",
        "readdirSync",
        "renameSync",
        "statSync",
        "writeFileSync",
    ] as const;
    const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(fs, name)]));
    for (const name of names) {
        Object.defineProperty(fs, name, {
            configurable: true,
            value: () => {
                throw new Error(`Record read/search/guide hot path must not use fs.${name}`);
            },
        });
    }
    return () => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(fs, name, descriptor);
            else Reflect.deleteProperty(fs, name);
        }
    };
}

try {
    const { ensureWorkspaceAsync } = await import("../src/store.ts");
    const { writeRecord, writeRecordSidecar } = await import("../src/record-store.ts");
    const { registerRecord } = await import("../src/tools/record.ts");

    const workspace = path.join(dataRoot, "workspace");
    const { hash } = await ensureWorkspaceAsync(workspace);
    const recordId = "async-hot-path-record";
    const longRecordId = "async-hot-path-long-record";
    const record = [
        "# Record：异步热路径",
        "",
        `- 对话ID：\`${recordId}\``,
        "- 总轮次：4",
        "- 总步骤：4",
        "",
        "## Phase 1：已完成（轮次 1-2）",
        "",
        "- evidence: async read/search/guide",
    ].join("\n");
    const longRecord = [
        "# Record：超长异步热路径",
        "",
        `- 对话ID：\`${longRecordId}\``,
        "- 总轮次：2",
        "- 总步骤：2",
        "",
        "## Phase 1：超长内容（轮次 1-2）",
        "",
        `- oversized-needle ${"x".repeat(9_000)}`,
    ].join("\n");

    await writeRecord(hash, recordId, record, {
        title: "异步热路径",
        totalRounds: 4,
        totalSteps: 4,
        lastUpdatedRound: 4,
        phases: 1,
    });
    await writeRecord("general", recordId, `${record}\n\n旧副本`, {
        title: "旧副本",
        totalRounds: 4,
        totalSteps: 4,
        lastUpdatedRound: 4,
        phases: 1,
    });
    await writeRecordSidecar("general", recordId, "ownership.json", {
        status: "superseded",
        supersededBy: hash,
    });
    await writeRecord(hash, longRecordId, longRecord, {
        title: "超长异步热路径",
        totalRounds: 2,
        totalSteps: 2,
        lastUpdatedRound: 2,
        phases: 1,
    });

    let recordManage: RecordManageHandler | null = null;
    registerRecord({
        tool(name: string, _description: string, _schema: unknown, handler: RecordManageHandler) {
            if (name === "record_manage") recordManage = handler;
        },
    } as never);
    assert.ok(recordManage, "record_manage public handler should be registered");

    const restoreFs = syncFsTrap();
    try {
        const read = await recordManage({
            action: "read",
            workspace,
            conversationId: recordId,
            view: "outline",
        });
        const readText = textOf(read);
        assert.match(readText, /Record Outline/u);
        assert.match(readText, /疑似只覆盖 2\/4 轮/u);

        const search = await recordManage({
            action: "search",
            workspace,
            query: "evidence",
            mode: "exact",
            conversationId: recordId,
            searchScope: "section",
        });
        assert.match(textOf(search), /结构化搜索/u);
        assert.match(textOf(search), new RegExp(recordId, "u"));

        const guide = await recordManage({
            action: "guide",
            workspace,
            conversationId: recordId,
            format: "json",
        });
        const guidePayload = JSON.parse(textOf(guide).replace(/\n⏱ 耗时 [\d.]+s$/u, "")) as { recommendations: unknown[] };
        assert.ok(guidePayload.recommendations.length > 0, "guide should build a read route from async search targets");

        const longRead = await recordManage({
            action: "read",
            workspace,
            conversationId: longRecordId,
        });
        const longReadText = textOf(longRead);
        const readTempPath = longReadText.split("已保存到临时文件: ")[1]?.split("\n")[0];
        assert.ok(readTempPath, `long read should write a temp file: ${longReadText}`);
        assert.equal((await fs.promises.stat(readTempPath)).isFile(), true);

        const longSearch = await recordManage({
            action: "search",
            workspace,
            query: "oversized-needle",
            mode: "exact",
            conversationId: longRecordId,
            searchScope: "section",
            format: "json",
        });
        const longSearchText = textOf(longSearch);
        const searchTempPath = longSearchText.split("临时文件: ")[1]?.split("\n")[0];
        assert.ok(searchTempPath, `long search should write a temp file: ${longSearchText}`);
        assert.equal((await fs.promises.stat(searchTempPath)).isFile(), true);
    } finally {
        restoreFs();
    }

    console.log("✅ record async hot path tests passed");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}

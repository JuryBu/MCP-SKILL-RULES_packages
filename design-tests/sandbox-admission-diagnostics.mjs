import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

let lifecycleUrl = new URL("../mcps/sandbox/dist/lifecycle.js", import.meta.url).href;
if (process.env.SANDBOX_DIAGNOSTICS_SOURCE_TEST === "1") {
    const { stripTypeScriptTypes } = await import("node:module");
    const helperSource = fs.readFileSync(new URL("../mcps/sandbox/src/admission-diagnostics.ts", import.meta.url), "utf8");
    const helperUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(helperSource)).toString("base64")}`;
    const lifecycleSource = fs.readFileSync(new URL("../mcps/sandbox/src/lifecycle.ts", import.meta.url), "utf8")
        .replace('"./admission-diagnostics.js"', JSON.stringify(helperUrl));
    lifecycleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(lifecycleSource)).toString("base64")}`;
}
const { ensureModelVisibleToolResult, appendTiming } = await import(lifecycleUrl);

function admissionResult(overrides = {}) {
    return {
        isError: true,
        content: [{ type: "text", text: "❌ admission_timeout: 命令尚未启动；建议 0ms 后随机重试" }],
        structuredContent: {
            error: {
                type: "admission_timeout",
                queueWaitMs: 2010,
                retryAfterMs: 0,
                commandStarted: false,
                mayHaveStarted: false,
                admissionDecision: {
                    requestedMB: 24,
                    reservedMB: 64,
                    protectedReservationMB: 0,
                    startupReservedMB: 128,
                    projectedPhysicalAvailableMB: 2400,
                    projectedCommitAvailableMB: 9500,
                    pressureSampleAgeMs: 100,
                    blockedBy: ["reservation_capacity"],
                    admissionMode: "fixed",
                },
                memoryPressure: {
                    activeReservedMB: 1504,
                    admissionLimitMB: 1536,
                    observedMemoryMB: 879,
                    hardLimitMB: 2048,
                    systemAvailableMemoryMB: 2600,
                    commitAvailableMemoryMB: 9700,
                },
                ...overrides,
            },
        },
    };
}

function visibleText(result) {
    return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

test("content-only consumers see effective request, true cause and bounded snapshots", () => {
    const original = admissionResult();
    const originalError = structuredClone(original.structuredContent.error);
    const result = ensureModelVisibleToolResult(original);
    const text = visibleText(result);
    assert.match(text, /有效请求：64MB.*原始申请：24MB.*服务端已调整/u);
    assert.match(text, /不等于物理内存耗尽.*reservation_capacity/u);
    assert.match(text, /物理可用 2600MB → 接纳后预计 2400MB/u);
    assert.match(text, /系统提交余量 9700MB → 接纳后预计 9500MB/u);
    assert.match(text, /采样年龄 100ms/u);
    assert.match(text, /已预留 1504MB \/ 接纳额度 1536MB/u);
    assert.match(text, /实测占用 879MB/u);
    assert.doesNotMatch(text, /保护上限 2048MB/u);
    assert.match(text, /0 不表示立即重试/u);
    assert.doesNotMatch(text, /0ms 后随机重试/u);
    assert.equal(result.structuredContent.text, text);
    assert.deepEqual(result.structuredContent.error, originalError);
    assert.ok(Buffer.byteLength(text, "utf8") < 4000);
});

test("watermark diagnostics show startup observations without implying legacy global caps still block", () => {
    const input = admissionResult();
    Object.assign(input.structuredContent.error.admissionDecision, {
        admissionMode: "watermark",
        requestedMB: 24,
        reservedMB: 24,
        startupReservedMB: 96,
        blockedBy: ["physical_headroom"],
    });
    const text = visibleText(ensureModelVisibleToolResult(input));
    assert.match(text, /有效请求：24MB.*原始申请：24MB/u);
    assert.match(text, /接纳策略：动态水位/u);
    assert.match(text, /启动待观测预估 96MB/u);
    assert.doesNotMatch(text, /已调整申请量|已预留|接纳额度|保护上限|1536MB|2048MB/u);
});

const reasonCases = [
    ["physical_headroom", /物理内存余量不足/u],
    ["commit_headroom", /系统提交余量不足/u],
    ["missing_pressure_sample", /缺少完整内存采样/u],
    ["stale_pressure_sample", /内存采样已过期/u],
    ["windows_low_memory", /Windows 已报告低内存/u],
    ["emergency_pressure", /紧急水位/u],
    ["heavy_request_yellow", /警戒区暂停大请求/u],
    ["observed_hard_limit", /实测占用达到服务保护上限/u],
    ["resource_recovery_pending", /服务恢复尚未完成/u],
    ["recovery_pending", /服务恢复尚未完成/u],
];

for (const [reason, pattern] of reasonCases) {
    test(`explains ${reason} without claiming reservation exhaustion`, () => {
        const input = admissionResult();
        input.structuredContent.error.admissionDecision.blockedBy = [reason];
        const text = visibleText(ensureModelVisibleToolResult(input));
        assert.match(text, pattern);
        assert.doesNotMatch(text, /reservation_capacity/u);
    });
}

test("positive retry advice is bounded and requires a state check", () => {
    const text = visibleText(ensureModelVisibleToolResult(admissionResult({ retryAfterMs: 3500 })));
    assert.match(text, /至少等待 3500ms.*sandbox_status.*最多重试一次/u);
    assert.match(text, /不要并发或循环重发/u);
});

test("missing diagnostics are explicit unknowns, not inferred low memory", () => {
    const result = ensureModelVisibleToolResult(admissionResult({
        admissionDecision: undefined,
        memoryPressure: undefined,
        queueWaitMs: undefined,
        retryAfterMs: undefined,
    }));
    const text = visibleText(result);
    assert.match(text, /有效请求：未提供/u);
    assert.match(text, /未提供具体阻断条件，不能据此认定系统内存不足/u);
    assert.match(text, /采样年龄 未提供/u);
    assert.doesNotMatch(text, /NaN|undefined|null/u);
});

test("queue full and request limits remain actionable without an admission decision", () => {
    for (const [type, pattern] of [
        ["admission_queue_full", /等待队列达到容量上限/u],
        ["reservation_exceeds_admission_limit", /有效请求超过配置的接纳额度/u],
        ["reservation_exceeds_hard_limit", /有效请求超过服务内存保护上限/u],
    ]) {
        const text = visibleText(ensureModelVisibleToolResult(admissionResult({ type, admissionDecision: undefined })));
        assert.match(text, pattern);
        assert.match(text, /命令尚未启动/u);
        assert.match(text, /不要.*循环重发/u);
        if (type.startsWith("reservation_exceeds_")) assert.doesNotMatch(text, /最多重试一次/u);
    }
});

test("cancelled admission never advises automatically restarting the command", () => {
    const text = visibleText(ensureModelVisibleToolResult(admissionResult({ type: "admission_aborted", retryAfterMs: 500 })));
    assert.match(text, /不要自动重试已取消请求/u);
    assert.doesNotMatch(text, /至少等待|最多重试一次/u);
});

test("repeated normalization and timing preserve one canonical diagnostic", () => {
    const result = ensureModelVisibleToolResult(admissionResult());
    const first = JSON.stringify(result);
    assert.equal(ensureModelVisibleToolResult(result), result);
    assert.equal(JSON.stringify(result), first);
    appendTiming(result, Date.now());
    const timed = JSON.stringify(result);
    ensureModelVisibleToolResult(result);
    assert.equal(JSON.stringify(result), timed);
    assert.equal(visibleText(result).match(/实际阻断：/gu).length, 1);
    assert.match(visibleText(result), /耗时/u);
});

test("absent text is populated and other MCP content remains untouched", () => {
    const result = admissionResult();
    const resourceLink = { type: "resource_link", uri: "memory://artifact", name: "artifact" };
    result.content = [resourceLink];
    ensureModelVisibleToolResult(result);
    ensureModelVisibleToolResult(result);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0], resourceLink);
    assert.match(visibleText(result), /实际阻断/u);
});

test("diagnostics never copy arbitrary messages, paths, owners or unknown reason payloads", () => {
    const secret = "private-token-C:\\private\\owner-task";
    const result = admissionResult({ message: secret, ownerId: secret, command: secret });
    result.structuredContent.error.admissionDecision.blockedBy = [secret, "reservation_capacity", ...Array(100).fill("reservation_capacity")];
    result.structuredContent.error.admissionDecision.admissionMode = secret;
    result.structuredContent.error.memoryPressure.systemAvailableMemoryMB = secret;
    const text = visibleText(ensureModelVisibleToolResult(result));
    assert.ok(!text.includes(secret));
    assert.ok(!result.structuredContent.text.includes(secret));
    assert.match(text, /未识别的接纳条件/u);
    assert.match(text, /物理可用 未提供/u);
    assert.equal(text.match(/reservation_capacity/gu).length, 1);
    assert.ok(Buffer.byteLength(text, "utf8") < 4000);
    assert.equal(result.structuredContent.error.message, secret);
});

test("invalid numerical fields stay unknown while valid zero and negative projections survive", () => {
    const result = admissionResult();
    Object.assign(result.structuredContent.error.admissionDecision, {
        reservedMB: NaN,
        requestedMB: "24",
        projectedPhysicalAvailableMB: -20,
        projectedCommitAvailableMB: Infinity,
        pressureSampleAgeMs: 0,
    });
    const text = visibleText(ensureModelVisibleToolResult(result));
    assert.match(text, /有效请求：未提供/u);
    assert.match(text, /接纳后预计 -20MB/u);
    assert.match(text, /采样年龄 0ms/u);
    assert.doesNotMatch(text, /NaN|Infinity/u);
});

test("non-admission and potentially started errors preserve the original text", () => {
    for (const overrides of [
        { type: "execution_timeout" },
        { type: "broker_backend_timeout" },
        { type: "admission_timeout", commandStarted: true },
        { type: "admission_timeout", mayHaveStarted: true },
        { type: "admission_timeout_unknown" },
    ]) {
        const input = admissionResult(overrides);
        input.content[0].text = "原始错误正文";
        const result = ensureModelVisibleToolResult(input);
        assert.equal(visibleText(result), "原始错误正文");
        assert.equal(result.structuredContent.text, "原始错误正文");
    }
    for (const input of [{ content: [] }, { content: [{ type: "text", text: "ordinary" }] }]) {
        const before = structuredClone(input);
        ensureModelVisibleToolResult(input);
        assert.deepEqual(input, before);
    }
});

test("existing large-text and JSON-heavy response protection remains compatible", () => {
    for (const text of ["x".repeat(500 * 1024), "\0".repeat(100_000)]) {
        const result = ensureModelVisibleToolResult({ content: [{ type: "text", text }], structuredContent: { exitCode: 1 } });
        assert.equal(result.structuredContent.text, text);
        assert.match(result.content[0].text, /structuredContent\.text/u);
        assert.equal(result.structuredContent.exitCode, 1);
    }
    const result = ensureModelVisibleToolResult({
        content: [{ type: "text", text: "x".repeat(1100 * 1024) }],
        structuredContent: { exitCode: 1 },
    });
    assert.equal(result.structuredContent.textTruncated, true);
    assert.ok(result.structuredContent.textPreview.length < 8300);
});

test("oversized metadata does not duplicate admission diagnostics or overwrite evidence", () => {
    const input = admissionResult();
    input.structuredContent.evidence = "x".repeat(1100 * 1024);
    const result = ensureModelVisibleToolResult(input);
    const first = JSON.stringify(result);
    ensureModelVisibleToolResult(result);
    assert.equal(JSON.stringify(result), first);
    assert.equal(result.structuredContent.evidence.length, 1100 * 1024);
    assert.equal(result.structuredContent.text, undefined);
    assert.equal(result.structuredContent.textTruncated, true);
    assert.match(visibleText(result), /有效请求：64MB/u);
});

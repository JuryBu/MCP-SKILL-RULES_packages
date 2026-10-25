import assert from "node:assert/strict";
import { isGuardInfrastructureError, resolveGuardSelfReferenceResult, type GuardCheckResult } from "../src/guard-engine.ts";

function guardResult(summary: string, missingItems: string[]): GuardCheckResult {
    return {
        passed: false,
        summary,
        missingItems,
        rawResponse: [
            "FAIL",
            summary,
            ...missingItems.map(item => `- MISSING: ${item}`),
        ].join("\n"),
    };
}

const selfReference = resolveGuardSelfReferenceResult(guardResult(
    "Stage 8.4 原功能证据看起来充分，但本轮复检收口没有执行结果证据。",
    [
        "Stage 8.4 本次 Guard 返回结果 未做：当前check还没有返回结果。",
        "Stage 8.4 完成标记 未做：缺少本次 Guard 通过后才能写入的完成记录。",
    ],
));

assert.equal(selfReference.passed, true);
assert.equal(selfReference.selfReferenceResolved, true);
assert.deepEqual(selfReference.missingItems, []);
assert.equal(selfReference.selfReferenceItems?.length, 2);
assert.match(selfReference.summary, /Guard 自指收口项/u);

assert.equal(resolveGuardSelfReferenceResult(guardResult("实质证据已充分", ["[Stage63] 本次 Guard 返回结果缺少"])).passed, true);
for (const item of [
    "本次 Guard 返回结果缺少 [验收报告.pdf]",
    "本次 Guard 返回结果缺少 [evidence.data]",
    "[Stage63 验收说明] 本次 Guard 返回结果缺少",
    "本次 Guard 返回结果缺少 [Stage63]",
]) {
    const checked = resolveGuardSelfReferenceResult(guardResult("实质证据已充分", [item]));
    assert.equal(checked.passed, false, item);
    assert.equal(checked.selfReferenceResolved, undefined, item);
    assert.deepEqual(checked.missingItems, [item]);
}

const realMissing = resolveGuardSelfReferenceResult(guardResult(
    "Stage 3 证据不足，缺少实现和测试。",
    [
        "Stage 3 schema 实现 未做：未新增 src/schema.ts，也没有单元测试。",
    ],
));

assert.equal(realMissing.passed, false);
assert.equal(realMissing.selfReferenceResolved, undefined);
assert.equal(realMissing.missingItems.length, 1);

const mixedMissing = resolveGuardSelfReferenceResult(guardResult(
    "Stage 9.4 的既有内存观察证据已落盘，但仍混有真实验证缺口。",
    [
        "Stage 9.4 Guard 复检收口 未做：未看到 appeal 结果或 cancel 结果。",
        "Stage 9.4 内存观察测试 未做：没有测试报告和命令输出。",
    ],
));

assert.equal(mixedMissing.passed, false);
assert.equal(mixedMissing.selfReferenceResolved, undefined);
assert.equal(mixedMissing.missingItems.length, 2);

const noEvidenceAcknowledgement = resolveGuardSelfReferenceResult(guardResult(
    "Stage 8.5 Takeover 复检已启动但未完整收口。",
    [
        "Stage 8.5 Guard appeal 收口 未做：未见 appeal 结果、cancel 锁或 PASS 报告。",
    ],
));

assert.equal(noEvidenceAcknowledgement.passed, false);
assert.equal(noEvidenceAcknowledgement.selfReferenceResolved, undefined);

const alreadyPassed: GuardCheckResult = {
    passed: true,
    summary: "全部通过。",
    missingItems: [],
    rawResponse: "PASS\n全部通过。",
};

assert.equal(resolveGuardSelfReferenceResult(alreadyPassed), alreadyPassed);

const infrastructureFailure: GuardCheckResult = {
    passed: false,
    summary: "Codex 模型桥调用失败，退出码 1",
    missingItems: [],
    rawResponse: "",
    infrastructureError: true,
};

assert.equal(isGuardInfrastructureError(infrastructureFailure), true);
assert.equal(resolveGuardSelfReferenceResult(infrastructureFailure), infrastructureFailure);

for (const missing of [
    ["本次 Guard 检查缺少 HTTP 原始日志"],
    ["本次 Guard 检查缺少 HTTP 原始日志和测试报告"],
    ["本次 Guard 返回结果尚未写入", "HTTP 原件缺失"],
    ["另一个Guard的旧通过记录未见"],
    ["本次Guard复核缺少业务报告"],
    ["本次 Guard 返回结果缺少 PDF"],
    ["历史Guard通过后才能写入的完成记录缺失"],
]) {
    const checked = resolveGuardSelfReferenceResult(guardResult("实质证据已充分，但缺少 HTTP 原始日志", missing));
    assert.equal(checked.passed, false);
    assert.deepEqual(checked.missingItems, missing);
}
console.log("guard-engine-self-reference ok: current-check closure only; HTTP/raw artifacts, mixed gaps and other Guards remain blocked");

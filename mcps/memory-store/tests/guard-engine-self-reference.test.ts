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
        "Stage 8.4 Subagent 求问复检收口 未做：执行记录停在“按规则 appeal 一次”，没有第二次 Guard/appeal 结果或 cancel 锁证据。",
        "Stage 8.4 完成标记 未做：缺少 Guard 通过后才能写入的完成记录。",
    ],
));

assert.equal(selfReference.passed, true);
assert.equal(selfReference.selfReferenceResolved, true);
assert.deepEqual(selfReference.missingItems, []);
assert.equal(selfReference.selfReferenceItems?.length, 2);
assert.match(selfReference.summary, /Guard 自指收口项/u);

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

console.log("guard-engine-self-reference ok");

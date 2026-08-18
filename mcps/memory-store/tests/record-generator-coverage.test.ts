import assert from "node:assert/strict";

const { inferCoveredRoundFromRecord, parseRecordDocument, enforceRecordHeaderMetadata } = await import("../src/record-generator.ts");

{
    const record = `
# Record：测试

- 总轮次：254

## Phase 1：旧阶段（轮次 1-20）
## Phase 2：新增阶段（轮次 21-100）
`;

    assert.equal(inferCoveredRoundFromRecord(record, 300), 100);
}

{
    const record = `
# 对话记录 Record

- 总轮次：18

## Phase 1：无明确轮次
`;

    assert.equal(inferCoveredRoundFromRecord(record, 20), 0);
}

{
    const record = `
# 对话记录 Record

- 总轮次 102
- 总步骤：20339

## Phase 1：初始化（轮次 1-1）
## Phase 2：规则加载（轮次 2-2）
## Phase 3：接力准备（轮次 3-3）

- 关键决策：开发对话4 Record 更新到 144 轮，这只是历史材料引用，不能当作本 Record 覆盖。
- 风险：旧 Record 覆盖到第 99 轮的说法也只是引用，不是本 Record 的结构边界。
- AI执行：排查时阅读了轮次 80-90 的历史片段，同样不能当作覆盖范围。
`;

    assert.equal(inferCoveredRoundFromRecord(record, 102), 3);
}

{
    const record = `
# Record：测试

<!-- Record 中段已省略，当前明确覆盖到第 206 轮 -->
## Phase 20：收尾（轮次 201-205）
`;

    assert.equal(inferCoveredRoundFromRecord(record, 250), 206);
}

{
    const record = `
# Record：测试

- 总轮次：999
## Phase 1：范围超过当前对话（轮次 1-500）
`;

    assert.equal(inferCoveredRoundFromRecord(record, 120), 120);
}

{
    const record = `
# Record：英文漂移

- 总轮次：177

\`\`\`md
## Phase 999：代码块里的假标题（Rounds 999-1000）
\`\`\`

## Phase 1：Dev6 基础架构与交互闭环 (Rounds 1-57)

- 正文引用旧候选的 **轮次范围**：1-3，不能覆盖标题范围。

## Phase 2：后续修复（Rounds 58-130）

## Phase 3：收口（Rounds 131-177）
`;

    const parsed = parseRecordDocument(record);
    assert.deepEqual(parsed.phases.map((phase: { startRound: number; endRound: number }) => [phase.startRound, phase.endRound]), [
        [1, 57],
        [58, 130],
        [131, 177],
    ]);
    assert.equal(inferCoveredRoundFromRecord(record, 177), 177);
    assert.ok(parsed.parseWarnings.some((warning: string) => warning.includes("英文 Rounds")));

    const normalized = enforceRecordHeaderMetadata(record, {
        conversationId: "english-drift",
        workspace: "test",
        totalRounds: 177,
        totalSteps: 28502,
    });
    assert.doesNotMatch(normalized, /Rounds\s+\d/u);
    assert.match(normalized, /（轮次 131-177）/u);
}

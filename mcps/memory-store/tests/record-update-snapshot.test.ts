import assert from "node:assert/strict";

const { buildSourceChangedWarning } = await import("../src/tools/record.ts");

{
    const warning = buildSourceChangedWarning({
        chain: "codex",
        rounds: 105,
        totalSteps: 20460,
        rolloutPath: "C:\\fake\\rollout.jsonl",
        rolloutMtimeMs: 1000,
    }, 2000);

    assert.match(warning || "", /继续追加/u);
    assert.match(warning || "", /启动快照覆盖 105 轮 \/ 20460 步/u);
    assert.match(warning || "", /再执行一次 update/u);
}

{
    const warning = buildSourceChangedWarning({
        chain: "codex",
        rounds: 105,
        totalSteps: 20460,
        rolloutPath: "C:\\fake\\rollout.jsonl",
        rolloutMtimeMs: 1000,
    }, 1020);

    assert.equal(warning, null);
}

{
    const warning = buildSourceChangedWarning({
        chain: "antigravity",
        rounds: 10,
        totalSteps: 100,
        rolloutPath: "C:\\fake\\rollout.jsonl",
        rolloutMtimeMs: 1000,
    }, 2000);

    assert.equal(warning, null);
}

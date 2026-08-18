import assert from "node:assert/strict";
import {
    AgyMemoryWatermarkEvidenceError,
    DEFAULT_AGY_MEMORY_WATERMARK_CONFIG,
    clearAgyMemoryWatermarkFreeze,
    createInitialAgyMemoryWatermarkState,
    effectiveAgyMemoryWatermarkLimit,
    observeAgyMemoryWatermark,
    restoreAgyMemoryWatermarkState,
    type AgyMemorySample,
    type AgyMemoryWatermarkConfig,
    type AgyMemoryWatermarkControlSnapshot,
} from "../src/agy-memory-watermark.ts";

const config: AgyMemoryWatermarkConfig = {
    ...DEFAULT_AGY_MEMORY_WATERMARK_CONFIG,
    lowWaterRecoverySamples: 3,
};

function snapshot(overrides: Partial<AgyMemoryWatermarkControlSnapshot> = {}): AgyMemoryWatermarkControlSnapshot {
    return {
        controlRevision: 41,
        ownerEpoch: 7,
        physicalMax: 8,
        currentLimit: 8,
        activeSlots: 0,
        memory: createInitialAgyMemoryWatermarkState(8),
        ...overrides,
    };
}

function observe(
    control: AgyMemoryWatermarkControlSnapshot,
    sample: AgyMemorySample | (() => AgyMemorySample),
    nowMonotonicMs: number,
    watermarkConfig = config,
) {
    return observeAgyMemoryWatermark(control, watermarkConfig, {
        sampleMemory: typeof sample === "function" ? sample : () => sample,
        nowMonotonicMs: () => nowMonotonicMs,
    }).transition;
}

function nextSnapshot(
    control: AgyMemoryWatermarkControlSnapshot,
    memory: AgyMemoryWatermarkControlSnapshot["memory"],
): AgyMemoryWatermarkControlSnapshot {
    return {
        ...control,
        controlRevision: control.controlRevision + 1,
        memory,
    };
}

{
    let control = snapshot();
    const limits: number[] = [];
    for (const nowMonotonicMs of [10, 20, 30, 40]) {
        const transition = observe(control, { usedBytes: 90, totalBytes: 100 }, nowMonotonicMs);
        limits.push(transition.memoryAimdLimitAfter);
        assert.equal(transition.reason, "high_watermark");
        assert.equal(transition.memoryAimdLimitAfter <= transition.memoryAimdLimitBefore, true, "高水位绝不能提升 memoryAimdLimit");
        control = nextSnapshot(control, transition.nextMemory);
    }
    assert.deepEqual(limits, [4, 2, 1, 0], "持续高压必须逐次乘性降低直到暂停");
}

{
    const control = snapshot({ activeSlots: 6 });
    const transition = observe(control, { usedBytes: 90, totalBytes: 100 }, 10);
    assert.equal(transition.memoryAimdLimitAfter, 4);
    assert.equal(transition.effectiveLimitAfter, 4);
    assert.equal(transition.grant.permitNewGrant, false, "借出的活跃槽超过新上限时必须阻止新 grant");
    assert.equal(transition.grant.activeSlots, 6, "水位控制只观察借槽，不修改正在运行的活跃槽");
    assert.equal(transition.grant.terminateRunningProcesses, false, "水位降低不得强杀已运行进程");
}

{
    let control = snapshot({ memory: createInitialAgyMemoryWatermarkState(2) });
    const first = observe(control, { usedBytes: 50, totalBytes: 100 }, 10);
    assert.equal(first.reason, "low_watermark_waiting");
    assert.equal(first.memoryAimdLimitAfter, 2);
    control = nextSnapshot(control, first.nextMemory);
    const second = observe(control, { usedBytes: 50, totalBytes: 100 }, 20);
    assert.equal(second.reason, "low_watermark_waiting");
    assert.equal(second.memoryAimdLimitAfter, 2);
    control = nextSnapshot(control, second.nextMemory);
    const third = observe(control, { usedBytes: 50, totalBytes: 100 }, 30);
    assert.equal(third.reason, "low_watermark_recovery");
    assert.equal(third.memoryAimdLimitAfter, 3, "连续三个低水位样本后只加一格");
    control = nextSnapshot(control, third.nextMemory);
    const fourth = observe(control, { usedBytes: 50, totalBytes: 100 }, 40);
    const fifth = observe(nextSnapshot(control, fourth.nextMemory), { usedBytes: 50, totalBytes: 100 }, 50);
    const sixth = observe(nextSnapshot(nextSnapshot(control, fourth.nextMemory), fifth.nextMemory), { usedBytes: 50, totalBytes: 100 }, 60);
    assert.equal(sixth.memoryAimdLimitAfter, 4, "恢复必须按完整窗口缓慢逐步增加");
}

{
    const state = createInitialAgyMemoryWatermarkState(4);
    state.lowWaterSamples = 2;
    state.recoveryCredits = 2;
    let control = snapshot({ memory: state });
    const middle = observe(control, { usedBytes: 75, totalBytes: 100 }, 10);
    assert.equal(middle.reason, "middle_band");
    assert.equal(middle.memoryAimdLimitAfter, 4, "夹层保持当前 memoryAimdLimit");
    assert.equal(middle.nextMemory.lowWaterSamples, 0, "夹层会打断低水位连续窗口");
    control = nextSnapshot(control, middle.nextMemory);
    const low = observe(control, { usedBytes: 64, totalBytes: 100 }, 20);
    assert.equal(low.memoryAimdLimitAfter, 4);
    const jitter = observe(nextSnapshot(control, low.nextMemory), { usedBytes: 66, totalBytes: 100 }, 30);
    assert.equal(jitter.reason, "middle_band");
    assert.equal(jitter.memoryAimdLimitAfter, 4, "阈值附近抖动不能带来恢复扩容");
}

{
    const control = snapshot();
    const transition = observe(control, () => {
        throw new Error("sampler unavailable");
    }, 10);
    assert.equal(transition.reason, "memory_sampling_failed");
    assert.equal(transition.memoryAimdLimitAfter, 0, "采样异常必须 fail closed 暂停新派发");
    assert.equal(transition.grant.permitNewGrant, false);
    assert.equal(transition.nextMemory.frozen?.reason, "memory_sampling_failed");
    assert.equal(transition.expectedControlRevision, control.controlRevision);
    assert.equal(transition.ownerEpoch, control.ownerEpoch);
    assert.match(transition.evidenceHash, /^fnv1a64:[0-9a-f]{16}$/u);
    assert.equal(transition.observedBytes, null);

    const frozenControl = nextSnapshot(control, transition.nextMemory);
    assert.throws(
        () => clearAgyMemoryWatermarkFreeze({ ...frozenControl, acknowledgement: "", frozenEvidenceHash: transition.evidenceHash }, { nowMonotonicMs: () => 11 }),
        AgyMemoryWatermarkEvidenceError,
        "人工解除必须附带文字 acknowledgement",
    );
    assert.throws(
        () => clearAgyMemoryWatermarkFreeze({ ...frozenControl, acknowledgement: "采样器已修复", frozenEvidenceHash: "other-evidence" }, { nowMonotonicMs: () => 11 }),
        AgyMemoryWatermarkEvidenceError,
        "人工解除必须引用冻结时保存的 evidence hash",
    );
    const cleared = clearAgyMemoryWatermarkFreeze({
        ...frozenControl,
        acknowledgement: "采样器已修复并由值班人员确认",
        frozenEvidenceHash: transition.evidenceHash,
    }, { nowMonotonicMs: () => 11 }).transition;
    assert.equal(cleared.reason, "manual_clear");
    assert.equal(cleared.nextMemory.frozen, null);
    assert.equal(cleared.memoryAimdLimitAfter, 0, "人工解除不擅自把内存上限恢复为默认值");
}

{
    const state = createInitialAgyMemoryWatermarkState(3);
    state.lastSampledAtMonotonicMs = 100;
    const transition = observe(snapshot({ memory: state }), { usedBytes: 50, totalBytes: 100 }, 99);
    assert.equal(transition.reason, "monotonic_time_reversed");
    assert.equal(transition.memoryAimdLimitAfter, 0);
    assert.equal(transition.nextMemory.frozen?.reason, "monotonic_time_reversed");
    assert.equal(transition.nextMemory.lastSampledAtMonotonicMs, 100, "倒退时钟不能覆盖已经持久化的最高单调时间");
}

{
    for (const sample of [
        { usedBytes: Number.POSITIVE_INFINITY, totalBytes: 100 },
        { usedBytes: Number.MAX_VALUE, totalBytes: Number.MAX_VALUE },
        { usedBytes: 1, totalBytes: 0 },
    ]) {
        const transition = observe(snapshot(), sample, 10);
        assert.equal(transition.memoryAimdLimitAfter, 0, "极端或无效字节数必须 fail closed");
        assert.equal(transition.grant.permitNewGrant, false);
        assert.equal(transition.nextMemory.frozen !== null, true);
    }
}

{
    const restartConfig: AgyMemoryWatermarkConfig = { ...config, lowWaterRecoverySamples: 2 };
    const pressured = observe(snapshot(), { usedBytes: 90, totalBytes: 100 }, 10, restartConfig);
    const restored = restoreAgyMemoryWatermarkState(pressured.nextMemory, 8);
    assert.equal(restored.memoryAimdLimit, 4, "重启必须从持久 memoryAimdLimit 恢复而非回到默认值");
    assert.equal(restored.lastSampledAtMonotonicMs, 10);
    let control = snapshot({ controlRevision: 42, memory: restored });
    const firstLow = observe(control, { usedBytes: 50, totalBytes: 100 }, 20, restartConfig);
    control = nextSnapshot(control, firstLow.nextMemory);
    const secondLow = observe(control, { usedBytes: 50, totalBytes: 100 }, 30, restartConfig);
    assert.equal(secondLow.memoryAimdLimitAfter, 5, "重启后仍按保存的水位状态逐步恢复");
}

{
    const control = snapshot({ currentLimit: 3, memory: createInitialAgyMemoryWatermarkState(6) });
    assert.equal(effectiveAgyMemoryWatermarkLimit(control), 3, "有效上限必须独立取 physical/current/memory 三者最小值");
    const transition = observe(control, { usedBytes: 75, totalBytes: 100 }, 10);
    assert.equal(transition.memoryAimdLimitAfter, 6, "夹层不得覆盖远端 currentLimit 或修改 memory limit");
    assert.equal(transition.effectiveLimitAfter, 3);
}

console.log("agy-memory-watermark tests passed");

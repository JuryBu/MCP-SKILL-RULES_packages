const ADMISSION_ERRORS = new Map([
    ["admission_timeout", "资源接纳等待超时"],
    ["admission_aborted", "资源接纳已取消"],
    ["admission_queue_full", "资源接纳队列已满"],
    ["reservation_exceeds_admission_limit", "有效请求超过配置的接纳额度"],
    ["reservation_exceeds_hard_limit", "有效请求超过服务内存保护上限"],
]);

const BLOCKING_REASONS = new Map([
    ["resource_recovery_pending", "服务恢复尚未完成，等待恢复完成"],
    ["recovery_pending", "服务恢复尚未完成，等待恢复完成"],
    ["missing_pressure_sample", "缺少完整内存采样，检查内存监测是否正常"],
    ["stale_pressure_sample", "内存采样已过期，等待新鲜采样"],
    ["windows_low_memory", "Windows 已报告低内存，等待系统压力缓解"],
    ["emergency_pressure", "内存余量触及紧急水位，等待余量回升"],
    ["heavy_request_yellow", "内存警戒区暂停大请求，可拆分任务或等待余量回升"],
    ["observed_hard_limit", "实测占用达到服务保护上限，等待在运行任务释放资源"],
    ["reservation_capacity", "并发预留额度不足，不等于物理内存耗尽"],
    ["physical_headroom", "预计接纳后的物理内存余量不足"],
    ["commit_headroom", "预计接纳后的系统提交余量不足"],
]);

const ADMISSION_MODES = new Map([
    ["watermark", "动态水位"],
    ["fixed", "固定额度"],
]);

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function amount(value: unknown, unit = "MB"): string {
    const number = finiteNumber(value);
    return number === undefined ? "未提供" : `${Math.round(number * 10) / 10}${unit}`;
}

export function formatAdmissionDiagnostic(value: unknown): string | null {
    const error = record(value);
    const errorType = typeof error.type === "string" ? error.type : "";
    const description = ADMISSION_ERRORS.get(errorType);
    if (!description || error.commandStarted === true || error.mayHaveStarted === true) return null;

    const decision = record(error.admissionDecision);
    const pressure = record(error.memoryPressure);
    const requestedMB = finiteNumber(decision.requestedMB ?? error.requestedMB);
    const reservedMB = finiteNumber(decision.reservedMB ?? error.reservedMB);
    const mode = typeof decision.admissionMode === "string" ? ADMISSION_MODES.get(decision.admissionMode) : undefined;
    const waitMs = finiteNumber(error.queueWaitMs);
    const blockingCodes = Array.isArray(decision.blockedBy) ? decision.blockedBy : [];
    const reasons = new Set<string>();
    for (const reason of blockingCodes) {
        const explanation = typeof reason === "string" ? BLOCKING_REASONS.get(reason) : undefined;
        reasons.add(explanation ? `${explanation}（${reason}）` : "未识别的接纳条件，请检查调度诊断");
    }
    if (errorType === "admission_queue_full") reasons.add("等待队列达到容量上限，等待队列消退");
    if (errorType.startsWith("reservation_exceeds_")) reasons.add(description);
    if (errorType === "admission_aborted") reasons.add("请求已取消，不代表内存不足");
    if (reasons.size === 0) reasons.add("未提供具体阻断条件，不能据此认定系统内存不足");

    const requestDetails = [
        `有效请求：${amount(reservedMB)}`,
        requestedMB === undefined ? null : `原始申请：${amount(requestedMB)}`,
        requestedMB !== undefined && reservedMB !== undefined && requestedMB !== reservedMB
            ? "服务端已调整申请量，以有效请求为准"
            : null,
        mode ? `接纳策略：${mode}` : null,
    ].filter(Boolean).join("；");
    const schedulingSnapshot = [
        `启动待观测预估 ${amount(decision.startupReservedMB)}`,
        `实测占用 ${amount(pressure.observedMemoryMB)}`,
        `等待任务保护预留 ${amount(decision.protectedReservationMB)}`,
    ];
    if (blockingCodes.includes("reservation_capacity") || errorType === "reservation_exceeds_admission_limit") {
        schedulingSnapshot.push(`已预留 ${amount(pressure.activeReservedMB)} / 接纳额度 ${amount(pressure.admissionLimitMB)}`);
    }
    if (blockingCodes.includes("observed_hard_limit") || errorType === "reservation_exceeds_hard_limit") {
        schedulingSnapshot.push(`服务保护上限 ${amount(pressure.hardLimitMB)}`);
    }
    const lines = [
        `❌ ${errorType}: 命令尚未启动；${description}${waitMs === undefined ? "" : `（已等待 ${amount(waitMs, "ms")}）`}。`,
        `${requestDetails}。`,
        `实际阻断：${[...reasons].join("；")}。`,
        `内存快照：物理可用 ${amount(pressure.systemAvailableMemoryMB)} → 接纳后预计 ${amount(decision.projectedPhysicalAvailableMB)}；系统提交余量 ${amount(pressure.commitAvailableMemoryMB)} → 接纳后预计 ${amount(decision.projectedCommitAvailableMB)}；采样年龄 ${amount(decision.pressureSampleAgeMs, "ms")}。`,
        `调度快照：${schedulingSnapshot.join("；")}。`,
    ];
    if (errorType === "admission_aborted") {
        lines.push("处理：不要自动重试已取消请求，也不要循环重发。");
    } else if (errorType.startsWith("reservation_exceeds_")) {
        lines.push("处理：核对有效请求与服务上限，拆分任务或请维护方检查配置；不要仅压低估计值绕过保护，也不要循环重发原请求。");
    } else {
        const retryAfterMs = finiteNumber(error.retryAfterMs);
        lines.push(retryAfterMs !== undefined && retryAfterMs > 0
            ? `处理：至少等待 ${amount(retryAfterMs, "ms")}，用 sandbox_status 查看资源状态，确认条件改善后最多重试一次；不要并发或循环重发。`
            : "处理：未给出可自动重试的间隔（0 不表示立即重试）；用 sandbox_status 查看资源状态，等待条件变化或请求维护，不要立即、并发或循环重发。");
    }
    return lines.join("\n");
}

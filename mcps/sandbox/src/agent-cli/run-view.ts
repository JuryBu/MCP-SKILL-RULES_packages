import { terminalSafeText } from './renderer.js';

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function runFailureLines(run: Record<string, unknown>): string[] {
    const failure = record(run.failure);
    if (!Object.keys(failure).length && !['failed', 'outcome_unknown'].includes(String(run.state))) return [];
    const error = record(failure.error);
    const message = typeof error.message === 'string' && error.message.trim() ? terminalSafeText(error.message) : '失败原因尚未提供';
    const acceptance = String(failure.acceptance ?? 'unknown');
    const transmission = acceptance === 'not_sent' ? '明确未发送到供应商'
        : acceptance === 'rejected' ? '供应商已拒绝本次请求'
        : acceptance === 'accepted' ? '供应商已受理，保留原回执核对结果'
        : '结果待核实，保留原回执';
    return [`执行未完成：${message}`, `请求状态：${transmission}`, '原输入与已接片段保留，未自动重新发送', '/status --json 查看技术码与完整状态'];
}

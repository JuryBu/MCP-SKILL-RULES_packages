import type { NormalizedUsage } from './usage.js';
import { tokenCount } from './usage.js';

export interface UsageMetric {
    value: number | null;
    status: 'known' | 'partial' | 'unknown';
    reportedRequests: number;
    missingRequests: number;
}

export function summarizeUsageField(usages: NormalizedUsage[], field: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens'): UsageMetric {
    let total = 0;
    let reported = 0;
    let complete = true;
    for (const usage of usages) {
        const count = tokenCount(usage[field]);
        if (count === null) { complete = false; continue; }
        total += count;
        reported++;
        if (usage.issues.includes('partial_stream_usage') || field === 'totalTokens' && usage.issues.includes('progrok_total_token_bucket_mismatch')
            || field === 'cacheReadTokens' && usage.issues.some(issue => ['cache_read_exceeds_input', 'input_bucket_mismatch'].includes(issue))) complete = false;
        if (!Number.isSafeInteger(total)) return { value: null, status: 'unknown', reportedRequests: reported, missingRequests: usages.length - reported };
    }
    return { value: reported ? total : null, status: !reported ? 'unknown' : complete ? 'known' : 'partial',
        reportedRequests: reported, missingRequests: usages.length - reported };
}

export function summarizeCacheRate(usages: NormalizedUsage[]): UsageMetric & { cachedTokens: number; inputTokens: number } {
    let cachedTokens = 0;
    let inputTokens = 0;
    let reported = 0;
    let complete = true;
    for (const usage of usages) {
        const cached = tokenCount(usage.cacheReadTokens);
        const input = tokenCount(usage.inputTokens);
        const writes = usage.inputIncludesCache ? 0 : tokenCount(usage.cacheWriteTokens);
        if (cached === null || input === null || writes === null) { complete = false; continue; }
        const denominator = input + (usage.inputIncludesCache ? 0 : cached + writes);
        if (!Number.isSafeInteger(denominator) || cached > denominator) { complete = false; continue; }
        cachedTokens += cached;
        inputTokens += denominator;
        reported++;
        if (usage.issues.some(issue => ['partial_stream_usage', 'cache_read_exceeds_input', 'input_bucket_mismatch'].includes(issue))) complete = false;
    }
    const safe = Number.isSafeInteger(cachedTokens) && Number.isSafeInteger(inputTokens);
    return { value: safe && reported && inputTokens > 0 ? cachedTokens / inputTokens : null,
        status: !safe || !reported || inputTokens === 0 ? 'unknown' : complete ? 'known' : 'partial',
        reportedRequests: reported, missingRequests: usages.length - reported, cachedTokens, inputTokens };
}

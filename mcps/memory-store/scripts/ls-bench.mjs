// LS model benchmark - test all available Antigravity M-models
// Runs from memory-store directory, imports compiled dist
// Optional env:
//   MEMORY_STORE_LS_BENCH_MODELS comma-separated LS model list
//   MEMORY_STORE_LS_BENCH_CONCURRENCY_MODEL model used by concurrency probes

import { callGetModelResponseDetailed, isLsAvailable } from '../dist/ls-client.js';

const DEFAULT_MODELS = [
    'MODEL_PLACEHOLDER_M132',
    'MODEL_PLACEHOLDER_M20',
    'MODEL_PLACEHOLDER_M18',
    'MODEL_PLACEHOLDER_M16',
    'MODEL_PLACEHOLDER_M36',
];

function parseCsvList(value, fallback) {
    const items = (value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    return items.length > 0 ? items : fallback;
}

const models = parseCsvList(process.env.MEMORY_STORE_LS_BENCH_MODELS, DEFAULT_MODELS);
const concurrencyModel = process.env.MEMORY_STORE_LS_BENCH_CONCURRENCY_MODEL?.trim() || models[0] || 'MODEL_PLACEHOLDER_M132';

const lightPrompt = 'MCP memory-store v1.18.0 Grok 模型链路集成。auto 模型路由优先探测本机 progrok proxy，失败后 fallback 到 Antigravity LS、Codex 模型桥或允许的 Claude Code CLI。Record、Stage Guard 和 smart search 会按任务选择不同 Grok 模型，并保留实际模型链路证据。请为以上内容生成50-100字搜索优化摘要含关键词，直接输出不要前缀。';

const heavyPrompt = '你是对话记录生成器。生成结构化过程日志Markdown，包含阶段标题用户操作AI行动决策产出验证风险。对话摘要：用户为 MCP memory-store 集成 Grok/progrok 模型链路，实现 chain=grok 模型快捷写法、Grok HTTP client、auto fallback、Record 大上下文预算、checkpoint/cache 隔离、schema/README 更新，并通过单元测试和真实 MCP smoke。只输出Markdown。';

async function callLs(model, prompt, timeoutMs = 60000) {
    const t0 = Date.now();
    try {
        const result = await callGetModelResponseDetailed(model, prompt, timeoutMs);
        const elapsed = Date.now() - t0;
        return {
            elapsed, ok: !!result.text, content: result.text || '',
            error: result.error || '', timedOut: result.timedOut,
        };
    } catch (e) {
        return { elapsed: Date.now() - t0, ok: false, content: '', error: e.message, timedOut: false };
    }
}

// Check LS availability
console.log('=== LS Availability ===');
const lsReady = await isLsAvailable();
console.log('LS available:', lsReady);
if (!lsReady) {
    console.log('LS not available, cannot benchmark.');
    process.exit(1);
}

// Light prompt - sequential 3 runs per model
console.log('\n=== Prompt 1: autoSummary (5 models x 3 runs, sequential) ===\n');
const lightResults = [];
for (const model of models) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
        runs.push(await callLs(model, lightPrompt, 45000));
    }
    const lats = runs.map(r => r.elapsed).sort((a, b) => a - b);
    const ok = runs.filter(r => r.ok).length;
    const sample = runs.find(r => r.ok);
    const med = lats[1];
    const st = ok === 3 ? 'OK' : ok > 0 ? 'PART' : 'FAIL';
    console.log(`${model.padEnd(25)} med=${String(med).padStart(6)}ms ok=${ok}/3 len=${sample?.content?.length || 0} [${st}]`);
    lightResults.push({ model, median: med, ok, content: sample?.content || 'all failed', error: runs[0].error });
}

// Heavy prompt - sequential 3 runs per model
console.log('\n=== Prompt 2: Record gen (5 models x 3 runs, sequential) ===\n');
const heavyResults = [];
for (const model of models) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
        runs.push(await callLs(model, heavyPrompt, 120000));
    }
    const lats = runs.map(r => r.elapsed).sort((a, b) => a - b);
    const ok = runs.filter(r => r.ok).length;
    const sample = runs.find(r => r.ok);
    const med = lats[1];
    const st = ok === 3 ? 'OK' : ok > 0 ? 'PART' : 'FAIL';
    console.log(`${model.padEnd(25)} med=${String(med).padStart(6)}ms ok=${ok}/3 len=${sample?.content?.length || 0} [${st}]`);
    heavyResults.push({ model, median: med, ok, content: sample?.content || 'all failed', error: runs[0].error });
}

// Concurrency test - 5 concurrent calls with selected model
console.log(`\n=== Concurrency: 5x ${concurrencyModel} light prompt ===\n`);
const concurrentStart = Date.now();
const concurrentResults = await Promise.all([
    callLs(concurrencyModel, lightPrompt, 45000),
    callLs(concurrencyModel, lightPrompt, 45000),
    callLs(concurrencyModel, lightPrompt, 45000),
    callLs(concurrencyModel, lightPrompt, 45000),
    callLs(concurrencyModel, lightPrompt, 45000),
]);
const concurrentWall = Date.now() - concurrentStart;
const concurrentOk = concurrentResults.filter(r => r.ok).length;
const concurrentLats = concurrentResults.map(r => r.elapsed).sort((a, b) => a - b);
console.log(`5x concurrent: wall=${concurrentWall}ms ok=${concurrentOk}/5 individual=${concurrentLats.join(',')}ms`);

// Concurrency test - 10 concurrent
console.log(`\n=== Concurrency: 10x ${concurrencyModel} light prompt ===\n`);
const c10Start = Date.now();
const c10Results = await Promise.all(Array.from({ length: 10 }, () => callLs(concurrencyModel, lightPrompt, 45000)));
const c10Wall = Date.now() - c10Start;
const c10Ok = c10Results.filter(r => r.ok).length;
const c10Lats = c10Results.map(r => r.elapsed).sort((a, b) => a - b);
console.log(`10x concurrent: wall=${c10Wall}ms ok=${c10Ok}/10 individual=${c10Lats.join(',')}ms`);

// Summary
console.log('\n=== SUMMARY (sorted by light median) ===\n');
console.log('Model                    Light median  Heavy median  Stability  Light len  Heavy len');
console.log('------------------------- ------------- ------------- ---------- ---------- ----------');
const sorted = [...lightResults].sort((a, b) => a.median - b.median);
for (const r of sorted) {
    const h = heavyResults.find(x => x.model === r.model);
    const lStr = `${r.median}ms (${r.ok}/3)`;
    const hStr = h ? `${h.median}ms (${h.ok}/3)` : 'N/A';
    const stable = (r.ok === 3 && h?.ok === 3) ? 'STABLE' : (r.ok > 0 || h?.ok > 0) ? 'PARTIAL' : 'FAILED';
    const lLen = r.content?.length || 0;
    const hLen = h?.content?.length || 0;
    console.log(`${r.model.padEnd(25)} ${lStr.padEnd(13)} ${hStr.padEnd(13)} ${stable.padEnd(10)} ${String(lLen).padEnd(10)} ${hLen}`);
}

// Quality samples - Light
console.log('\n=== QUALITY: autoSummary (first 300 chars) ===\n');
for (const r of lightResults) {
    console.log(`--- ${r.model} (${r.median}ms) ---`);
    if (r.content && r.content !== 'all failed') {
        console.log(r.content.slice(0, 300));
    } else {
        console.log(`FAILED: ${r.error}`);
    }
    console.log();
}

// Quality samples - Heavy
console.log('\n=== QUALITY: Record gen (first 400 chars) ===\n');
for (const r of heavyResults) {
    console.log(`--- ${r.model} (${r.median}ms) ---`);
    if (r.content && r.content !== 'all failed') {
        console.log(r.content.slice(0, 400));
    } else {
        console.log(`FAILED: ${r.error}`);
    }
    console.log();
}

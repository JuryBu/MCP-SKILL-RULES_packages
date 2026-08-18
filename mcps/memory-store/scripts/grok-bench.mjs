// Grok model benchmark for memory-store
// Usage: node scripts/grok-bench.mjs
// Optional env:
//   MEMORY_STORE_GROK_PROXY_URL   default http://127.0.0.1:18645
//   MEMORY_STORE_GROK_API_KEY     default grok-local-proxy
//   MEMORY_STORE_GROK_BENCH_MODELS comma-separated model list

const PROXY = process.env.MEMORY_STORE_GROK_PROXY_URL || 'http://127.0.0.1:18645';
const KEY = process.env.MEMORY_STORE_GROK_API_KEY || 'grok-local-proxy';

const DEFAULT_MODELS = [
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-0309-reasoning',
  'grok-4.20-multi-agent-0309',
  'grok-4.3',
  'grok-4.5',
  'grok-build-0.1',
];

function parseCsvList(value, fallback) {
  const items = (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

const models = parseCsvList(process.env.MEMORY_STORE_GROK_BENCH_MODELS, DEFAULT_MODELS);

const promptLight = `为以下技术笔记生成搜索优化摘要（50-100字，含关键词）：

MCP memory-store v1.18.0 Grok 模型链路集成。auto 模型路由优先探测本机 progrok proxy，失败后 fallback 到 Antigravity LS、Codex 模型桥或允许的 Claude Code CLI。Record、Stage Guard 和 smart search 会按任务选择不同 Grok 模型，并保留实际模型链路证据。

直接输出摘要，不要前缀。`;

const promptHeavy = `你是对话记录生成器。生成结构化过程日志（Markdown），包含：阶段标题、用户操作、AI行动、决策、产出、验证、风险。

对话摘要：用户为 MCP memory-store 集成 Grok/progrok 模型链路。实现 chain="grok" 模型快捷写法、Grok HTTP client、auto fallback、Record 大上下文预算、checkpoint/cache 隔离、schema/README 更新，并通过单元测试和真实 MCP smoke。

只输出 Markdown。`;

async function callGrok(model, prompt, timeoutMs = 60000) {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${PROXY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = Date.now() - t0;
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { elapsed, ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 80)}`, content: '', tokens: 0 };
    }
    const data = await resp.json();
    return {
      elapsed, ok: true,
      content: data.choices?.[0]?.message?.content || '',
      tokens: data.usage?.completion_tokens || 0,
      error: '',
    };
  } catch (e) {
    return { elapsed: Date.now() - t0, ok: false, error: e.message, content: '', tokens: 0 };
  }
}

async function bench3(model, prompt, label) {
  // Sequential 3 calls to avoid concurrent rate limits affecting latency
  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push(await callGrok(model, prompt));
  }
  const lats = runs.map(r => r.elapsed).sort((a, b) => a - b);
  const ok = runs.filter(r => r.ok).length;
  const sample = runs.find(r => r.ok);
  return {
    model, label, ok, median: lats[1], min: lats[0], max: lats[2],
    tokens: sample?.tokens || 0,
    contentLen: sample?.content?.length || 0,
    content: sample?.content || runs[0].error || 'all failed',
  };
}

// === Light prompt ===
console.log('=== Prompt 1: autoSummary (light, 6 models x 3 runs) ===\n');
const lightResults = [];
for (const model of models) {
  const r = await bench3(model, promptLight, 'autoSummary');
  lightResults.push(r);
  const status = r.ok === 3 ? '✅' : r.ok > 0 ? '⚠️' : '❌';
  console.log(`${status} ${model.padEnd(35)} med=${String(r.median).padStart(6)}ms  ok=${r.ok}/3  tok=${r.tokens}  len=${r.contentLen}`);
}

// === Heavy prompt ===
console.log('\n=== Prompt 2: Record generation (heavy, 6 models x 3 runs) ===\n');
const heavyResults = [];
for (const model of models) {
  const r = await bench3(model, promptHeavy, 'record-gen');
  heavyResults.push(r);
  const status = r.ok === 3 ? '✅' : r.ok > 0 ? '⚠️' : '❌';
  console.log(`${status} ${model.padEnd(35)} med=${String(r.median).padStart(6)}ms  ok=${r.ok}/3  tok=${r.tokens}  len=${r.contentLen}`);
}

// === Summary table ===
console.log('\n\n=== SUMMARY (sorted by median latency) ===\n');
console.log('Model                             | Light median | Heavy median | Stability | Light tok | Heavy tok');
console.log('----------------------------------|--------------|--------------|-----------|-----------|----------');
const sorted = [...models].sort((a, b) => {
  const aMed = lightResults.find(r => r.model === a)?.median || 999999;
  const bMed = lightResults.find(r => r.model === b)?.median || 999999;
  return aMed - bMed;
});
for (const model of sorted) {
  const l = lightResults.find(r => r.model === model);
  const h = heavyResults.find(r => r.model === model);
  const lStr = l ? `${l.median}ms (${l.ok}/3)` : 'N/A';
  const hStr = h ? `${h.median}ms (${h.ok}/3)` : 'N/A';
  const stable = (l?.ok === 3 && h?.ok === 3) ? '✅' : (l?.ok > 0 || h?.ok > 0) ? '⚠️' : '❌';
  const lTok = l?.tokens || 0;
  const hTok = h?.tokens || 0;
  console.log(`${model.padEnd(34)}| ${lStr.padEnd(13)}| ${hStr.padEnd(13)}| ${stable.padEnd(10)}| ${String(lTok).padEnd(10)}| ${hTok}`);
}

// === Quality samples ===
console.log('\n=== QUALITY: autoSummary (full output per model) ===\n');
for (const r of lightResults) {
  console.log(`--- ${r.model} (${r.median}ms, ${r.tokens}tok) ---`);
  console.log(r.content.slice(0, 500));
  console.log();
}

console.log('\n=== QUALITY: Record gen (first 500 chars per model) ===\n');
for (const r of heavyResults) {
  console.log(`--- ${r.model} (${r.median}ms, ${r.tokens}tok) ---`);
  console.log(r.content.slice(0, 500));
  console.log();
}

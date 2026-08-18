// agy CLI 并发测试 — 测 agy 能同时处理多少个请求
import { spawn } from 'child_process';
import { performance } from 'perf_hooks';

const AGY_CMD = process.env.MEMORY_STORE_AGY_COMMAND || 'agy';
const MODEL = 'Gemini 3.5 Flash (High)';
const PROMPT = 'What is 17 times 23? Answer with just the number.';

function runAgyOnce() {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const proc = spawn(AGY_CMD, [
            '-p', PROMPT,
            '--dangerously-skip-permissions',
            '--model', MODEL,
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60000,
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            const elapsed = Math.round(performance.now() - start);
            if (code === 0) {
                resolve({ success: true, elapsed, output: stdout.trim().slice(0, 200) });
            } else {
                resolve({ success: false, elapsed, code, error: stderr.trim().slice(0, 300) });
            }
        });
        proc.on('error', (err) => {
            const elapsed = Math.round(performance.now() - start);
            resolve({ success: false, elapsed, error: err.message });
        });
    });
}

async function testConcurrency(n) {
    console.log(`\n=== 并发 ${n} ===`);
    const promises = Array.from({ length: n }, () => runAgyOnce());
    const results = await Promise.all(promises);
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const elapsed = results.map(r => r.elapsed).sort((a, b) => a - b);
    const median = elapsed[Math.floor(elapsed.length / 2)];
    console.log(`成功 ${success} / 失败 ${failed} / 中位延迟 ${median}ms`);
    if (failed > 0) {
        const failures = results.filter(r => !r.success);
        failures.slice(0, 2).forEach(f => {
            console.log(`  失败: code=${f.code}, error=${f.error?.slice(0, 150)}`);
        });
    }
    return { concurrency: n, success, failed, median };
}

async function main() {
    console.log('agy CLI 并发测试');
    console.log(`命令: ${AGY_CMD}`);
    console.log(`模型: ${MODEL}`);
    console.log(`Prompt: ${PROMPT}`);

    const levels = [1, 2, 3, 4, 6, 8];
    const results = [];
    for (const n of levels) {
        const r = await testConcurrency(n);
        results.push(r);
        // 每级之间等 2 秒冷却
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('\n=== 汇总 ===');
    console.log('并发\t成功\t失败\t中位延迟(ms)');
    for (const r of results) {
        console.log(`${r.concurrency}\t${r.success}\t${r.failed}\t${r.median}`);
    }
}

main().catch(console.error);

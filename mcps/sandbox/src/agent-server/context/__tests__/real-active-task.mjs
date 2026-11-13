import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [configurationPath, mode = 'prepare'] = process.argv.slice(2);
if (!configurationPath || !['prepare', 'run', 'check'].includes(mode)) {
    process.stdout.write('Usage: node real-active-task.mjs <approved-config.json> [prepare|run|check]\n');
    process.exit(configurationPath ? 2 : 0);
}
const config = JSON.parse(await readFile(resolve(configurationPath), 'utf8'));
for (const field of ['dataDir', 'workdir', 'profileId', 'modelId', 'callerConversationId']) {
    if (typeof config[field] !== 'string' || !config[field]) throw new Error(`Missing approved ${field}`);
}
if (Object.keys(config).some(field => /secret|api.?key|token|credential/i.test(field))) throw new Error('Use existing protected Profile references only');
if (!config.contextPolicy || !Object.hasOwn(config.contextPolicy, 'localContextWindowTokens')
    || config.contextPolicy.localContextWindowTokens !== null && (!Number.isSafeInteger(config.contextPolicy.localContextWindowTokens)
        || config.contextPolicy.localContextWindowTokens < 2048)) throw new Error('Supply the unchanged original local window explicitly; null keeps the original provider window');
const budget = config.budget;
if (!budget || !budget.quotaLimitId || !['hard', 'estimated'].includes(budget.costMode)
    || !['maxCostMicros', 'maxModelCalls', 'maxOutputTokens', 'wallMs'].every(field => Number.isSafeInteger(budget[field]) && budget[field] > 0)) {
    throw new Error('The main caller must supply its finite approved budget and existing quotaLimitId');
}
const workdir = resolve(config.workdir);
const sourceCount = config.sourceCount ?? 12;
if (!Number.isSafeInteger(sourceCount) || sourceCount < 6 || sourceCount > 32) throw new Error('sourceCount must be 6..32');
const runtimeRoot = resolve(config.runtimeRoot ?? fileURLToPath(new URL('../../../../', import.meta.url)));
const evidence = join(workdir, 'active-task-evidence');
await mkdir(evidence, { recursive: true });
const statePath = join(evidence, 'state.json');
const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (state && state.configHash !== configHash) throw new Error('Existing run belongs to another frozen configuration');
state ??= { schemaVersion: 1, configHash, clientId: `active-task-${randomUUID()}`, createCommandId: randomUUID(), startCommandId: randomUUID(),
    createdAt: new Date().toISOString(), userTaskStartsSubmittedByScript: 0 };
const save = () => writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
await save();
const sources = Array.from({ length: sourceCount }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    const marker = `OBSERVATION_${number}_${createHash('sha256').update(`synthetic-observation-${number}`).digest('hex').slice(0, 16)}`;
    const detail = Array.from({ length: 32 }, (_, row) => `合成观测${number}，记录${row + 1}：对比曝光、天气和设备状态，保留实测过程与尚待复核的信息。`).join('\n');
    return { name: `source-${number}.txt`, marker, text: `合成观测资料${number}\n必需标记：${marker}\n${detail}\n结尾核对标记：${marker}\n` };
});
if (mode === 'prepare' || mode === 'run' && !state.conversationId) {
    for (const source of sources) {
        const path = join(workdir, source.name);
        try { if (await readFile(path, 'utf8') !== source.text) throw new Error(`Existing source differs: ${source.name}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(path, source.text, { encoding: 'utf8', flag: 'wx' }); }
    }
}
const prompt = [
    '完成一份合成观测资料的综合报告，这是一个持续的多步骤用户任务。',
    `批准工作区为${workdir}，按编号依次处理${sources.map(source => source.name).join('、')}。`,
    '先建立当前任务的Task/Plan。每次只读取下一份来源，读完后立即将该来源的必需标记、主要事实、复核结果写入working.md，再继续下一份；不要在一次工具响应里预先读取后面的多份文件。',
    '每份资料都要实际读取并记录，保留来源顺序。发生自动上下文压缩后，沿原Task/Plan、working.md和历史继续剩余来源，已完成写入保持一次。',
    '全部处理完后创建report.md，说明相同点、差异与仍需复核的内容，并读回核对。',
    `最后创建result.json，结构为{"completed":true,"sourceCount":${sourceCount},"facts":[{"source":"source-01.txt","marker":"从该来源实际读取的标记"},...] }，每份来源恰好出现一次。`,
    '读回result.json和report.md，核对每个标记，实际完成后更新Task/Plan并返回产物路径。',
].join('\n');
await writeFile(join(evidence, 'single-user-input.txt'), prompt, 'utf8');
if (mode === 'prepare') {
    process.stdout.write(JSON.stringify({ prepared: true, statePath, workdir, sourceCount, submittedModelRequests: 0 }) + '\n');
    process.exit(0);
}
const { AgentClient } = await import(pathToFileURL(join(runtimeRoot, 'dist/agent-client/index.js')).href);
const client = await AgentClient.connect({ dataDir: resolve(config.dataDir), clientId: state.clientId,
    clientName: 'single-active-user-task-acceptance', requestTimeoutMs: 15000 });
const rpc = async (method, params = {}, commandId) => {
    const response = await client.request(method, params, commandId ? { clientCommandId: commandId } : {});
    if (!response.ok) {
        state.lastFailure = { method, error: response.error, commandId: commandId ?? null, observedAt: new Date().toISOString() };
        await save();
        throw new Error(JSON.stringify(state.lastFailure));
    }
    return response.data;
};
try {
    const core = await rpc('server.info');
    state.coreBefore ??= core;
    await save();
    if (!state.conversationId) {
        if (mode === 'check') throw new Error('No existing conversation to inspect');
        const created = await rpc('conversations.create', { retention: { mode: 'archive' }, callerHost: 'codex', callerConversationId: config.callerConversationId, options: {
            profileId: config.profileId, modelId: config.modelId, writeRoots: [workdir], allowSubagents: false,
            contextPolicy: config.contextPolicy, ...(config.parameters ? { parameters: config.parameters } : {}),
            tools: ['read_file', 'write_file', 'patch_file', 'task_plan_read', 'task_plan_write', 'history_read', 'history_search', 'mark_history_hit'],
        } }, state.createCommandId);
        state.conversationId = created.conversationId;
        await save();
    }
    if (!state.runId && mode === 'run') {
        if (state.startSubmittedAt) {
            state.startReceipt = await rpc('server.getReceipt', { conversationId: state.conversationId, targetClientCommandId: state.startCommandId });
            await save();
            throw new Error('Original start has an unresolved receipt; do not submit another paid command');
        }
        state.startSubmittedAt = new Date().toISOString();
        await save();
        const started = await rpc('runs.start', { conversationId: state.conversationId, input: { text: prompt }, budget }, state.startCommandId);
        state.runId = started.runId;
        state.runEpoch = started.runEpoch;
        state.userTaskStartsSubmittedByScript = 1;
        await save();
    }
    if (!state.runId) throw new Error('No original runId is available');
    const deadline = Date.now() + budget.wallMs + 15000;
    do {
        state.run = await rpc('runs.get', { conversationId: state.conversationId, runId: state.runId });
        state.context = await rpc('conversations.context', { conversationId: state.conversationId });
        await appendFile(join(evidence, 'progress.jsonl'), JSON.stringify({ observedAt: new Date().toISOString(), runId: state.runId,
            state: state.run.state, phase: state.run.phase, context: state.context }) + '\n', 'utf8');
        await save();
        if (mode === 'check' || ['succeeded', 'failed', 'cancelled', 'outcome_unknown', 'paused'].includes(state.run.state)) break;
        await delay(1000);
    } while (Date.now() < deadline);
    const history = [];
    let cursor;
    for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
        const page = await rpc('conversations.readHistory', { conversationId: state.conversationId, ...(cursor ? { cursor } : {}), limit: 100, maxBytes: 262144 });
        history.push(...page.items.map(item => ({ itemId: item.itemId, seq: item.seq, role: item.role, roundId: item.roundId,
            stepId: item.stepId, contentId: item.contentId, objectRef: item.objectRef })));
        if (!page.hasMore) break;
        if (!page.nextCursor || page.nextCursor === cursor) throw new Error('Original history pagination did not advance');
        cursor = page.nextCursor;
        if (pageNumber === 199) throw new Error('Original history exceeds this bounded inspection');
    }
    state.history = history;
    const inputs = history.filter(item => item.role === 'user');
    let product;
    try { product = JSON.parse(await readFile(join(workdir, 'result.json'), 'utf8')); }
    catch (error) { state.productReadFailure = { code: error.code ?? error.name, message: error.message }; }
    const facts = Array.isArray(product?.facts) ? product.facts : [];
    const report = await readFile(join(workdir, 'report.md'), 'utf8').catch(() => '');
    const beforeIdentity = state.coreBefore.serverInstanceId ?? state.coreBefore.pid;
    const currentIdentity = core.serverInstanceId ?? core.pid;
    state.checks = { succeeded: state.run.state === 'succeeded', singleUserInput: inputs.length === 1,
        sameUserRound: new Set(history.map(item => item.roundId).filter(Boolean)).size === 1,
        automaticallyCompacted: Number(state.context.history?.coveredEndSeq) > 0,
        continuedProduct: product?.completed === true && product.sourceCount === sourceCount && facts.length === sourceCount
            && sources.every(source => facts.filter(fact => fact.source === source.name && fact.marker === source.marker).length === 1) && report.trim().length > 0,
        coldCoreReopened: Boolean(beforeIdentity && currentIdentity && beforeIdentity !== currentIdentity),
        originalStartCommandId: state.startCommandId, originalRunId: state.runId };
    state.checkedAt = new Date().toISOString();
    await save();
    process.stdout.write(JSON.stringify({ statePath, conversationId: state.conversationId, runId: state.runId, checks: state.checks }) + '\n');
    if (!state.checks.succeeded || !state.checks.singleUserInput || !state.checks.sameUserRound
        || !state.checks.automaticallyCompacted || !state.checks.continuedProduct) process.exitCode = 1;
} finally {
    await client.close();
}

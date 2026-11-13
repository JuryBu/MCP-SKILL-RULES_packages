import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { createToolDeliveryStore } from '../../../src/agent-server/context/tool-delivery.ts';
import { executeToolFixture } from './tools-execution-fixture-20261113.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('one executor task writes real Task/Plan, runs a long ordinary command, recalls originals, marks history and closes the verified plan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-integrated-tools-'));
    const store = new MemoryStore();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const roundId = randomUUID();
    const marker = 'TOOLS_UPGRADE_ORIGINAL_20261113';
    const key = { conversationId, kind: 'conversation', id: conversationId };
    await store.commitTransition({ expected: [{ key, revision: null }], records: [{ key, revision: 1, value: {
        conversationId, principalId: 'tools-execution-unit', state: 'open', retention: { mode: 'temporary', lastRunEnd: null,
            lastClose: null, expiresAt: null, activeRuns: 1 }, options: {}, historyEpoch: 1, appendSeq: 0, viewRevision: 1,
        workspaceRevision: 0, runEpoch: 1, activeRunId: runId, eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }], contents: [{ conversationId,
        contentId: randomUUID(), kind: 'input', value: { text: `先建立计划，再核对长输出和历史口令${marker}，最后更新真实文件。` },
        indexHistory: true, history: { view: 'raw', effective: true, role: 'user', roundId, runId, runEpoch: 1 } }] });
    const hits = [];
    const deliveries = [];
    const port = { readHistory: query => store.readHistory(query), readArtifact: query => store.readArtifact(query),
        inspect: async () => {
            const page = await store.readHistory({ conversationId, includeValues: false, limit: 200, maxBytes: 262144 });
            return { conversationId, historyEpoch: 1, appendSeq: page.appendSeq, viewRevision: 1, workspaceRevision: 0,
                rounds: [{ roundId, roundNumber: 1, itemIds: page.items.map(item => item.itemId), complete: true,
                    firstSeq: page.items[0]?.seq ?? 1, lastSeq: page.appendSeq, lastStepSeq: page.appendSeq, nativePairing: 'complete' }],
                view: { revision: 1, historyEpoch: 1, coveredEndSeq: page.appendSeq, nodes: [] } };
        }, markHit: async hit => {
            const hitKey = { conversationId, kind: 'step', id: `useful-hit:${hit.hitId}` };
            await store.commitTransition({ expected: [{ key: hitKey, revision: null }], records: [{ key: hitKey, revision: 1, value: hit }] });
            hits.push(hit);
            return { accepted: true, count: hits.length };
        } };
    const router = new ToolRouter({ history: port });
    const deliveryStore = createToolDeliveryStore(store);
    const initialTask = '# Task\n- [ ] 核对长输出与历史\n';
    const initialPlan = '# Plan\n建立原件 → 执行普通命令 → 查回并标记有用命中 → 读回验收\n';
    const finalTask = '# Task\n- [x] 长输出原件已完整查回，历史口令已读取并记录有用命中\n';
    const finalPlan = '# Plan\n全部步骤已按真实工具回执和原件读回验证\n';
    const commandText = `${marker}\n${'L'.repeat(50000)}\nTAIL-OK`;
    const toolSteps = steps => steps.filter(step => step.kind === 'tool');
    const latestArtifact = steps => toolSteps(steps).filter(step => step.result.name === 'history_read'
        && step.result.result.data?.artifactId === deliveries.find(delivery => delivery.sent.name === 'run_command')?.source.artifactId).at(-1)?.result.result.data;
    try {
        const result = await executeToolFixture({ router, roots: [root], trustedOverrides: {
            conversationId, runId, rootRunId: runId, roundId, taskPlanWorkKind: 'multi_step', retention: { mode: 'temporary' } },
            script: [
                [{ name: 'task_plan_write', args: { document: 'task', text: initialTask, expectedSha256: null } },
                    { name: 'task_plan_write', args: { document: 'plan', text: initialPlan, expectedSha256: null } }],
                [{ name: 'run_command', args: { application: process.execPath,
                    args: ['-e', `process.stdout.write(${JSON.stringify(marker)}+'\\n'+'L'.repeat(50000)+'\\nTAIL-OK')`],
                    cwd: root, timeoutMs: 10000, maxMemoryMB: 256, maxOutputBytes: 262144 } }],
                [{ name: 'history_search', args: { query: marker, scanBytes: 131072, maxBytes: 65536 } }],
                [{ name: 'history_read', args: { startRound: 1, endRound: 1, limit: 1, maxBytes: 65536 } }],
                [{ name: 'mark_history_hit', args: { roundHit: 1 } }],
                ...Array.from({ length: 4 }, () => ({ steps }) => {
                    const source = deliveries.find(delivery => delivery.sent.name === 'run_command').source;
                    const previous = latestArtifact(steps);
                    return previous?.complete ? [{ name: 'task_plan_read' }] : [{ name: 'history_read', args: {
                        artifactId: source.artifactId, offset: previous?.nextOffset ?? 0, maxBytes: 262144 } }];
                }),
                [{ name: 'task_plan_write', args: { document: 'task', text: finalTask, expectedSha256: hash(initialTask) } },
                    { name: 'task_plan_write', args: { document: 'plan', text: finalPlan, expectedSha256: hash(initialPlan) } }],
                [{ name: 'task_plan_read' }],
            ],
            transformToolResult: async (context, plan, received, identity) => {
                const delivery = await deliveryStore.preserve({ conversationId, runId, runEpoch: 1,
                    stepId: identity.stepId, callId: received.callId }, received, received.name === 'run_command' ? {
                    kind: 'log', maxTextChars: 512, upstreamCompleteness: 'complete' } : {});
                deliveries.push(delivery);
                return delivery.sent;
            },
            onStep: async step => {
                await store.commitTransition({ expected: [], records: [], contents: [{ conversationId, contentId: randomUUID(),
                    kind: step.kind, value: step.kind === 'tool' ? step.result : step.response, indexHistory: true,
                    history: { view: 'raw', effective: true, role: step.kind === 'tool' ? 'tool' : 'assistant', roundId,
                        stepId: step.stepId, runId, runEpoch: 1 } }] });
            } });
        assert.equal(result.outcome.status, 'succeeded', JSON.stringify(result.outcome));
        const tools = toolSteps(result.steps);
        for (const step of tools) assert.equal(step.result.result.ok, true, JSON.stringify(step.result));
        const longDelivery = deliveries.find(delivery => delivery.sent.name === 'run_command');
        assert.equal(longDelivery.shortened, true);
        assert.equal(longDelivery.source.upstreamCompleteness, 'complete');
        const fragments = tools.filter(step => step.result.name === 'history_read'
            && step.result.result.data?.artifactId === longDelivery.source.artifactId).map(step => step.result.result.data);
        assert.ok(fragments.length > 1);
        assert.equal(fragments.at(-1).complete, true);
        const reconstructed = Buffer.concat(fragments.map(fragment => Buffer.from(fragment.dataBase64, 'base64')));
        assert.equal(hash(reconstructed), longDelivery.source.sha256);
        const original = JSON.parse(reconstructed.toString('utf8'));
        assert.equal(original.result.data.stdout, commandText);
        assert.equal(original.result.data.cleanupState, 'released');
        assert.equal(original.result.data.outputDecoding.stdout.status, 'valid');
        assert.ok(tools.find(step => step.result.name === 'history_search').result.result.data.items.length > 0);
        assert.equal(hits.length, 1);
        const finalSnapshot = tools.at(-1).result.result.data;
        assert.equal(finalSnapshot.planRequired, true);
        assert.equal(finalSnapshot.task.text, finalTask);
        assert.equal(finalSnapshot.plan.text, finalPlan);
        assert.equal(await readFile(path.join(root, finalSnapshot.task.path), 'utf8'), finalTask);
        const reopened = new ToolRouter();
        const reloaded = await reopened.readTaskPlan(result.trusted);
        assert.equal(reloaded.task.sha256, finalSnapshot.task.sha256);
        assert.equal(reloaded.plan.sha256, finalSnapshot.plan.sha256);
        await reopened.cleanup(result.trusted);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { createProviderExecutor } from '../../../src/agent-server/execution.ts';
import { CompatibleChatAdapter, normalizeChatResponse } from '../../../src/agent-server/providers/compatible-chat.ts';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';

export async function executeToolFixture({ script, router = new ToolRouter(), toolNames = null,
    roots = [os.tmpdir()], controller = new AbortController(), execute, afterRequest, trustedOverrides = {}, captureFailure = false,
    transformToolResult, onStep }) {
    const runId = randomUUID();
    const trusted = { principalId: 'tools-execution-unit', conversationId: randomUUID(), runId, rootRunId: runId,
        runEpoch: 1, policyRevision: 1, roots, retention: { mode: 'archive' }, signal: controller.signal, ...trustedOverrides };
    const steps = [];
    const requests = [];
    const adapter = new CompatibleChatAdapter();
    const plan = { profile: { profileId: 'unit-profile', revision: 1 }, adapter, modelId: 'unit-model', rootBudgetId: runId,
        deadlineAt: new Date(Date.now() + 30000).toISOString(), parameters: {}, catalogVersion: 'unit', capabilityVersion: 'unit',
        priceVersion: null, maxModelCalls: script.length + 1, maxOutputTokens: 256, toolNames };
    const context = { snapshot: { conversationId: trusted.conversationId, runId: trusted.runId, rootRunId: trusted.rootRunId, runEpoch: 1,
        activeRoundId: trusted.roundId ?? randomUUID(), workspaceRevision: 0 }, conversationOptions: {}, signal: controller.signal,
        checkpoint: async () => {}, takeSteering: async () => {},
        recordStep: async step => { steps.push(structuredClone(step)); await onStep?.(step, trusted, context); return { contentId: randomUUID() }; } };
    const realExecute = router.execute.bind(router);
    if (execute) router.execute = (name, args, binding) => execute(name, args, binding, realExecute);
    let responseIndex = 0;
    const executor = createProviderExecutor({ tools: router, plan: async () => plan,
        toolContext: async (current, identity) => ({ ...trusted, ...identity }),
        prepareView: async () => ({ view: { protocol: adapter.protocol, messages: [{ role: 'user', content: 'Unit task.' }] },
            history: { historyEpoch: 1, appendSeq: steps.length, viewRevision: 1 }, attachmentManifestHash: 'a'.repeat(64) }),
        prepareRequest: async (current, selected, input) => {
            requests.push(structuredClone(input));
            await afterRequest?.(input, requests.length);
            return { adapter, snapshot: input, upperBound: { currency: 'USD', amountMicros: 0, reliable: true } };
        }, dispatcher: { execute: async () => {
            const scripted = script[responseIndex++];
            const calls = (typeof scripted === 'function' ? await scripted({ trusted, steps, requests }) : scripted) ?? [];
            const json = { id: `unit-${responseIndex}`, model: plan.modelId, choices: [{ index: 0,
                message: calls.length ? { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({
                    id: call.callId ?? `call-${responseIndex}-${index}`, type: 'function', function: {
                        name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } : { role: 'assistant', content: 'Complete.' },
                finish_reason: calls.length ? 'tool_calls' : 'stop' }] };
            return normalizeChatResponse(randomUUID(), { httpStatus: 200, headers: {}, body: JSON.stringify(json), json });
        } }, ...(transformToolResult ? { transformToolResult } : {}),
        publish: async () => [], release: async () => router.release(trusted) });
    try { return { outcome: await executor.execute(context), steps, requests, trusted }; }
    catch (failure) { if (captureFailure) return { failure, steps, requests, trusted }; throw failure; }
    finally { await router.cleanup(trusted); }
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AgentClient } from '../../../src/agent-client/client.ts';
import { initializeRuntime } from '../../../src/agent-server/discovery.ts';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { createAgentServices } from '../../../src/agent-server/server-services.ts';
import { listenAgentTransport } from '../../../src/agent-server/transport.ts';
import { PROTOCOL_VERSION, SERVER_VERSION } from '../../../src/agent-server/protocol.ts';
import { openAgentStore, createAgentWorkspacePorts } from '../../../src/agent-server/storage/index.ts';
import { createSqliteConfigurationPorts } from '../../../src/agent-server/storage/configuration.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { entryFromMetadata, modelScope } from '../../../src/agent-server/models/catalog.ts';
import { startI4eHttpFixture } from './delegation-i4e-http-fixture.mjs';

async function until(operation, predicate, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    do {
        latest = await operation();
        if (predicate(latest)) return latest;
        await delay(10);
    } while (Date.now() < deadline);
    assert.fail(`owned I8 RPC state did not settle: ${JSON.stringify(latest)}`);
}

test('I8 formal IPC parent restore stops an active child maintenance command and releases both checkpoint markers', { timeout: 45000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sa-i8-parent-rpc-'));
    const workspace = join(root, '普通 任务');
    const dataDir = join(root, 'state');
    await mkdir(workspace);
    let store;
    let runtime;
    let services;
    let transport;
    let client;
    let fixture;
    let command;
    let childContext;
    const abort = new AbortController();
    const ownerId = randomUUID();
    try {
        const authority = await initializeRuntime(dataDir);
        const identity = { principalId: authority.principalId, clientId: 'owned-i8-rpc-client' };
        store = await openAgentStore({ dataDir: join(dataDir, 'store') });
        runtime = createAgentRuntime({ store, cleanupGraceMs: 8000,
            internalChildRetentionOwnership: 'parent-cascade-v1',
            reconcileRunCleanup: input => services?.reconcileRunCleanup(input) ?? Promise.resolve('unconfirmed'),
            onConversationClosed: conversation => services?.onConversationClosed(conversation) });
        services = await createAgentServices({ authority, store, runtime,
            catalogPort: createSqliteConfigurationPorts(store.persistent).catalogPort, sharedServices: [] });
        const descriptor = { schemaVersion: 1, serverInstanceId: randomUUID(), pid: process.pid,
            processStartedAt: new Date().toISOString(), endpoint: authority.endpoint, protocolVersion: PROTOCOL_VERSION,
            serverVersion: SERVER_VERSION, credentialRef: authority.credentialRef, principalId: authority.principalId, dataDir };
        transport = await listenAgentTransport({ authority, descriptor, runtime: {
            dispatch: (method, params, caller) => services.dispatch(method, params, caller), subscribe: runtime.subscribe,
        }, onShutdown() {} });
        client = await AgentClient.connect({ dataDir, descriptor, clientId: identity.clientId, requestTimeoutMs: 15000 });
        const request = async (method, params) => {
            const result = await client.request(method, params, { clientCommandId: randomUUID() });
            assert.equal(result.ok, true, JSON.stringify(result));
            return result.data;
        };
        fixture = await startI4eHttpFixture({ workspace, ownerId });
        await writeFile(fixture.paths.input, 'ordinary child source\n');
        const profileId = randomUUID();
        const quotaLimitId = randomUUID();
        const initial = newProfile({ profileId, label: 'I8 owned loopback protocol fixture', protocol: 'compatible_chat',
            baseUrl: fixture.baseUrl, modelId: 'i4e-parent' });
        const profile = (await services.provider.profiles.put({ ...initial, quotaLimitId, parameterDefaults: { reasoningEffort: 'max' },
            routePolicy: { ...initial.routePolicy, allowedModels: ['i4e-parent', 'i4e-child'] } }, 0, identity, randomUUID())).profile;
        const observedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 600000).toISOString();
        const entries = ['i4e-parent', 'i4e-child'].map(modelId => {
            const evidence = value => ({ value, status: 'supported', source: 'verified_fixture', sourceRef: 'I8-owned-loopback',
                observedAt, expiresAt, scope: modelScope(profile, modelId, null), version: 'i8-local', confidence: 'contract_checked' });
            return { ...entryFromMetadata(profile, { id: modelId }, observedAt, expiresAt), contextWindow: evidence(65536),
                maxOutputTokens: evidence(128), inputModalities: evidence(['text']), outputModalities: evidence(['text']),
                tools: evidence(true), streaming: evidence(false), parameters: {
                    maxOutputTokens: evidence({ type: 'integer', min: 1, max: 128, wirePath: 'max_tokens' }),
                    reasoningEffort: evidence({ type: 'string', enum: ['max'], wirePath: 'reasoning_effort' }),
                }, pricing: evidence({ priceVersion: 'I8-zero-fee-fixture', currency: 'USD', unitTokens: 1000000,
                    inputUncached: 0, inputCacheRead: 0, inputCacheWrite: null, output: 0, reasoningBilledSeparately: false,
                    media: 'included_in_tokens', serverTools: 'disabled', sourceRef: 'owned-local-protocol',
                    validFrom: observedAt, expiresAt, coversAllParameters: true }) };
        });
        await services.provider.models.port.publish({ schemaVersion: 1, catalogVersion: ownerId, profileId,
            profileRevision: profile.revision, observedAt, expiresAt, entries }, null);
        await services.provider.ledger.createQuotaLimit({ quotaLimitId, currency: 'USD', maxCostMicros: 0,
            quotaScopeIds: [profile.quotaScopeId], sourceRef: 'I8-owned-zero-fee-loopback' });
        const modelRulesRef = join(root, 'owned-rules.json');
        await writeFile(modelRulesRef, JSON.stringify({ rulesVersion: 1, entries: [{ taskKind: 'fixture-files', profileId,
            modelId: 'i4e-child', reasoningEffort: 'max', requiredCapabilities: ['text', 'tools'], maxOutputTokens: 128 }] }));
        const created = await request('conversations.create', { retention: { mode: 'archive' }, options: { profileId,
            modelId: 'i4e-parent', writeRoots: [workspace], allowSubagents: true, childContextTokens: 32768, modelRulesRef,
            tools: ['read_file', 'write_file', 'list_files', 'run_command', 'child_spawn', 'child_wait', 'child_cancel'] } });
        const conversationId = created.conversationId;
        const started = await request('runs.start', { conversationId, input: { text: 'I4E_PARENT Complete ordinary parent and child files.' },
            budget: { costMode: 'hard', currency: 'USD', quotaLimitId, maxCostMicros: 0, maxModelCalls: 16,
                maxOutputTokens: 128, wallMs: 60000 } });
        const finished = await until(() => request('runs.get', { conversationId, runId: started.runId }),
            value => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.state));
        assert.equal(finished.state, 'succeeded', JSON.stringify(finished));
        const parent = await store.getRecord({ conversationId, kind: 'run', id: started.runId });
        const link = parent.value.internalChildren[0];
        const childId = link.childConversationId;
        const childControl = await request('server.claimControl', { scope: 'conversation', conversationId: childId });
        let cancelled = false;
        const childMaintenance = await runtime.createMaintenanceRun({ conversationId: childId, operationId: ownerId,
            purpose: 'workspace_restore' }, { client: identity, params: { conversationId: childId,
                controlLeaseId: childControl.controlLeaseId, controlEpoch: childControl.controlEpoch } }, async () => {
            abort.abort('owned child maintenance stopped');
            await command;
            const cleanup = await services.tools.release(childContext);
            cancelled = true;
            return cleanup === 'unconfirmed' ? 'unconfirmed' : 'resources_released';
        });
        const childConversation = await store.getRecord({ conversationId: childId, kind: 'conversation', id: childId });
        const childRun = await request('runs.get', { conversationId: childId, runId: childMaintenance.runId });
        const ports = createAgentWorkspacePorts(store);
        const parentActions = await ports.journal.list(conversationId);
        childContext = { principalId: identity.principalId, conversationId: childId, runId: childRun.runId,
            rootRunId: childRun.rootRunId, runEpoch: childRun.runEpoch, roundId: randomUUID(), actionId: randomUUID(), attemptId: randomUUID(),
            policyRevision: childConversation.value.policyRevision, roots: [workspace], retention: { mode: 'archive' },
            signal: abort.signal, async assertCurrent() {} };
        const marker = join(workspace, 'owned-running-command.txt');
        command = services.tools.execute('run_command', { application: process.execPath, cwd: workspace,
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'running');setInterval(()=>{},1000)`],
            timeoutMs: 30000, maxMemoryMB: 128, maxOutputBytes: 8192, writeSet: [marker] }, childContext);
        await until(() => readFile(marker, 'utf8').catch(() => null), value => value === 'running');
        const previewParams = { conversationId, mode: 'round_restart', roundId: parentActions[0].roundId,
            expectedHistoryEpoch: 1, expectedWorkspaceRevision: await ports.journal.revision(conversationId) };
        const preview = await request('changes.preview', previewParams);
        assert.deepEqual(preview.childConversationIds, [childId]);
        const firstCommit = await client.request('changes.commit', { conversationId, restorePlanId: preview.restorePlanId },
            { clientCommandId: randomUUID() });
        assert.equal(firstCommit.ok, false);
        assert.equal(firstCommit.error.code, 'VERSION_CONFLICT', JSON.stringify(firstCommit));
        assert.equal(cancelled, true);
        const commandResult = await command;
        assert.equal(commandResult.ok, true, JSON.stringify(commandResult));
        const commandResource = await services.tools.resources.store.get(commandResult.data.resourceId);
        assert.equal(commandResource.state, 'released');
        assert.equal(commandResource.receipt.terminalConfirmed, true);
        assert.equal(commandResource.receipt.evidence.activeProcessesAtRelease, 0);
        const stopped = await request('runs.get', { conversationId: childId, runId: childRun.runId });
        assert.ok(['paused', 'cancelled', 'succeeded'].includes(stopped.state), JSON.stringify(stopped));
        assert.ok(['released', 'not_needed'].includes(stopped.cleanupState), JSON.stringify(stopped));
        for (const owner of [conversationId, childId]) {
            assert.equal((await store.getRecord({ conversationId: owner, kind: 'conversation', id: owner })).value.workspaceQuiesce, undefined);
        }
        const refreshed = await request('changes.preview', previewParams);
        const restored = await request('changes.commit', { conversationId, restorePlanId: refreshed.restorePlanId });
        assert.equal(restored.state, 'complete', JSON.stringify(restored));
        assert.ok(restored.results.every(value => value.status === 'restored'), JSON.stringify(restored));
        for (const file of [fixture.paths.childOutput, fixture.paths.parentOutput, marker]) await assert.rejects(readFile(file), { code: 'ENOENT' });
        assert.equal(await readFile(fixture.paths.input, 'utf8'), 'ordinary child source\n');
        for (const owner of [conversationId, childId]) {
            assert.equal((await store.getRecord({ conversationId: owner, kind: 'conversation', id: owner })).value.workspaceQuiesce, undefined);
        }
        console.log(JSON.stringify({ evidence: 'I8-formal-parent-child-restore', authenticatedIpc: true,
            actualDelegation: true, actualWindowsJob: true, maintenanceChildStopped: cancelled,
            commandResourceReleased: true, jobActiveProcessesAtRelease: 0,
            stalePreviewRejected: true, refreshedRestore: restored.state, restoredFiles: restored.results.length,
            markersReleased: true, loopbackProtocolRequests: fixture.observations.length, paidRequests: 0 }));
    } finally {
        abort.abort('owned fixture cleanup');
        await command;
        await client?.close();
        await services?.close();
        await runtime?.close();
        await transport?.close();
        await store?.close();
        await fixture?.close();
        const target = await realpath(root);
        assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
        assert.ok(basename(target).startsWith('sa-i8-parent-rpc-'));
        await rm(target, { recursive: true, force: true });
    }
});

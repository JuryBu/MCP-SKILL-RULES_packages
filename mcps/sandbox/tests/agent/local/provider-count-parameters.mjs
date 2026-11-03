import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { MemoryAccountingPort } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { MemoryCatalogPort, entryFromMetadata, resolveParameters } from '../../../src/agent-server/models/catalog.ts';
import { MemoryProfilePort, newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { createProviderServices } from '../../../src/agent-server/providers/services.ts';
import { GeminiAdapter } from '../../../src/agent-server/providers/gemini.ts';
import { FetchTransport } from '../../../src/agent-server/providers/http.ts';

test('catalog-mapped Gemini 3.8 counting accepts a completed model tail while generation still rejects prefilling', async () => {
    const requests = [];
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ totalTokens: 10368 }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const modelId = 'gemini-3.8-flash';
    const profile = { ...newProfile({ profileId: randomUUID(), label: 'owned completed-tail counting', protocol: 'gemini',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, modelId }), parameterDefaults: { thinkingLevel: 'LOW' } };
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const entry = entryFromMetadata(profile, { name: `models/${modelId}`, inputTokenLimit: 1048576,
        outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] }, observedAt, expiresAt);
    const evidence = value => ({ ...entry.contextWindow, status: 'supported', source: 'verified_fixture',
        confidence: 'declared', sourceRef: profile.baseUrl, value });
    entry.parameters = {
        maxOutputTokens: evidence({ type: 'integer', min: 1, max: 65536, required: true, wirePath: 'generationConfig.maxOutputTokens' }),
        thinkingLevel: evidence({ type: 'string', enum: ['LOW'], wirePath: 'generationConfig.thinkingConfig.thinkingLevel' }),
    };
    const profilePort = new MemoryProfilePort();
    await profilePort.execute({ type: 'put', principalId: 'owned-test', clientId: 'owned-test', clientCommandId: randomUUID(), expectedRevision: 0, profile });
    const storedProfile = await profilePort.get(profile.profileId);
    const catalogPort = new MemoryCatalogPort();
    await catalogPort.publish({ schemaVersion: 1, profileId: profile.profileId, profileRevision: storedProfile.revision,
        catalogVersion: randomUUID(), observedAt, expiresAt, entries: [entry] }, null);
    const transport = new FetchTransport({ env: {}, platform: 'linux', windowsProxySettings: { enabled: false, pacConfigured: false } });
    const accountingPort = new MemoryAccountingPort();
    const service = createProviderServices({ accountingPort, profilePort, catalogPort, transport });
    const view = { protocol: 'gemini', systemInstruction: { parts: [{ text: 'retain the original requirements' }] }, contents: [
        { role: 'user', parts: [{ text: 'ordinary completed task' }] },
        { role: 'model', parts: [{ text: 'original completed answer', thoughtSignature: 'owned-completed-signature' }] },
    ] };
    const parameters = { maxOutputTokens: 128 };
    try {
        const mapped = resolveParameters(entry, profile, parameters);
        assert.throws(() => new GeminiAdapter().encode(view, modelId, mapped), { code: 'E_PARAMETER_UNSUPPORTED' });
        const result = await service.countRequestTokens(profile.profileId, modelId, view, undefined, expiresAt, parameters);
        assert.equal(result.inputTokens, 10368);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].path, `/v1beta/models/${modelId}:countTokens`);
        assert.deepEqual(requests[0].body.generateContentRequest.contents, view.contents);
        assert.deepEqual(requests[0].body.generateContentRequest.systemInstruction, view.systemInstruction);
        assert.equal(requests[0].body.generateContentRequest.generationConfig.maxOutputTokens, 128);
        assert.equal(requests[0].body.generateContentRequest.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
        assert.deepEqual((await accountingPort.exportState()).reservations, {});
    } finally {
        await service.close(); await transport.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('request counting maps selected and default parameters through the same catalog as generation', async () => {
    const requests = [];
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ totalTokens: 417 }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const modelId = 'gemini-nano-banana-2.1';
    const profile = { ...newProfile({ profileId: randomUUID(), label: 'owned parameter mapping', protocol: 'gemini',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, modelId }), parameterDefaults: { thinkingLevel: 'MINIMAL' } };
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const entry = entryFromMetadata(profile, { name: `models/${modelId}`, inputTokenLimit: 65536,
        outputTokenLimit: 32768, supportedGenerationMethods: ['generateContent', 'countTokens'] }, observedAt, expiresAt);
    const evidence = value => ({ ...entry.contextWindow, status: 'supported', source: 'verified_fixture',
        confidence: 'declared', sourceRef: profile.baseUrl, value });
    entry.parameters = {
        maxOutputTokens: evidence({ type: 'integer', min: 1, max: 32768, required: true, wirePath: 'generationConfig.maxOutputTokens' }),
        thinkingLevel: evidence({ type: 'string', enum: ['MINIMAL'], wirePath: 'generationConfig.thinkingConfig.thinkingLevel' }),
        responseModalities: evidence({ type: 'array', schema: { type: 'array', items: { type: 'string', enum: ['TEXT', 'IMAGE'] } },
            wirePath: 'generationConfig.responseModalities' }),
    };
    const profilePort = new MemoryProfilePort();
    await profilePort.execute({ type: 'put', principalId: 'owned-test', clientId: 'owned-test', clientCommandId: randomUUID(),
        expectedRevision: 0, profile });
    const storedProfile = await profilePort.get(profile.profileId);
    const catalogPort = new MemoryCatalogPort();
    await catalogPort.publish({ schemaVersion: 1, profileId: profile.profileId, profileRevision: storedProfile.revision,
        catalogVersion: randomUUID(), observedAt, expiresAt, entries: [entry] }, null);
    const transport = new FetchTransport({ env: {}, platform: 'linux', windowsProxySettings: { enabled: false, pacConfigured: false } });
    const service = createProviderServices({ accountingPort: new MemoryAccountingPort(), profilePort, catalogPort, transport });
    const parameters = { maxOutputTokens: 128, responseModalities: ['TEXT', 'IMAGE'] };
    const view = { protocol: 'gemini', contents: [{ role: 'user', parts: [{ text: 'Describe the original image' }] },
        { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nksAAAAASUVORK5CYII=' },
            thoughtSignature: 'owned-original-signature' }] }, { role: 'user', parts: [{ text: 'Keep the same composition' }] }] };
    try {
        const result = await service.countRequestTokens(profile.profileId, modelId, view, undefined, expiresAt, parameters);
        assert.equal(result.inputTokens, 417);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].path, `/v1beta/models/${modelId}:countTokens`);
        assert.deepEqual(requests[0].body.generateContentRequest, { model: `models/${modelId}`,
            ...new GeminiAdapter().encode(view, modelId, resolveParameters(entry, profile, parameters)) });
        assert.equal(requests[0].body.generateContentRequest.generationConfig.maxOutputTokens, 128);
        assert.equal(requests[0].body.generateContentRequest.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
        assert.equal(Object.hasOwn(requests[0].body.generateContentRequest, 'maxOutputTokens'), false);
    } finally {
        await service.close();
        await transport.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

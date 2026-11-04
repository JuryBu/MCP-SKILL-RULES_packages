import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'sandbox-council-media-i8-'));
process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_TEMP_DIR = join(root, 'artifacts');
const { runCouncil } = await import('../../../src/council/engine.ts');
const { normalizeGeminiResponse } = await import('../../../src/agent-server/providers/gemini.ts');
const { readyCouncilImages, councilMediaDescription } = await import('../../../src/council/api-results.ts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=', 'base64');
const model = (id, supportsVision) => ({ id, role: id, provider: 'api', profileId: 'fixture-profile', model: 'fixture-gemini', supportsVision });
const normalized = (parts, id) => {
    const data = { responseId: randomUUID(), modelVersion: 'fixture-gemini', candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } };
    return normalizeGeminiResponse(id, { httpStatus: 200, headers: {}, body: JSON.stringify(data), json: data });
};

test('I8 Council forwards original and generated originals to vision members, text summaries to text members, preserving native signed blocks through resume', async () => {
    const original = join(root, 'original.png');
    await writeFile(original, png);
    const calls = [];
    let moderatorCalls = 0;
    let generated = false;
    const apiSession = { async call(config, prompt, paths) {
        calls.push({ id: config.id, prompt, paths: [...paths] });
        if (config.id === 'summary') return normalized([{ text: '图片摘要：一个红色圆点，图片原件已读取。' }], randomUUID());
        if (config.id === 'vision' && !generated) {
            generated = true;
            return normalized([{ inlineData: { mimeType: 'image/png', data: png.toString('base64') }, thoughtSignature: 'fixture-thought-signature' }], randomUUID());
        }
        if (config.id === 'moderator') {
            moderatorCalls++;
            return normalized([{ text: JSON.stringify({ action: moderatorCalls === 1 ? 'continue' : 'terminate', summary: '已审阅图片', finalAnswer: '完成' }) }], randomUUID());
        }
        return normalized([{ text: '已阅读讨论材料' }], randomUUID());
    } };
    const params = { ownerId: 'I8-owned-fixture', input: '检查这些图片和后续生成图片', participants: [model('vision', true), model('text', false)],
        moderator: model('moderator', true), transcriptionModel: model('summary', true), images: [original], apiSession, maxRounds: 2, outputDir: join(root, 'output') };
    const transcript = await runCouncil(params);
    const first = transcript.rounds[0].messages.find(message => message.participantId === 'vision');
    assert.equal(first.text, '');
    assert.equal(first.error, undefined);
    assert.equal(first.response.blocks[0].thoughtSignature, 'fixture-thought-signature');
    const generatedPath = first.metadata.media[0].path;
    assert.deepEqual(await readFile(generatedPath), png);
    assert.ok(calls.find(call => call.id === 'moderator').paths.includes(generatedPath));
    assert.ok(calls.filter(call => call.id === 'vision')[1].paths.includes(generatedPath));
    const textCalls = calls.filter(call => call.id === 'text');
    assert.deepEqual(textCalls.map(call => call.paths), [[], []]);
    assert.match(textCalls[1].prompt, /红色圆点/);
    assert.equal(textCalls[1].prompt.includes('nativeRef'), false);
    assert.equal(calls.filter(call => call.id === 'summary' && call.paths.includes(generatedPath)).length, 1);
    const saved = JSON.parse(await readFile(first.metadata.responsePath, 'utf8'));
    assert.equal(saved.raw.json.candidates[0].content.parts[0].thoughtSignature, 'fixture-thought-signature');
    const before = calls.length;
    const previous = structuredClone(transcript);
    previous.rounds = previous.rounds.slice(0, 1);
    await runCouncil({ ...params, resumeState: { sourceTaskId: 'fixture-resume', sourceRunId: transcript.runId, transcript: previous,
        checkpoint: { transcriptId: previous.id, currentRound: 1, lastCompletedRound: 1, phase: 'round_complete', roundComplete: true, updatedAt: new Date().toISOString() } } });
    const resumed = calls.slice(before);
    assert.equal(resumed.filter(call => call.id === 'summary').length, 0);
    assert.ok(resumed.find(call => call.id === 'vision').paths.includes(generatedPath));
    assert.match(resumed.find(call => call.id === 'text').prompt, /红色圆点/);
});

test('I8 cross-member summaries expose only media provenance and detect changed originals before sharing', async () => {
    const file = join(root, 'integrity.png');
    await writeFile(file, png);
    const metadata = { media: [{ path: file, type: 'image', mime: 'image/png', byteLength: png.length,
        sha256: createHash('sha256').update(png).digest('hex'), state: 'ready', nativeRef: 'private-native-ref' }] };
    assert.equal(readyCouncilImages(metadata).length, 1);
    assert.equal(councilMediaDescription(metadata).includes('private-native-ref'), false);
    await writeFile(file, Buffer.alloc(png.length));
    assert.throws(() => readyCouncilImages(metadata), { code: 'E_COUNCIL_MEDIA_INTEGRITY', acceptance: 'not_sent' });
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });

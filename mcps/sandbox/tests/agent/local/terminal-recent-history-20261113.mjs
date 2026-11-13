import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { TRANSCRIPT_HISTORY_LIMITS } from '../../../src/agent-cli/history-view.ts';
import { readHistory } from '../../../src/agent-server/storage/history.ts';
import { ObjectFiles } from '../../../src/agent-server/storage/objects.ts';

function fixture(request, readArtifact) {
    const ui = Object.create(InteractiveCli.prototype);
    const texts = [];
    Object.assign(ui, { viewEpoch: 1, disposed: false, conversation: { conversationId: 'recent-history' },
        client: { request, readArtifact }, printTranscript: async text => texts.push(text), log: () => {},
        showError: result => { throw new Error(JSON.stringify(result)); } });
    return { ui, texts };
}

test('tool-only history stops at four bounded backward requests without scanning the conversation', async () => {
    const queries = [];
    const current = fixture(async (_method, query) => {
        queries.push(query);
        return { ok: true, data: { items: [{ role: 'tool', seq: 1000 - queries.length }], hasMore: true, nextCursor: String(queries.length) } };
    });
    await current.ui.restoreTranscript('recent-history');
    assert.equal(queries.length, TRANSCRIPT_HISTORY_LIMITS.pages);
    assert.ok(queries.every(query => query.direction === 'backward' && query.limit === 100 && query.maxBytes === 128 * 1024));
    assert.equal(current.texts.length, 0);
    assert.equal(current.ui.historyCursor, '4');
});

test('referenced original bodies have a shared byte and request budget', async () => {
    let reads = 0;
    let pages = 0;
    const current = fixture(async () => ({ ok: true, data: { items: Array.from({ length: 20 }, (_, index) => ({ role: 'assistant', contentId: String(index), objectRef: { rawBytes: 65536 } })), hasMore: true, nextCursor: String(++pages) } }),
        async () => { reads += 1; return { ok: false }; });
    await current.ui.restoreTranscript('recent-history');
    assert.equal(reads, 4);
    assert.equal(pages, 4);
});

test('the selected archived CSV conversation restores the latest correction and assistant answer from its tail', { skip: !process.env.REAL_CLI_HISTORY_STORE || !process.env.REAL_CLI_HISTORY_CONVERSATION_ID }, async () => {
    const root = process.env.REAL_CLI_HISTORY_STORE;
    const database = new DatabaseSync(root + '/catalog.sqlite', { readOnly: true });
    const files = new ObjectFiles(root, 8 * 1024 * 1024);
    const queries = [];
    const conversationId = process.env.REAL_CLI_HISTORY_CONVERSATION_ID;
    let artifactReads = 0;
    const current = fixture(async (_method, query) => { queries.push(query); return { ok: true, data: readHistory(database, files, root, query) }; }, async (_conversationId, contentId) => {
        artifactReads += 1;
        const row = database.prepare('SELECT object_hash FROM items WHERE cid=? AND content_id=?').get(conversationId, contentId);
        return { ok: true, data: { mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(files.read(database, row.object_hash))) } };
    });
    current.ui.conversation = { conversationId };
    try {
        await current.ui.restoreTranscript(conversationId);
        const text = current.texts.join('\n');
        assert.match(text, /助手：/);
        assert.match(text, /你：/);
        assert.match(text, /264600/);
        assert.match(text, /206\.72/);
        assert.ok(queries.length <= 4);
        console.log(JSON.stringify({ actualArchive: true, pages: queries.length, artifactReads, bodyCharacters: text.length, latestTotalPreserved: text.includes('264600'), latestResultPreserved: text.includes('206.72') }));
    } finally { database.close(); }
});

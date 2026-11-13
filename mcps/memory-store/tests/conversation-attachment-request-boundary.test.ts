import assert from 'node:assert/strict';
import { extractFilesMentionedAttachments, materializeRoundAttachments } from '../src/conversation-attachments.ts';

for (const heading of ['## My request:', '## My request for Codex:', '# My request:']) {
    const text = '# Files mentioned by the user:\n\n## picture.png: C:/example/picture.png\n\n' + heading + '\n\nPlease check this file\n## This is a request detail: not another attachment\n';
    const attachments = extractFilesMentionedAttachments(text);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, 'picture.png');
}
assert.equal(extractFilesMentionedAttachments('# Files mentioned by the user:\n## empty:\nNext line is ordinary text').length, 0);
const stored = { roundIndex: 1, startStep: 0, endStep: 1, userMessage: 'request', mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [], attachments: [{ kind: 'file' as const, source: 'files-mentioned' as const, name: 'My request', originalPath: 'C:/example/request prose', exists: false }] };
const presented = await materializeRoundAttachments([stored], 'test-request-boundary');
assert.equal(presented.rounds[0].attachments?.length, 0);
assert.equal(stored.attachments.length, 1);
console.log('Attachment request boundary passed');

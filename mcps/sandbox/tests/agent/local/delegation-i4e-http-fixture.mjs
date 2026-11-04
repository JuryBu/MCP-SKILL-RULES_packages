import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';

function parsed(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

function completedTools(body) {
    const calls = new Map();
    const completed = [];
    for (const message of body.messages ?? []) {
        for (const call of message.tool_calls ?? []) calls.set(call.id, { name: call.function.name, args: parsed(call.function.arguments) });
        if (message.role !== 'tool') continue;
        const call = calls.get(message.tool_call_id);
        if (!call) throw new Error('fixture received an unpaired tool result');
        const result = parsed(message.content);
        if (!result || result.ok !== true) throw new Error(`fixture tool ${call.name} did not complete: ${JSON.stringify(result)}`);
        completed.push({ ...call, data: result.data });
    }
    return completed;
}

export async function startI4eHttpFixture({ workspace, ownerId, holdChild = false }) {
    if (!ownerId || !path.isAbsolute(workspace)) throw new Error('the fixture requires its explicit owner and absolute owned workspace');
    const paths = { input: path.join(workspace, 'i4e-input.txt'), childOutput: path.join(workspace, 'i4e-child.txt'),
        parentOutput: path.join(workspace, 'i4e-parent.txt') };
    const observations = [];
    const sockets = new Set();
    const held = new Set();
    let holding = holdChild;
    let sequence = 0;
    const server = createServer(async (request, response) => {
        try {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) throw new Error('fixture request exceeds its normal bounded input');
                chunks.push(chunk);
            }
            if (request.method === 'GET' && request.url === '/v1/models') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ object: 'list', data: ['i4e-parent', 'i4e-child'].map(id => ({ id, object: 'model', owned_by: 'own-fixture' })) }));
                return;
            }
            if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw new Error('fixture only accepts its normal compatible-chat route');
            const bytes = Buffer.concat(chunks);
            const body = JSON.parse(bytes.toString('utf8'));
            if (!['i4e-parent', 'i4e-child'].includes(body.model)) throw new Error('fixture model selection differs from its declared local model');
            const tools = completedTools(body);
            const observation = { ownerId, ordinal: ++sequence, model: body.model, bodyHash: createHash('sha256').update(bytes).digest('hex'),
                reasoningEffort: body.reasoning_effort ?? null,
                declaredTools: (body.tools ?? []).map(tool => tool.function?.name), completedTools: tools.map(tool => tool.name),
                responseClosed: false, responseFinished: false };
            observations.push(observation);
            response.once('close', () => { observation.responseClosed = true; held.delete(response); });
            response.once('finish', () => { observation.responseFinished = true; });
            const toolCalls = [];
            const call = (name, args) => toolCalls.push({ id: `i4e-${observation.ordinal}-${toolCalls.length + 1}`, type: 'function',
                function: { name, arguments: JSON.stringify(args) } });
            const read = file => tools.findLast(tool => tool.name === 'read_file' && path.resolve(tool.args.path) === file)?.data;
            const wrote = file => tools.findLast(tool => tool.name === 'write_file' && path.resolve(tool.args.path) === file);
            let text;
            if (body.model === 'i4e-child') {
                if (holding) { held.add(response); return; }
                if (wrote(paths.childOutput)) text = 'The selected local input was read and the child file was written.';
                else if (read(paths.input) && read(paths.childOutput)) {
                    call('write_file', { path: paths.childOutput, content: `CHILD:${read(paths.input).content}`,
                        expectedVersion: read(paths.childOutput).expectedVersion });
                } else {
                    call('read_file', { path: paths.input });
                    call('read_file', { path: paths.childOutput });
                }
            } else {
                const spawned = tools.findLast(tool => tool.name === 'child_spawn')?.data;
                const waited = tools.findLast(tool => tool.name === 'child_wait')?.data;
                if (wrote(paths.parentOutput)) text = 'The parent read the actual child file and wrote its combined result.';
                else if (waited?.terminalConfirmed === true && waited.state === 'succeeded') {
                    if (read(paths.childOutput) && read(paths.parentOutput)) {
                        call('write_file', { path: paths.parentOutput, content: `PARENT:${read(paths.childOutput).content}`,
                            expectedVersion: read(paths.parentOutput).expectedVersion });
                    } else {
                        call('read_file', { path: paths.childOutput });
                        call('read_file', { path: paths.parentOutput });
                    }
                } else if (spawned?.childRunId) call('child_wait', { childRunId: spawned.childRunId, waitMs: 45000 });
                else call('child_spawn', { taskKind: 'fixture-files', task: `I4E_CHILD Read ${paths.input} and write CHILD: plus the exact input to ${paths.childOutput}.`,
                    contextRefs: [], writeRoots: [workspace], limits: { wallMs: 60000, maxModelCalls: 4, maxCostMicros: 0, maxContextTokens: 32768 } });
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ id: `i4e-own-http-${observation.ordinal}`, object: 'chat.completion', created: 1793356800,
                model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text ?? null,
                    ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        } catch (error) {
            observations.push({ ownerId, error: error.message });
            if (!response.headersSent) response.writeHead(422, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { code: 'OWN_FIXTURE_CONTRACT', message: error.message } }));
        }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, paths, observations,
        async close() {
            for (const response of held) response.destroy();
            held.clear();
            const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            for (const socket of sockets) socket.destroy();
            await closed;
        },
        resources() { return { ownerId, listening: server.listening, sockets: sockets.size, heldResponses: held.size }; },
    };
}

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const options = JSON.parse(process.env.MOCK_AGY_OPTIONS ?? '{}');
const auditPath = process.env.MOCK_AGY_AUDIT;
const args = process.argv.slice(2);
const record = event => fs.appendFileSync(auditPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const respond = (request, result) => send({ id: request.id, result });
const update = content => send({ method: 'session/update', params: { sessionId: 'mock-session', update: content } });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
record({ kind: 'spawn', args, cwd: process.cwd() });
if (options.stderr) process.stderr.write(options.stderr);
const server = http.createServer((request, response) => {
    const method = request.url?.split('/').at(-1);
    record({ kind: 'http-request', method });
    request.resume();
    response.once('close', () => record({ kind: 'http-close', method, aborted: !response.writableEnded }));
    if ((method === 'GetUserStatus' && options.httpMetadataHang) || (method === 'GetModelResponse' && options.httpGenerationHang)) return;
    response.end(JSON.stringify(method === 'GetModelResponse' ? { response: 'mock response' } : { userStatus: { mock: true } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const logPath = args[args.indexOf('--cli_log_file') + 1];
fs.writeFileSync(logPath, `Starting language server process with pid ${options.wrongPid ? process.pid + 1 : process.pid}\nLanguage server listening on random port at ${server.address().port} for HTTP\n`);
let pendingPrompt;

if (options.invalidStdout) process.stdout.write('invalid output\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
    const request = JSON.parse(line);
    record({ kind: 'message', message: request });
    if (!request.method) return;
    if (request.method === 'initialize') {
        if (options.initializeError) { send({ id: request.id, error: options.initializeError }); return; }
        respond(request, { protocolVersion: options.protocolVersion ?? 1, agentCapabilities: { promptCapabilities: { image: options.image !== false } } });
    } else if (request.method === 'session/new') {
        if (options.sessionError) { send({ id: request.id, error: options.sessionError }); return; }
        respond(request, {
            sessionId: 'mock-session',
            models: { currentModelId: options.currentModel ?? 'gemini-4-argon-medium', availableModels: options.models ?? [{ modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }] },
        });
    } else if (request.method === 'session/set_model') {
        if (options.setModelError) send({ id: request.id, error: options.setModelError });
        else respond(request, {});
    } else if (request.method === 'session/prompt') {
        pendingPrompt = request;
        if (options.permission) send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'mock-session', options: [{ optionId: 'yes', kind: 'allow_always' }] } });
        if (options.clientCalls) {
            send({ id: 'fs-1', method: 'fs/read_text_file', params: { path: path.join(process.cwd(), 'secret.txt') } });
            send({ id: 'terminal-1', method: 'terminal/create', params: { command: 'forbidden' } });
        }
        if (options.promptError) { send({ id: request.id, error: options.promptError }); return; }
        if (options.dieAfterPrompt) { await wait(10); process.exit(0); }
        if (options.nativeTool) { update({ sessionUpdate: 'tool_call', toolCallId: 'native', title: 'read_file', status: 'pending' }); return; }
        if (options.overflow) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 1) } }); return; }
        if (options.hangPrompt) return;
        await wait(options.promptDelay ?? 10);
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'not final' } });
        if (options.interimMessage) update({ sessionUpdate: 'agent_message_chunk', messageId: 'before', content: { type: 'text', text: 'interim' } });
        for (const text of options.chunks ?? ['{"image":', 'true}']) update({ sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { type: 'text', text } });
        respond(request, { stopReason: options.stopReason ?? 'end_turn', ...(options.terminal ?? {}) });
        record({ kind: 'terminal' });
    } else if (request.method === 'session/cancel') {
        record({ kind: 'cancel' });
        if (pendingPrompt && !options.ignoreCancel) {
            await wait(options.cancelDelay ?? 10);
            respond(pendingPrompt, { stopReason: 'cancelled' });
            record({ kind: 'cancelled-terminal' });
        }
    }
});
input.once('close', async () => {
    record({ kind: 'eof' });
    if (options.latePermission) send({ id: 'late-permission', method: 'session/request_permission', params: { sessionId: 'mock-session', options: [] } });
    if (options.ignoreEof) { setInterval(() => {}, 1000); return; }
    await wait(options.eofDelay ?? 0);
    server.close(() => process.exit(options.exitCode ?? 0));
});

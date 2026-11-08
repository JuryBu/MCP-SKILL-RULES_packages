#!/usr/bin/env node
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { AgentClient, clientFailure } from '../agent-client/client.js';
import { AgentFault, SERVER_VERSION, type RpcResult } from '../agent-server/protocol.js';
import { defaultDataDir } from '../agent-server/discovery.js';
import { parseArguments, usage } from './arguments.js';
import { commandMetadata, executeCommand, parseCommand, renderHelp, type CommandExecution } from './commands.js';
import { readCommandInput } from './input.js';
import { cancelExecution, waitForExecution } from './watch.js';
import { terminalSafeText } from './renderer.js';
import { formatExecutionText, humanJson } from './presentation.js';

export interface CliStreams {
    stdin: Readable & { isTTY?: boolean };
    stdout: Writable & { isTTY?: boolean };
    stderr: Writable & { isTTY?: boolean };
    cwd?: string;
}

export function exitCodeForResult(result: RpcResult): number {
    if (!result.ok) {
        const code = result.error?.code ?? 'INTERNAL_ERROR';
        if (['E_CLI_USAGE', 'INVALID_PARAMS', 'FRAME_TOO_LARGE', 'METHOD_NOT_AVAILABLE', 'METHOD_NOT_FOUND'].includes(code)) return 2;
        if (/PROFILE|BUDGET_REQUIRED|BUDGET_UNBOUNDED|CONFIG|CLIENT_STATE|RUNTIME_DIRECTORY/.test(code)) return 3;
        if (/CONTROL_CONFLICT|CONTROL_REQUIRED|STALE|REVISION_CONFLICT|COMMAND_CONFLICT|TARGET_ROUND|INPUT_FROZEN|CURSOR_EXPIRED/.test(code)) return 8;
        if (/RECEIPT_UNKNOWN|OUTCOME_UNKNOWN|CLEANUP_UNCONFIRMED/.test(code) || result.error?.mayHaveStarted) return 7;
        if (/WAITING|INTERACTION_REQUIRED/.test(code)) return 5;
        if (/IPC|AUTH|PROTOCOL|SERVER|AGENT_BUILD|AGENT_RUNTIME/.test(code)) return 4;
        return 6;
    }
    if (result.data && typeof result.data === 'object') {
        const data = result.data as Record<string, unknown>;
        if (data.waitingForHuman === true) return 5;
        if (data.waitingForExecutor === true) return 4;
        if (data.cleanupState === 'unconfirmed' || data.state === 'outcome_unknown' || data.resultStatus === 'unknown') return 7;
        if (data.state === 'failed' || data.resultStatus === 'failed') return 6;
    }
    return 0;
}

async function write(stream: Writable, text: string): Promise<void> {
    if (stream.destroyed) return;
    await new Promise<void>((resolveWrite, rejectWrite) => {
        stream.write(text, error => error ? rejectWrite(error) : resolveWrite());
    });
}

export async function emitResult(streams: CliStreams, execution: CommandExecution, json: boolean, clientId?: string, forcedExitCode?: number): Promise<number> {
    const exitCode = forcedExitCode ?? exitCodeForResult(execution.result);
    if (json) {
        await write(streams.stdout, JSON.stringify({
            ...execution.result, ...(execution.method ? { method: execution.method } : {}),
            ...(clientId ? { clientId } : {}), ...(execution.clientCommandId ? { clientCommandId: execution.clientCommandId } : {}), exitCode,
        }) + '\n');
    } else if (execution.result.ok) {
        await write(streams.stdout, typeof execution.result.data === 'string' ? terminalSafeText(execution.result.data) + '\n' : humanJson(execution.result.data ?? {}) + '\n');
        if (execution.clientCommandId) await write(streams.stderr, `命令ID：${execution.clientCommandId}\n`);
        if (execution.result.receiptId) await write(streams.stderr, `回执ID：${execution.result.receiptId}\n`);
    } else {
        await write(streams.stderr, terminalSafeText(`${execution.result.error?.code ?? 'ERROR'}：${execution.result.error?.message ?? '操作失败'}`) + '\n');
        if (execution.result.error?.details) await write(streams.stderr, humanJson(execution.result.error.details) + '\n');
    }
    return exitCode;
}

export async function main(argv = process.argv.slice(2), streams: CliStreams = {
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
}): Promise<number> {
    let client: AgentClient | undefined;
    let json = argv.some(argument => argument === '--json' || argument === '--json=true');
    const started = performance.now();
    let signalExitCode: number | undefined;
    let cancelRequested = false;
    let forcedFrontendExit = false;
    let readingStdin = false;
    const abort = new AbortController();
    const onSigterm = () => { signalExitCode = 143; abort.abort(); if (readingStdin) streams.stdin.destroy(); void client?.close(); };
    const onSigint = () => {
        if (cancelRequested) { forcedFrontendExit = true; signalExitCode = 7; void client?.close(); return; }
        cancelRequested = true; signalExitCode = 130; abort.abort();
        if (readingStdin) streams.stdin.destroy();
    };
    const isProcessIo = streams.stdin === process.stdin && streams.stdout === process.stdout;
    try {
        const parsed = parseArguments(argv);
        for (const [name, allowed] of Object.entries({ color: ['auto', 'always', 'never'], graphics: ['auto', 'blocks', 'sixel', 'kitty', 'none'], renderer: ['full', 'diff'], 'image-cache': ['on', 'off'], format: ['text', 'jsonl'], 'secret-format': ['plain', 'env', 'json'] })) {
            if (parsed.options[name] !== undefined && !allowed.includes(String(parsed.options[name]))) throw usage(`--${name}可选：${allowed.join('|')}`);
        }
        if ((parsed.options.renderer !== undefined || parsed.options['image-cache'] !== undefined) && parsed.options.diagnostics !== true) throw usage('--renderer和--image-cache须同时带--diagnostics');
        json = parsed.options.json === true;
        if (parsed.options.help === true || parsed.words[0] === 'help' || parsed.words[0] === '/help' || parsed.words[0] === '/h') {
            const target = parsed.options.help === true ? parsed.words.join(' ') : parsed.words.slice(1).join(' ');
            const text = renderHelp(target || undefined, parsed.options.diagnostics === true);
            if (json) return emitResult(streams, { result: { ok: true, data: { ...commandMetadata(), help: text } } }, true);
            await write(streams.stdout, text);
            return 0;
        }
        if (parsed.options.version === true) {
            if (json) return emitResult(streams, { result: { ok: true, data: { name: 'sandbox_agent', version: SERVER_VERSION, protocolVersion: 1 } } }, true);
            await write(streams.stdout, `sandbox_agent ${SERVER_VERSION} (protocol 1)\n`);
            return 0;
        }
        const timeoutMs = typeof parsed.options['timeout-ms'] === 'number' ? parsed.options['timeout-ms'] : undefined;
        const startupTimeoutMs = typeof parsed.options['startup-timeout-ms'] === 'number' ? parsed.options['startup-timeout-ms'] : undefined;
        for (const [name, duration, maximum] of [['timeout-ms', timeoutMs, 125_000], ['startup-timeout-ms', startupTimeoutMs, 120_000]] as const) {
            if (duration !== undefined && (duration < 1 || duration > maximum)) throw usage(`--${name}须在1至${maximum}毫秒之间`);
        }
        const interactive = parsed.words.length === 0 && streams.stdin.isTTY === true && streams.stderr.isTTY === true && !json;
        if (parsed.words.length === 0 && !interactive) throw usage('非TTY模式需要一个命令；正文须用runs start及--text、--input-file或--stdin明确提交');
        const command = interactive ? undefined : parseCommand(parsed);
        if (parsed.options['cell-size'] !== undefined && !/^[1-9]\d{0,2}x[1-9]\d{0,2}$/.test(String(parsed.options['cell-size']))) throw usage('--cell-size需要明确正整数widthxheight，例如10x20');
        client = new AgentClient({
            dataDir: typeof parsed.options['data-dir'] === 'string' ? resolve(parsed.options['data-dir']) : defaultDataDir(),
            ...(typeof parsed.options['client-id'] === 'string' ? { clientId: parsed.options['client-id'] } : {}),
            ...(typeof parsed.options['server-entry'] === 'string' ? { serverEntry: parsed.options['server-entry'] } : {}),
            ...(typeof parsed.options['deadline-at'] === 'string' ? { deadlineAt: parsed.options['deadline-at'] } : {}),
            ...(timeoutMs ? { requestTimeoutMs: timeoutMs } : {}), ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
        });
        if (isProcessIo) process.once('SIGTERM', onSigterm);
        if (isProcessIo && command?.spec.name === 'exec') process.on('SIGINT', onSigint);
        if (interactive) {
            const { runInteractiveCli } = await import('./ui.js');
            return await runInteractiveCli(parsed, client, streams);
        }
        let input: Promise<string | undefined> | undefined;
        let execution = await executeCommand(command!, {
            client, cwd: streams.cwd ?? process.cwd(),
            signal: abort.signal,
            readInput: () => input ??= (async () => {
                readingStdin = parsed.options.stdin === true;
                try { const text = await readCommandInput(parsed, streams.stdin); if (abort.signal.aborted) throw new AgentFault('FRONTEND_CANCELLED', '前台已取消，正文未提交'); return text; }
                finally { readingStdin = false; }
            })(),
        });
        if (command!.spec.name === 'exec' && execution.result.ok && parsed.options.detach !== true) {
            const handle = execution.result.data as Record<string, unknown>;
            const conversationId = typeof handle.conversationId === 'string' ? handle.conversationId : String(parsed.options.conversation ?? '');
            const runId = String(handle.runId);
            const final = handle.executorAvailable === false ? { ...execution.result, data: { ...handle, waitingForExecutor: true } } : await waitForExecution(client, conversationId, runId, {
                nonInteractive: true, signal: abort.signal, afterCursor: execution.result.eventCursor,
                event: parsed.options.format === 'jsonl' ? event => write(streams.stdout, JSON.stringify(event) + '\n') : undefined,
            });
            execution = { ...execution, result: cancelRequested && !forcedFrontendExit ? await cancelExecution(client, conversationId, runId) : final };
        }
        const finalData = execution.result.data as Record<string, unknown> | undefined;
        if (command!.spec.name === 'exec' && execution.result.ok && finalData?.state === 'cancelled'
            && ['released', 'not_needed'].includes(String(finalData.cleanupState)) && signalExitCode === undefined) signalExitCode = 130;
        if (cancelRequested && !forcedFrontendExit && signalExitCode !== 143) {
            signalExitCode = execution.result.error?.code === 'FRONTEND_CANCELLED' || execution.result.ok && finalData?.state === 'cancelled' && ['released', 'not_needed'].includes(String(finalData.cleanupState)) ? 130 : exitCodeForResult(execution.result);
        }
        if (command!.spec.name === 'exec' && parsed.options.format === 'jsonl') {
            const exitCode = signalExitCode ?? exitCodeForResult(execution.result);
            const data = execution.result.data as Record<string, unknown> | undefined;
            await write(streams.stdout, JSON.stringify({ type: 'cli.result', ...execution.result, exitCode,
                resultStatus: data?.resultStatus ?? null, stopReason: data?.stopReason ?? null, cleanupState: data?.cleanupState ?? null,
                artifacts: (data?.result as Record<string, unknown> | undefined)?.artifacts ?? null }) + '\n');
            return exitCode;
        }
        if (command!.spec.name === 'exec' && !json && execution.result.ok) {
            const data = execution.result.data as Record<string, unknown> | undefined;
            const text = formatExecutionText(data?.result, String(data?.conversationId ?? ''), client.dataDir);
            if (text !== undefined) {
                await write(streams.stdout, text + '\n');
                await write(streams.stderr, `会话：${data?.conversationId ?? ''} · 执行：${data?.runId ?? ''} · ${data?.state ?? ''} · 清理 ${data?.cleanupState ?? ''}\n`);
                return signalExitCode ?? exitCodeForResult(execution.result);
            }
        }
        if (parsed.options.diagnostics === true) await write(streams.stderr, JSON.stringify({
            type: 'cli.diagnostics', elapsedMs: performance.now() - started, rssBytes: process.memoryUsage().rss,
            clientVersion: SERVER_VERSION, method: execution.method,
        }) + '\n');
        return await emitResult(streams, execution, json, client.clientId || undefined, signalExitCode);
    } catch (error) {
        return await emitResult(streams, { result: clientFailure(error) }, json, client?.clientId || undefined, signalExitCode);
    } finally {
        if (isProcessIo) { process.removeListener('SIGTERM', onSigterm); process.removeListener('SIGINT', onSigint); }
        await client?.close();
    }
}


const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
    main().then(exitCode => { process.exitCode = exitCode; }).catch(() => {
        process.stderr.write('E_CLI_IO：无法写入CLI结果\n');
        process.exitCode = 4;
    });
}

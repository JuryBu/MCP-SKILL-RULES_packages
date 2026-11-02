import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { AgentFault, MAX_FRAME_BYTES, PROTOCOL_VERSION, failure, handshakePayload, rpcRequestSchema,
    validateParams, type AgentEvent, type ClientIdentity, type RpcResult, type ServerDescriptor } from './protocol.js';
import type { RuntimeAuthority } from './discovery.js';

export interface RuntimeDispatcher {
    dispatch(method: string, params: Record<string, unknown>, client: ClientIdentity): Promise<RpcResult>;
    subscribe(listener: (event: AgentEvent) => void): () => void;
}

interface ConnectionState {
    identity: ClientIdentity | null;
    challenge: { clientId: string; clientNonce: string; serverNonce: string; expiresAt: number } | null;
    subscriptions: Map<string, string>;
    pending: number;
    queuedBytes: number;
}

export interface AgentTransport {
    server: Server;
    connectionCount(): number;
    lastActivityAt(): number;
    close(): Promise<void>;
}

const helloSchema = z.object({ protocolVersion: z.literal(1), clientId: z.string().min(1).max(256),
    clientVersion: z.string().max(128).optional(), capabilities: z.array(z.string().max(128)).max(100).optional(),
    channel: z.enum(['control', 'events']), credentialRef: z.string().max(4096).optional(),
    clientNonce: z.string().min(16).max(256) }).strict();
const authenticateSchema = z.object({ clientId: z.string().min(1).max(256), authProof: z.string().max(256) }).strict();

export async function listenAgentTransport(options: {
    authority: RuntimeAuthority;
    descriptor: ServerDescriptor;
    runtime: RuntimeDispatcher;
    onShutdown: () => void;
}): Promise<AgentTransport> {
    const connections = new Map<Socket, ConnectionState>();
    let closing = false;
    let lastActivityAt = performance.now();

    const write = (socket: Socket, state: ConnectionState, message: unknown): void => {
        if (socket.destroyed || !socket.writable) return;
        const line = JSON.stringify(message) + '\n';
        const bytes = Buffer.byteLength(line);
        if (bytes > MAX_FRAME_BYTES || state.queuedBytes + bytes > MAX_FRAME_BYTES * 4) {
            socket.destroy();
            return;
        }
        state.queuedBytes += bytes;
        socket.write(line, () => { state.queuedBytes = Math.max(0, state.queuedBytes - bytes); });
    };

    const stopEvents = options.runtime.subscribe(event => {
        for (const [socket, state] of connections) {
            if (!state.identity) continue;
            for (const [subscriptionId, conversationId] of state.subscriptions) {
                if (event.conversationId === conversationId) write(socket, state, { jsonrpc: '2.0',
                    method: 'events.notification', params: { subscriptionId, event } });
            }
        }
    });

    const server = createServer(socket => {
        if (closing || connections.size >= 128) { socket.destroy(); return; }
        socket.setEncoding('utf8');
        const state: ConnectionState = { identity: null, challenge: null, subscriptions: new Map(), pending: 0, queuedBytes: 0 };
        connections.set(socket, state);
        const authenticationTimeout = setTimeout(() => { if (!state.identity) socket.destroy(); }, 60_000);
        authenticationTimeout.unref();
        let buffer = '';

        const dispatch = async (line: string): Promise<void> => {
            let request;
            try { request = rpcRequestSchema.parse(JSON.parse(line)); }
            catch {
                write(socket, state, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效JSON-RPC请求' } });
                return;
            }
            if (state.pending >= 16) {
                write(socket, state, { jsonrpc: '2.0', id: request.id, result: failure(new AgentFault('TOO_MANY_REQUESTS', '本连接在途调用已满', undefined, false, true)) });
                return;
            }
            state.pending += 1;
            let result: RpcResult;
            try {
                if (request.method === 'server.hello') {
                    if (state.identity) throw new AgentFault('INVALID_STATE', '当前连接已经认证');
                    const input = helloSchema.parse(request.params ?? {});
                    const serverNonce = randomBytes(32).toString('base64');
                    state.challenge = { clientId: input.clientId, clientNonce: input.clientNonce, serverNonce, expiresAt: Date.now() + 60_000 };
                    result = { ok: true, data: { protocolVersion: PROTOCOL_VERSION, serverVersion: options.descriptor.serverVersion,
                        serverInstanceId: options.descriptor.serverInstanceId, serverNonce,
                        principalId: options.authority.principalId, capabilities: ['control', 'events.read', 'events.subscribe'],
                        limits: { maxFrameBytes: MAX_FRAME_BYTES, maxInFlight: 16 } } };
                } else if (request.method === 'server.authenticate') {
                    const input = authenticateSchema.parse(request.params ?? {});
                    const challenge = state.challenge;
                    state.challenge = null;
                    if (!challenge || challenge.clientId !== input.clientId || challenge.expiresAt < Date.now() || state.identity) {
                        throw new AgentFault('AUTHENTICATION_REQUIRED', '认证挑战已过期或已使用');
                    }
                    const expected = createHmac('sha256', options.authority.secret)
                        .update(handshakePayload(challenge.clientNonce, challenge.serverNonce, challenge.clientId)).digest();
                    const proof = Buffer.from(input.authProof, 'base64');
                    if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
                        throw new AgentFault('AUTHENTICATION_FAILED', '控制凭据认证失败');
                    }
                    state.identity = { principalId: options.authority.principalId, clientId: input.clientId };
                    clearTimeout(authenticationTimeout);
                    result = { ok: true, data: { authenticated: true, principalId: state.identity.principalId, clientId: state.identity.clientId } };
                } else {
                    if (!state.identity) throw new AgentFault('AUTHENTICATION_REQUIRED', '请先完成本机控制认证');
                    const params = validateParams(request.method, request.params ?? {});
                    lastActivityAt = performance.now();
                    if (request.method === 'events.subscribe') {
                        const subscribed = await options.runtime.dispatch('events.subscribe', params, state.identity);
                        if (!subscribed.ok) result = subscribed;
                        else {
                            const data = subscribed.data as { subscriptionId: string; [key: string]: unknown };
                            const subscriptionId = data.subscriptionId;
                            state.subscriptions.set(subscriptionId, params.conversationId as string);
                            const snapshot = await options.runtime.dispatch('events.read', { conversationId: params.conversationId,
                                ...(params.afterCursor !== undefined ? { afterCursor: params.afterCursor } : {}) }, state.identity);
                            if (!snapshot.ok || socket.destroyed) {
                                state.subscriptions.delete(subscriptionId);
                                await options.runtime.dispatch('events.unsubscribe', { subscriptionId }, state.identity);
                                result = snapshot.ok ? failure(new AgentFault('IPC_UNAVAILABLE', '事件连接已断开')) : snapshot;
                            } else result = { ok: true, data: { ...data, snapshot: snapshot.data }, eventCursor: snapshot.eventCursor };
                        }
                    } else if (request.method === 'events.unsubscribe') {
                        result = await options.runtime.dispatch('events.unsubscribe', params, state.identity);
                        if (result.ok) state.subscriptions.delete(params.subscriptionId as string);
                    } else {
                        const caller = request.method === 'conversations.create' ? { ...state.identity,
                            ...(typeof params.callerHost === 'string' ? { callerHost: params.callerHost } : {}),
                            ...(params.callerConversationId === null || typeof params.callerConversationId === 'string'
                                ? { callerConversationId: params.callerConversationId } : {}) } : state.identity;
                        result = await options.runtime.dispatch(request.method, params, caller);
                    }
                }
            } catch (error) {
                result = error instanceof z.ZodError ? failure(new AgentFault('INVALID_PARAMS', '握手参数不符合协议')) : failure(error);
            } finally {
                state.pending -= 1;
            }
            write(socket, state, { jsonrpc: '2.0', id: request.id, result });
            if (request.method === 'server.shutdown' && result.ok) setImmediate(options.onShutdown);
        };

        socket.on('data', (chunk: string) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { socket.destroy(); return; }
                if (line.trim()) void dispatch(line);
            }
            if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
        });
        socket.once('close', () => {
            clearTimeout(authenticationTimeout);
            const identity = state.identity;
            const subscriptionIds = [...state.subscriptions.keys()];
            state.subscriptions.clear();
            connections.delete(socket);
            if (identity) for (const subscriptionId of subscriptionIds) {
                void options.runtime.dispatch('events.unsubscribe', { subscriptionId }, identity).catch(() => {});
            }
        });
        socket.on('error', () => {});
    });

    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen({ path: options.authority.endpoint, readableAll: false, writableAll: false }, () => {
            server.removeListener('error', rejectListen);
            resolveListen();
        });
    });
    server.on('error', () => {});

    return {
        server,
        connectionCount: () => connections.size,
        lastActivityAt: () => lastActivityAt,
        close: async () => {
            if (closing) return;
            closing = true;
            stopEvents();
            await new Promise<void>(resolveClose => {
                const timeout = setTimeout(() => { for (const socket of connections.keys()) socket.destroy(); }, 1000);
                timeout.unref();
                server.close(() => { clearTimeout(timeout); resolveClose(); });
                for (const socket of connections.keys()) socket.end();
            });
        },
    };
}

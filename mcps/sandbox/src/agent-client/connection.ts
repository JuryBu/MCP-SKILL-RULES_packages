import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import { AgentFault, MAX_FRAME_BYTES, type RpcRequest, type RpcResult } from '../agent-server/protocol.js';

export interface RpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}

interface PendingRequest {
    resolve: (result: RpcResult) => void;
    reject: (error: AgentFault) => void;
    timer: NodeJS.Timeout;
    writes: boolean;
    method: string;
    clientCommandId?: string;
}

export interface RequestOptions {
    timeoutMs?: number;
    writes?: boolean;
    id?: string | number;
}

export class RpcConnection extends EventEmitter {
    private socket: Socket | null = null;
    private readonly pending = new Map<string | number, PendingRequest>();
    private fragments: Buffer[] = [];
    private frameBytes = 0;
    private closed = true;
    private readonly decoder = new TextDecoder('utf-8', { fatal: true });

    constructor(readonly endpoint: string, readonly defaultTimeoutMs = 3_000) {
        super();
    }

    get connected(): boolean {
        return !this.closed && this.socket !== null && !this.socket.destroyed;
    }

    async open(timeoutMs = 10_000): Promise<void> {
        if (this.connected) return;
        const socket = createConnection(this.endpoint);
        this.socket = socket;
        this.closed = false;
        socket.setNoDelay(true);
        socket.on('data', chunk => this.receive(chunk));
        socket.on('close', () => this.fail(new AgentFault('IPC_UNAVAILABLE', '控制连接已断开')));
        socket.on('error', error => this.fail(new AgentFault('IPC_UNAVAILABLE', '连接Agent Server失败', {
            sourceError: error.message,
        })));
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                removeListeners();
                socket.destroy();
                reject(new AgentFault('IPC_UNAVAILABLE', '连接Agent Server超时', { timeoutMs }));
            }, timeoutMs);
            const onConnect = () => {
                clearTimeout(timer);
                removeListeners();
                resolve();
            };
            const onError = (error: Error) => {
                clearTimeout(timer);
                removeListeners();
                reject(new AgentFault('IPC_UNAVAILABLE', '连接Agent Server失败', { sourceError: error.message }));
            };
            const onClose = () => onError(new Error('连接在建立前关闭'));
            const removeListeners = () => {
                socket.removeListener('connect', onConnect);
                socket.removeListener('error', onError);
                socket.removeListener('close', onClose);
            };
            socket.once('connect', onConnect);
            socket.once('error', onError);
            socket.once('close', onClose);
        });
    }

    async request<Data = unknown>(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<RpcResult<Data>> {
        if (!this.connected || !this.socket) throw new AgentFault('IPC_UNAVAILABLE', '控制连接尚未建立');
        const id = options.id ?? randomUUID();
        if (this.pending.has(id)) throw new AgentFault('INVALID_PARAMS', '传输请求ID正在使用');
        const request: RpcRequest = { jsonrpc: '2.0', id, method, params };
        let frame: Buffer;
        try {
            frame = Buffer.from(JSON.stringify(request), 'utf8');
        } catch {
            throw new AgentFault('INVALID_PARAMS', '请求参数必须为JSON兼容值');
        }
        if (frame.length > MAX_FRAME_BYTES) throw new AgentFault('FRAME_TOO_LARGE', '控制请求超过单帧上限', {
            maxBytes: MAX_FRAME_BYTES, actualBytes: frame.length,
        });
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AgentFault('INVALID_PARAMS', '请求等待时间必须为正整数毫秒');
        return new Promise<RpcResult<Data>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AgentFault(options.writes ? 'RECEIPT_UNKNOWN' : 'IPC_TIMEOUT',
                    options.writes ? '写命令回执尚未确认，请按原命令ID查询' : '读取请求等待超时', {
                        method, timeoutMs, ...(typeof params.clientCommandId === 'string' ? { clientCommandId: params.clientCommandId } : {}),
                    }, options.writes === true, true));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: result => resolve(result as RpcResult<Data>), reject, timer,
                writes: options.writes === true, method,
                ...(typeof params.clientCommandId === 'string' ? { clientCommandId: params.clientCommandId } : {}),
            });
            this.socket!.write(Buffer.concat([frame, Buffer.from('\n')]), error => {
                if (error) this.fail(new AgentFault('IPC_UNAVAILABLE', '控制请求发送失败', { sourceError: error.message }));
            });
        });
    }

    close(): void {
        this.fail(new AgentFault('IPC_UNAVAILABLE', '客户端已断开控制连接'));
    }

    private receive(chunk: Buffer): void {
        if (this.closed) return;
        let offset = 0;
        while (offset < chunk.length && !this.closed) {
            const newline = chunk.indexOf(10, offset);
            const end = newline === -1 ? chunk.length : newline;
            const part = chunk.subarray(offset, end);
            if (this.frameBytes + part.length > MAX_FRAME_BYTES) {
                this.fail(new AgentFault('FRAME_TOO_LARGE', 'Agent Server响应超过单帧上限', { maxBytes: MAX_FRAME_BYTES }));
                return;
            }
            if (part.length > 0) {
                this.fragments.push(part);
                this.frameBytes += part.length;
            }
            if (newline === -1) return;
            const frame = Buffer.concat(this.fragments, this.frameBytes);
            this.fragments = [];
            this.frameBytes = 0;
            if (frame.length > 0) this.receiveFrame(frame);
            offset = newline + 1;
        }
    }

    private receiveFrame(frame: Buffer): void {
        let message: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(this.decoder.decode(frame));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('响应须为对象');
            message = parsed as Record<string, unknown>;
            if (message.jsonrpc !== '2.0') throw new Error('JSON-RPC版本不匹配');
        } catch (error) {
            this.fail(new AgentFault('PROTOCOL_MISMATCH', 'Agent Server返回了无效的UTF-8 JSON-RPC帧', {
                sourceError: error instanceof Error ? error.message : String(error),
            }));
            return;
        }
        if (!Object.hasOwn(message, 'id')) {
            if (typeof message.method === 'string') this.emit('notification', message as unknown as RpcNotification);
            return;
        }
        if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        const result = message.result;
        if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as RpcResult).ok === 'boolean') {
            pending.resolve(result as RpcResult);
        } else if (message.error && typeof message.error === 'object') {
            const rpcError = message.error as Record<string, unknown>;
            pending.resolve({ ok: false, error: {
                code: typeof rpcError.code === 'string' ? rpcError.code : `RPC_${String(rpcError.code)}`,
                message: typeof rpcError.message === 'string' ? rpcError.message : 'Agent Server拒绝了请求',
                mayHaveStarted: pending.writes, retryable: false,
                details: { rpcCode: rpcError.code, data: rpcError.data },
            } });
        } else {
            pending.reject(new AgentFault('PROTOCOL_MISMATCH', 'Agent Server响应缺少RpcResult', {
                method: pending.method,
            }, pending.writes));
        }
    }

    private fail(error: AgentFault): void {
        if (this.closed) return;
        this.closed = true;
        const socket = this.socket;
        this.socket = null;
        socket?.destroy();
        this.fragments = [];
        this.frameBytes = 0;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new AgentFault(pending.writes ? 'RECEIPT_UNKNOWN' : error.code,
                pending.writes ? '控制连接已断开，原写命令的执行状态待查' : error.message, {
                    ...error.details, method: pending.method,
                    ...(pending.clientCommandId ? { clientCommandId: pending.clientCommandId } : {}),
                }, pending.writes, true));
        }
        this.pending.clear();
        this.emit('disconnected', error);
    }
}

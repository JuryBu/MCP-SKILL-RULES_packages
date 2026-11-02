import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
    AgentFault, METHOD_SPECS, PROTOCOL_VERSION, SERVER_VERSION, handshakePayload, operationHash,
    type RpcResult, type ServerDescriptor,
} from '../agent-server/protocol.js';
import { RpcConnection, type RpcNotification } from './connection.js';
import { AppliedEventCursor, type EventPage } from './events.js';
import { getOrCreateClientId } from './identity.js';
import { defaultDataDir } from '../agent-server/discovery.js';
import { readArtifactBytes, type ArtifactData, type ArtifactReadOptions } from './artifacts.js';

const MAX_TRACKED_COMMANDS = 1024;

export interface AgentClientOptions {
    dataDir?: string;
    clientId?: string;
    clientName?: string;
    clientVersion?: string;
    serverEntry?: string;
    startupTimeoutMs?: number;
    requestTimeoutMs?: number;
    connectionTimeoutMs?: number;
    deadlineAt?: string;
    descriptor?: ServerDescriptor;
}

export interface AgentRequestOptions {
    timeoutMs?: number;
    clientCommandId?: string;
    acquireControl?: boolean;
    recoverReceipt?: boolean;
}

export interface ControlLease {
    scope: 'server' | 'conversation';
    conversationId?: string;
    controlLeaseId: string;
    controlEpoch: number;
    expiresAt?: string;
}

interface CommandRecord {
    hash: string;
    method: string;
    conversationId?: string;
    controlScope?: 'server' | 'conversation';
    clientCommandId: string;
    promise?: Promise<RpcResult>;
    result?: RpcResult;
    uncertain: boolean;
    submitted: boolean;
    serverInstanceId?: string;
}

export function clientFailure(error: unknown, mayHaveStarted = false): RpcResult {
    if (error instanceof AgentFault) return { ok: false, error: error.toJSON() };
    return { ok: false, error: {
        code: 'IPC_UNAVAILABLE', message: error instanceof Error ? error.message : 'Agent客户端操作失败',
        retryable: false, mayHaveStarted,
    } };
}

export class AgentClient extends EventEmitter {
    readonly dataDir: string;
    readonly eventCursor = new AppliedEventCursor();
    clientId: string;
    private server: ServerDescriptor | null;
    private control: RpcConnection | null = null;
    private eventConnection: RpcConnection | null = null;
    private opening: Promise<void> | null = null;
    private eventOpening: Promise<RpcConnection> | null = null;
    private disposed = false;
    private renewalTimer: NodeJS.Timeout | null = null;
    private renewalInFlight = false;
    private readonly leases = new Map<string, ControlLease>();
    private readonly commands = new Map<string, CommandRecord>();
    private readonly connections = new Set<RpcConnection>();

    constructor(readonly options: AgentClientOptions = {}) {
        super();
        this.dataDir = resolve(options.dataDir ?? defaultDataDir());
        this.clientId = options.clientId ?? '';
        this.server = options.descriptor ?? null;
    }

    static async connect(options: AgentClientOptions = {}): Promise<AgentClient> {
        const client = new AgentClient(options);
        try {
            await client.connect();
            return client;
        } catch (error) {
            await client.close();
            throw error;
        }
    }

    get descriptor(): ServerDescriptor | null {
        return this.server;
    }

    get connected(): boolean {
        return this.control?.connected === true;
    }

    async connect(): Promise<this> {
        if (this.disposed) throw new AgentFault('IPC_UNAVAILABLE', '客户端已经关闭');
        if (this.connected) return this;
        if (!this.opening) {
            this.opening = this.openControl().finally(() => { this.opening = null; });
        }
        await this.opening;
        return this;
    }

    async reconnect(): Promise<this> {
        this.control?.close();
        this.control = null;
        this.eventConnection?.close();
        this.eventConnection = null;
        return this.connect();
    }

    async request<Data = unknown>(method: string, params: Record<string, unknown> = {}, options: AgentRequestOptions = {}): Promise<RpcResult<Data>> {
        const methodSpec = METHOD_SPECS[method];
        if (!methodSpec) return clientFailure(new AgentFault('METHOD_NOT_AVAILABLE', '该控制方法尚未安装', { method })) as RpcResult<Data>;
        if (!methodSpec.writes) {
            const parsed = methodSpec.schema.safeParse(params);
            if (!parsed.success) return this.invalidParams(method, parsed.error.issues) as RpcResult<Data>;
            for (let attempt = 0; ; attempt++) {
                try {
                    this.remainingTimeout(this.options.connectionTimeoutMs ?? 10_000);
                    await this.connect();
                    const timeoutMs = this.remainingTimeout(options.timeoutMs ?? (method === 'events.read' && typeof parsed.data.waitMs === 'number'
                        ? Math.max(this.options.requestTimeoutMs ?? 3_000, parsed.data.waitMs + 3_000) : this.options.requestTimeoutMs ?? 3_000));
                    return await this.control!.request<Data>(method, parsed.data as Record<string, unknown>, { timeoutMs });
                } catch (error) {
                    if (attempt > 0 || this.disposed || this.connected || !(error instanceof AgentFault) || error.code !== 'IPC_UNAVAILABLE') {
                        return clientFailure(error) as RpcResult<Data>;
                    }
                    try { await delay(this.remainingTimeout(25 + Math.floor(Math.random() * 75))); }
                    catch (expired) { return clientFailure(expired) as RpcResult<Data>; }
                }
            }
        }
        const temporaryCreate = method === 'conversations.create' && params.retention !== null && typeof params.retention === 'object'
            && (params.retention as { mode?: unknown }).mode === 'temporary';
        if (temporaryCreate && options.clientCommandId === undefined && params.clientCommandId === undefined) {
            const prepared = await this.request<{ clientCommandId: string; expiresAt: string }>('conversations.prepareTemporaryCreate');
            if (!prepared.ok) return prepared as RpcResult<Data>;
            if (typeof prepared.data?.clientCommandId !== 'string' || typeof prepared.data.expiresAt !== 'string') {
                return clientFailure(new AgentFault('PROTOCOL_MISMATCH', '临时新建准备结果缺少服务端命令号或期限')) as RpcResult<Data>;
            }
            options = { ...options, clientCommandId: prepared.data.clientCommandId };
        }
        const clientCommandId = options.clientCommandId ?? (typeof params.clientCommandId === 'string' ? params.clientCommandId : randomUUID());
        if (typeof params.clientCommandId === 'string' && params.clientCommandId !== clientCommandId) {
            return clientFailure(new AgentFault('COMMAND_CONFLICT', '命令参数和选项中的命令ID不同')) as RpcResult<Data>;
        }
        const preliminary = methodSpec.schema.safeParse({ ...params, clientCommandId });
        if (!preliminary.success) return this.invalidParams(method, preliminary.error.issues) as RpcResult<Data>;
        const businessParams = preliminary.data as Record<string, unknown>;
        let hash: string;
        try {
            hash = operationHash(method, businessParams);
        } catch (error) {
            return clientFailure(error) as RpcResult<Data>;
        }
        const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
        const commandKey = `${conversationId ?? 'server'}\0${clientCommandId}`;
        const previous = this.commands.get(commandKey);
        if (previous) {
            if (previous.hash !== hash) return clientFailure(new AgentFault('COMMAND_CONFLICT', '同一命令ID已用于不同的方法或参数', { clientCommandId })) as RpcResult<Data>;
            if (previous.promise) return previous.promise as Promise<RpcResult<Data>>;
            if (previous.uncertain) return this.recoverCommand(previous) as Promise<RpcResult<Data>>;
            return previous.result as RpcResult<Data>;
        }
        this.trimCommandCache(MAX_TRACKED_COMMANDS - 1);
        if (this.commands.size >= MAX_TRACKED_COMMANDS) return clientFailure(new AgentFault('BACKPRESSURE', '未确认命令达到客户端保留上限，请先查询原回执', {
            maxTrackedCommands: MAX_TRACKED_COMMANDS,
        }, false, true)) as RpcResult<Data>;
        const record: CommandRecord = { hash, method, conversationId, clientCommandId, uncertain: false, submitted: false,
            ...(businessParams.scope === 'server' || businessParams.scope === 'conversation' ? { controlScope: businessParams.scope } : {}) };
        this.commands.set(commandKey, record);
        record.promise = this.sendCommand(record, businessParams, options).then(result => {
            record.promise = undefined;
            record.result = result;
            record.uncertain = result.error?.mayHaveStarted === true && !result.receiptId;
            if (!record.submitted) this.commands.delete(commandKey);
            this.trimCommandCache();
            return result;
        });
        return record.promise as Promise<RpcResult<Data>>;
    }

    async getReceipt<Data = unknown>(targetClientCommandId: string, conversationId?: string): Promise<RpcResult<Data>> {
        return this.request<Data>('server.getReceipt', {
            targetClientCommandId, ...(conversationId !== undefined ? { conversationId } : {}),
        });
    }

    async claimControl(scope: 'server' | 'conversation', conversationId?: string, takeover = false): Promise<RpcResult<ControlLease>> {
        return this.request<ControlLease>('server.claimControl', {
            scope, ...(conversationId !== undefined ? { conversationId } : {}), takeover,
        }, { acquireControl: false });
    }

    getControlLease(scope: 'server' | 'conversation', conversationId?: string): ControlLease | undefined {
        const lease = this.leases.get(this.leaseKey(scope, conversationId));
        if (lease && (!lease.expiresAt || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now())) {
            this.invalidateLease(scope, conversationId, 'CONTROL_EXPIRED', lease);
            return undefined;
        }
        return lease ? { ...lease } : undefined;
    }

    async renewControl(scope: 'server' | 'conversation', conversationId?: string): Promise<RpcResult<ControlLease>> {
        const lease = this.getControlLease(scope, conversationId);
        if (!lease) return clientFailure(new AgentFault('CONTROL_REQUIRED', '客户端没有可续期的控制租约')) as RpcResult<ControlLease>;
        return this.request<ControlLease>('server.renewControl', {
            scope, ...(conversationId ? { conversationId } : {}), controlLeaseId: lease.controlLeaseId, controlEpoch: lease.controlEpoch,
        }, { acquireControl: false });
    }

    async releaseControl(scope: 'server' | 'conversation', conversationId?: string): Promise<RpcResult> {
        const lease = this.getControlLease(scope, conversationId);
        if (!lease) return clientFailure(new AgentFault('CONTROL_REQUIRED', '客户端没有可释放的控制租约'));
        const result = await this.request('server.releaseControl', {
            scope, ...(conversationId ? { conversationId } : {}), controlLeaseId: lease.controlLeaseId, controlEpoch: lease.controlEpoch,
        }, { acquireControl: false });
        if (result.ok) { this.leases.delete(this.leaseKey(scope, conversationId)); this.stopUnusedRenewal(); }
        return result;
    }

    startControlRenewal(intervalMs = 30_000): void {
        if (this.renewalTimer) return;
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new AgentFault('INVALID_PARAMS', '控制续期周期须至少为1000毫秒');
        this.renewalTimer = setInterval(() => {
            if (this.renewalInFlight || this.disposed || this.leases.size === 0) return;
            this.renewalInFlight = true;
            void Promise.all([...this.leases.values()].map(async lease => {
                const result = await this.renewControl(lease.scope, lease.conversationId);
                if (!result.ok) this.invalidateLease(lease.scope, lease.conversationId, result.error?.code ?? 'CONTROL_REQUIRED', lease);
            })).finally(() => { this.renewalInFlight = false; });
        }, intervalMs);
        this.renewalTimer.unref();
    }

    async readEvents(conversationId: string, options: { afterCursor?: string; limit?: number; maxBytes?: number; waitMs?: number } = {}): Promise<RpcResult<EventPage>> {
        const afterCursor = options.afterCursor ?? this.eventCursor.get(conversationId);
        return this.request<EventPage>('events.read', {
            conversationId, ...options, ...(afterCursor !== undefined ? { afterCursor } : {}),
        }, { timeoutMs: Math.max(this.options.requestTimeoutMs ?? 3_000, (options.waitMs ?? 0) + 3_000) });
    }

    async readArtifact(conversationId: string, artifactId: string, options: ArtifactReadOptions = {}): Promise<RpcResult<ArtifactData>> {
        try { return { ok: true, data: await readArtifactBytes(this, conversationId, artifactId, options) }; }
        catch (error) { return clientFailure(error) as RpcResult<ArtifactData>; }
    }

    async ackEvents(conversationId: string, appliedCursor: string, subscriptionId?: string): Promise<RpcResult> {
        return this.request('events.ack', {
            conversationId, appliedCursor, clientId: this.clientId, ...(subscriptionId ? { subscriptionId } : {}),
        });
    }

    async subscribeEvents(conversationId: string, afterCursor?: string): Promise<RpcResult> {
        try {
            if (this.disposed) throw new AgentFault('IPC_UNAVAILABLE', '客户端已经关闭');
            this.remainingTimeout(this.options.connectionTimeoutMs ?? 10_000);
            await this.connect();
            if (!this.eventConnection?.connected) {
                if (!this.eventOpening) this.eventOpening = this.openAuthenticated('events').finally(() => { this.eventOpening = null; });
                const serverInstanceId = this.server?.serverInstanceId;
                const connection = await this.eventOpening;
                if (serverInstanceId !== this.server?.serverInstanceId) {
                    connection.close();
                    throw new AgentFault('IPC_UNAVAILABLE', '核心实例已变化，请按原游标恢复观察');
                }
                this.eventConnection = connection;
            }
            if (this.disposed) throw new AgentFault('IPC_UNAVAILABLE', '客户端已经关闭');
            const cursor = afterCursor ?? this.eventCursor.get(conversationId);
            return await this.eventConnection.request('events.subscribe', {
                conversationId, ...(cursor !== undefined ? { afterCursor: cursor } : {}),
            }, { timeoutMs: this.remainingTimeout(this.options.requestTimeoutMs ?? 3_000) });
        } catch (error) {
            return clientFailure(error);
        }
    }

    async unsubscribeEvents(subscriptionId: string): Promise<RpcResult> {
        if (!this.eventConnection?.connected) return clientFailure(new AgentFault('IPC_UNAVAILABLE', '事件连接已断开'));
        try {
            return await this.eventConnection.request('events.unsubscribe', { subscriptionId },
                { timeoutMs: this.remainingTimeout(this.options.requestTimeoutMs ?? 3_000) });
        } catch (error) {
            return clientFailure(error);
        }
    }

    async close(): Promise<void> {
        this.disposed = true;
        if (this.renewalTimer) clearInterval(this.renewalTimer);
        this.renewalTimer = null;
        this.control?.close();
        this.eventConnection?.close();
        for (const connection of this.connections) connection.close();
        this.connections.clear();
        this.control = null;
        this.eventConnection = null;
        this.leases.clear();
        this.commands.clear();
    }

    private async openControl(): Promise<void> {
        const previousInstanceId = this.server?.serverInstanceId;
        if (!this.options.descriptor || !this.server) {
            const discovery = await import('../agent-server/discovery.js');
            this.server = await discovery.ensureAgentServer({
                dataDir: this.dataDir, ...(this.options.serverEntry ? { serverEntry: this.options.serverEntry } : {}),
                startupTimeoutMs: this.remainingTimeout(this.options.startupTimeoutMs ?? 10_000),
                ...(this.options.deadlineAt ? { deadlineAt: this.options.deadlineAt } : {}),
            });
        }
        if (this.disposed) throw new AgentFault('IPC_UNAVAILABLE', '客户端在服务发现期间已关闭');
        if (!this.clientId) this.clientId = await getOrCreateClientId(this.dataDir, this.options.clientName ?? 'cli');
        if (this.disposed) throw new AgentFault('IPC_UNAVAILABLE', '客户端已经关闭');
        const descriptor = this.server;
        if (descriptor.protocolVersion !== PROTOCOL_VERSION) throw new AgentFault('PROTOCOL_MISMATCH', 'Agent Server主协议版本不兼容');
        const descriptorDataDir = resolve(descriptor.dataDir);
        const sameDataDir = process.platform === 'win32' ? descriptorDataDir.toLowerCase() === this.dataDir.toLowerCase() : descriptorDataDir === this.dataDir;
        if (!sameDataDir) throw new AgentFault('AUTH_FAILED', '发现描述的数据目录与客户端目录不同');
        if (process.platform === 'win32' ? !descriptor.endpoint.startsWith('\\\\.\\pipe\\') : !isAbsolute(descriptor.endpoint)) {
            throw new AgentFault('IPC_UNAVAILABLE', 'Agent Server端点须为本机命名管道或Unix socket');
        }
        if (previousInstanceId && previousInstanceId !== descriptor.serverInstanceId) {
            this.eventConnection?.close();
            this.eventConnection = null;
            for (const lease of [...this.leases.values()]) this.invalidateLease(lease.scope, lease.conversationId, 'SERVER_RESTARTED', lease);
            this.emit('eventsDisconnected', new AgentFault('IPC_UNAVAILABLE', '核心实例已重启，保留原任务与事件游标'));
        }
        const connection = await this.openAuthenticated('control');
        if (this.disposed) {
            connection.close();
            throw new AgentFault('IPC_UNAVAILABLE', '客户端在认证期间已关闭');
        }
        this.control = connection;
    }

    private async openAuthenticated(channel: 'control' | 'events'): Promise<RpcConnection> {
        const descriptor = this.server!;
        const connection = new RpcConnection(descriptor.endpoint, this.options.requestTimeoutMs ?? 3_000);
        this.connections.add(connection);
        connection.on('disconnected', error => {
            this.connections.delete(connection);
            if (this.server?.serverInstanceId !== descriptor.serverInstanceId) return;
            const current = channel === 'events' ? this.eventConnection : this.control;
            if (current && current !== connection) return;
            this.emit(channel === 'events' ? 'eventsDisconnected' : 'disconnected', error);
        });
        connection.on('notification', (notification: RpcNotification) => {
            if (this.server?.serverInstanceId === descriptor.serverInstanceId) this.emit('notification', notification);
        });
        try {
            await connection.open(this.remainingTimeout(this.options.connectionTimeoutMs ?? 10_000));
            const clientNonce = randomBytes(32).toString('base64');
            const hello = await connection.request<Record<string, unknown>>('server.hello', {
                protocolVersion: PROTOCOL_VERSION, clientId: this.clientId, clientVersion: this.options.clientVersion ?? SERVER_VERSION,
                capabilities: [], channel, credentialRef: descriptor.credentialRef, clientNonce,
            }, { timeoutMs: this.remainingTimeout(this.options.requestTimeoutMs ?? 3_000) });
            if (!hello.ok) throw this.resultFault(hello);
            if (typeof hello.data?.serverNonce !== 'string' || hello.data.serverNonce.length === 0) throw new AgentFault('PROTOCOL_MISMATCH', '握手响应缺少服务端挑战');
            if (hello.data.protocolVersion !== undefined && hello.data.protocolVersion !== PROTOCOL_VERSION) throw new AgentFault('PROTOCOL_MISMATCH', '握手主协议版本不兼容');
            if (hello.data.serverInstanceId !== undefined && hello.data.serverInstanceId !== descriptor.serverInstanceId) throw new AgentFault('AUTH_FAILED', '握手实例与发现描述不同');
            if (hello.data.principalId !== undefined && hello.data.principalId !== descriptor.principalId) throw new AgentFault('AUTH_FAILED', '握手主体与发现描述不同');
            const secret = await this.readControlKey();
            let authProof: string;
            try {
                authProof = createHmac('sha256', secret).update(handshakePayload(clientNonce, hello.data.serverNonce, this.clientId), 'utf8').digest('base64');
            } finally {
                secret.fill(0);
            }
            const authenticated = await connection.request<Record<string, unknown>>('server.authenticate', { clientId: this.clientId, authProof },
                { timeoutMs: this.remainingTimeout(this.options.requestTimeoutMs ?? 3_000) });
            if (!authenticated.ok) throw this.resultFault(authenticated);
            if (authenticated.data?.authenticated !== true || authenticated.data.clientId !== this.clientId
                || authenticated.data.principalId !== descriptor.principalId) throw new AgentFault('AUTH_FAILED', '认证回执未确认当前客户端和主体');
            if (this.disposed || this.server?.serverInstanceId !== descriptor.serverInstanceId) {
                throw new AgentFault('IPC_UNAVAILABLE', '客户端已关闭或核心实例已变化');
            }
            return connection;
        } catch (error) {
            connection.close();
            throw error;
        }
    }

    private async readControlKey(): Promise<Buffer> {
        let file;
        try {
            file = await open(join(this.dataDir, 'runtime', 'control.key'), 'r');
            const buffer = Buffer.alloc(256);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead === buffer.length) throw new Error('控制凭据长度异常');
            const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
            if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new Error('控制凭据格式异常');
            const secret = Buffer.from(text, 'base64');
            buffer.fill(0);
            if (secret.length !== 32) throw new Error('控制凭据长度异常');
            return secret;
        } catch {
            throw new AgentFault('AUTH_FAILED', '无法读取该数据目录的有效控制凭据');
        } finally {
            await file?.close();
        }
    }

    private async sendCommand(record: CommandRecord, params: Record<string, unknown>, options: AgentRequestOptions): Promise<RpcResult> {
        let sent = false;
        try {
            const spec = METHOD_SPECS[record.method];
            const preliminary = spec.schema.safeParse(params);
            if (!preliminary.success) return this.invalidParams(record.method, preliminary.error.issues);
            await this.connect();
            const outgoing = { ...preliminary.data } as Record<string, unknown>;
            if (spec.scope !== 'none' && options.acquireControl !== false && outgoing.controlLeaseId === undefined) {
                let lease = this.getControlLease(spec.scope, record.conversationId);
                if (!lease) {
                    const claimed = await this.claimControl(spec.scope, record.conversationId);
                    if (!claimed.ok) return { ok: false, error: {
                        code: claimed.error?.code ?? 'CONTROL_REQUIRED', message: claimed.error?.message ?? '控制申请尚未成功，业务命令尚未提交',
                        retryable: claimed.error?.retryable ?? false, mayHaveStarted: false,
                        details: { ...claimed.error?.details, clientCommandId: record.clientCommandId,
                            controlClientCommandId: claimed.error?.details?.clientCommandId, controlReceiptId: claimed.receiptId,
                            operationPhase: 'claim_control', controlMayHaveStarted: claimed.error?.mayHaveStarted ?? false },
                    } };
                    lease = this.getControlLease(spec.scope, record.conversationId);
                }
                if (!lease) return clientFailure(new AgentFault('PROTOCOL_MISMATCH', '控制申请回执缺少租约字段'));
                outgoing.controlLeaseId = lease.controlLeaseId;
                outgoing.controlEpoch = lease.controlEpoch;
            }
            const timeoutMs = this.remainingTimeout(options.timeoutMs ?? this.options.requestTimeoutMs ?? 3_000);
            sent = true;
            record.submitted = true;
            record.serverInstanceId = this.server?.serverInstanceId;
            const result = await this.control!.request(record.method, outgoing, { writes: true, timeoutMs });
            if (result.ok && record.serverInstanceId === this.server?.serverInstanceId) this.captureLease(result.data, outgoing, record.method);
            else if (result.error && ['CONTROL_REQUIRED', 'CONTROL_CONFLICT'].includes(result.error.code)) {
                const scope = spec.scope !== 'none' ? spec.scope : outgoing.scope === 'server' ? 'server' : 'conversation';
                this.invalidateLease(scope, record.conversationId, result.error.code);
            }
            return result;
        } catch (error) {
            if (!sent || !(error instanceof AgentFault) || !error.mayHaveStarted) return clientFailure(error, sent);
            record.uncertain = true;
            if (options.recoverReceipt === false || this.disposed) return this.unknownReceipt(record, error.message);
            return this.recoverCommand(record);
        }
    }

    private async recoverCommand(record: CommandRecord): Promise<RpcResult> {
        if (this.disposed) return this.unknownReceipt(record, '客户端已关闭');
        const result = await this.getReceipt(record.clientCommandId, record.conversationId);
        if (!result.ok) return this.unknownReceipt(record, result.error?.message ?? '原回执暂不可取');
        const data = result.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            const receipt = data as Record<string, unknown>;
            const original = receipt.result;
            if (original && typeof original === 'object' && typeof (original as RpcResult).ok === 'boolean') {
                record.uncertain = false;
                record.result = original as RpcResult;
                if (record.result.ok) this.captureRecoveredLease(record);
                return original as RpcResult;
            }
            if (typeof receipt.ok === 'boolean') {
                record.uncertain = false;
                record.result = receipt as unknown as RpcResult;
                if (record.result.ok) this.captureRecoveredLease(record);
                return record.result;
            }
        }
        return this.unknownReceipt(record, '服务端尚无可确认的原命令回执');
    }

    private captureLease(data: unknown, params: Record<string, unknown>, method: string): void {
        if (method === 'conversations.close' && typeof params.conversationId === 'string') {
            this.leases.delete(this.leaseKey('conversation', params.conversationId)); this.stopUnusedRenewal(); return;
        }
        if (!['conversations.create', 'server.claimControl', 'server.renewControl', 'server.releaseControl'].includes(method)) return;
        if (method === 'server.releaseControl') {
            this.leases.delete(this.leaseKey(params.scope === 'server' ? 'server' : 'conversation', typeof params.conversationId === 'string' ? params.conversationId : undefined));
            this.stopUnusedRenewal(); return;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        const result = data as Record<string, unknown>;
        const conversationId = typeof result.conversationId === 'string' ? result.conversationId : typeof params.conversationId === 'string' ? params.conversationId : undefined;
        const scope = params.scope === 'server' ? 'server' : 'conversation';
        for (const candidate of [result, result.controlLease, result.lease, result.control]) {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
            const lease = candidate as Record<string, unknown>;
            if (typeof lease.controlLeaseId !== 'string' || typeof lease.controlEpoch !== 'number') continue;
            const current = this.leases.get(this.leaseKey(scope, conversationId));
            if (current && (lease.controlEpoch < current.controlEpoch || lease.controlEpoch === current.controlEpoch && lease.controlLeaseId === current.controlLeaseId
                && typeof lease.expiresAt === 'string' && current.expiresAt && Date.parse(lease.expiresAt) < Date.parse(current.expiresAt))) continue;
            this.leases.set(this.leaseKey(scope, conversationId), {
                scope, ...(conversationId ? { conversationId } : {}), controlLeaseId: lease.controlLeaseId, controlEpoch: lease.controlEpoch,
                ...(typeof lease.expiresAt === 'string' ? { expiresAt: lease.expiresAt } : {}),
            });
            this.startControlRenewal();
            break;
        }
    }

    private resultFault(result: RpcResult): AgentFault {
        return new AgentFault(result.error?.code ?? 'PROTOCOL_MISMATCH', result.error?.message ?? 'Agent Server响应失败',
            result.error?.details, result.error?.mayHaveStarted ?? false, result.error?.retryable ?? false);
    }

    private remainingTimeout(timeoutMs: number): number {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AgentFault('INVALID_PARAMS', '等待时间必须为正整数毫秒');
        if (this.options.deadlineAt === undefined) return timeoutMs;
        const deadline = Date.parse(this.options.deadlineAt);
        if (!Number.isFinite(deadline)) throw new AgentFault('INVALID_PARAMS', '调用期限格式无效');
        const remaining = Math.min(timeoutMs, Math.floor(deadline - Date.now()));
        if (remaining < 1) throw new AgentFault('IPC_TIMEOUT', '调用期限已到，保留原任务与命令回执');
        return remaining;
    }

    private invalidParams(method: string, issues: { path: (string | number)[]; message: string }[]): RpcResult {
        return clientFailure(new AgentFault('INVALID_PARAMS', '请求参数不符合方法定义', {
            method, fields: issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
        }));
    }

    private unknownReceipt(record: CommandRecord, reason: string): RpcResult {
        return clientFailure(new AgentFault('RECEIPT_UNKNOWN', '原写命令的回执待确认，请查询原命令，避免重复提交', {
            clientCommandId: record.clientCommandId, method: record.method,
            ...(record.conversationId ? { conversationId: record.conversationId } : {}), reason,
            recoveryMethod: 'server.getReceipt',
        }, true, true));
    }

    private leaseKey(scope: 'server' | 'conversation', conversationId?: string): string {
        return scope === 'server' ? 'server' : `conversation:${conversationId ?? ''}`;
    }

    private captureRecoveredLease(record: CommandRecord): void {
        if (record.serverInstanceId !== this.server?.serverInstanceId) return;
        const data = record.result?.data;
        const scope = record.controlScope ?? (data && typeof data === 'object' ? (data as Record<string, unknown>).scope : undefined);
        this.captureLease(data, { conversationId: record.conversationId, scope }, record.method);
    }

    private invalidateLease(scope: 'server' | 'conversation', conversationId: string | undefined, code: string, expected?: ControlLease): void {
        const key = this.leaseKey(scope, conversationId);
        const lease = this.leases.get(key);
        if (!lease || expected && (lease.controlLeaseId !== expected.controlLeaseId || lease.controlEpoch !== expected.controlEpoch)) return;
        this.leases.delete(key);
        const message = ['CONTROL_EXPIRED', 'CONTROL_REQUIRED', 'CONTROL_CONFLICT'].includes(code)
            ? '控制租约已失效，下次写入将正常申请；接管需要明确确认'
            : '控制租约续期尚未确认，已停止使用本地租约；下次写入重新申请';
        this.emit('controlLost', { lease, code, message });
        this.stopUnusedRenewal();
    }

    private stopUnusedRenewal(): void {
        if (!this.leases.size && this.renewalTimer) { clearInterval(this.renewalTimer); this.renewalTimer = null; }
    }

    private trimCommandCache(targetSize = MAX_TRACKED_COMMANDS): void {
        if (this.commands.size <= targetSize) return;
        for (const [key, record] of this.commands) {
            if (!record.promise && !record.uncertain) this.commands.delete(key);
            if (this.commands.size <= targetSize) return;
        }
    }
}

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentFault } from './protocol.js';
import type { ClientIdentity } from './protocol.js';

export const TEMPORARY_CREATE_COMMAND_MS = 5 * 60_000;
export const TEMPORARY_CLOSE_RECOVERY_MS = 5 * 60_000;
export const TEMPORARY_METADATA_SWEEP_MS = 30_000;

export interface TemporaryCreateCommand {
    clientCommandId: string;
    expiresAt: string;
}

export class TemporaryCreateCommands {
    private readonly instanceId = randomUUID();
    private readonly signingKey = randomBytes(32);
    private observedTime = -Infinity;

    observeTime(now: number): number {
        if (!Number.isSafeInteger(now)) throw new AgentFault('INVALID_PARAMS', '临时生命周期时钟无效');
        this.observedTime = Math.max(this.observedTime, now);
        return this.observedTime;
    }

    issue(client: ClientIdentity, now: number): TemporaryCreateCommand {
        const expiresAt = this.observeTime(now) + TEMPORARY_CREATE_COMMAND_MS;
        if (!Number.isSafeInteger(expiresAt)) throw new AgentFault('INVALID_PARAMS', '临时新建命令号的时钟无效');
        const payload = ['temporary-create-v1', this.instanceId, expiresAt.toString(36), randomBytes(16).toString('base64url')].join(':');
        return { clientCommandId: `${payload}:${this.signature(payload, client).toString('base64url')}`,
            expiresAt: new Date(expiresAt).toISOString() };
    }

    require(clientCommandId: string, client: ClientIdentity, now: number): number {
        const parts = clientCommandId.split(':');
        const recovery = { method: 'conversations.prepareTemporaryCreate', next: '明确新建临时会话时先取得命令号；状态未知时只查询原命令回执，保留原号。' };
        if (parts.length !== 5 || parts[0] !== 'temporary-create-v1') {
            throw new AgentFault('TEMPORARY_CREATE_COMMAND_REQUIRED', '临时新建需要服务端命令号；请升级客户端或先调用conversations.prepareTemporaryCreate，旧UUID未执行', recovery);
        }
        if (parts[1] !== this.instanceId) {
            throw new AgentFault('TEMPORARY_CREATE_CORE_CHANGED', '原临时新建命令号属于已退出的Core，未重新创建；请先查询原号，明确新建时再取新号', recovery);
        }
        const expiresAt = Number.parseInt(parts[2], 36);
        if (!Number.isSafeInteger(expiresAt) || expiresAt.toString(36) !== parts[2] || !/^[A-Za-z0-9_-]{22}$/.test(parts[3])
            || !/^[A-Za-z0-9_-]{43}$/.test(parts[4])) {
            throw new AgentFault('TEMPORARY_CREATE_COMMAND_REQUIRED', '临时新建命令号格式无效，尚未执行，请使用服务端返回的完整原号', recovery);
        }
        const actual = Buffer.from(parts[4], 'base64url');
        const expected = this.signature(parts.slice(0, 4).join(':'), client);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            throw new AgentFault('TEMPORARY_CREATE_COMMAND_REQUIRED', '临时新建命令号与当前调用方不匹配，尚未执行，请查询原调用方的原号', recovery);
        }
        if (expiresAt <= this.observeTime(now)) {
            throw new AgentFault('TEMPORARY_CREATE_COMMAND_EXPIRED', '原临时新建命令号已过期，未重新创建；请先查询原号，明确新建时再取新号',
                { ...recovery, expiresAt: new Date(expiresAt).toISOString() });
        }
        return expiresAt;
    }

    private signature(payload: string, client: ClientIdentity): Buffer {
        return createHmac('sha256', this.signingKey).update(JSON.stringify([client.principalId, client.clientId, payload])).digest();
    }
}

import { randomUUID } from 'node:crypto';
import { AgentFault } from './protocol.js';
import type { ClientIdentity } from './protocol.js';
import type { StoreKey, StoreRecord } from './storage/port.js';

export const CONTROL_LEASE_MS = 90_000;

export interface ControlLease extends Record<string, unknown> {
    scope: 'server' | 'conversation';
    conversationId: string | null;
    principalId: string;
    clientId: string;
    controlLeaseId: string;
    controlEpoch: number;
    expiresAt: string;
    released: boolean;
}

export function controlKey(conversationId: string | null): StoreKey {
    return { conversationId, kind: 'control', id: conversationId ?? 'server' };
}

export function claimControl(previous: StoreRecord<ControlLease> | undefined, conversationId: string | null,
    client: ClientIdentity, takeover: boolean, now: number): StoreRecord<ControlLease> {
    const current = previous?.value;
    const active = current && !current.released && Date.parse(current.expiresAt) > now;
    const sameOwner = current?.principalId === client.principalId && current?.clientId === client.clientId;
    if (active && !sameOwner && !takeover) throw new AgentFault('CONTROL_CONFLICT', '当前控制租约由另一个客户端持有',
        { controlEpoch: current.controlEpoch, expiresAt: current.expiresAt });
    return { key: controlKey(conversationId), revision: (previous?.revision ?? 0) + 1,
        value: { scope: conversationId ? 'conversation' : 'server', conversationId,
            principalId: client.principalId, clientId: client.clientId,
            controlLeaseId: active && sameOwner && !takeover ? current.controlLeaseId : randomUUID(),
            controlEpoch: active && sameOwner && !takeover ? current.controlEpoch : (current?.controlEpoch ?? 0) + 1,
            expiresAt: new Date(now + CONTROL_LEASE_MS).toISOString(), released: false } };
}

export function requireControl(record: StoreRecord<ControlLease> | undefined, params: Record<string, unknown>,
    client: ClientIdentity, now: number): ControlLease {
    const lease = record?.value;
    if (!lease || lease.released || Date.parse(lease.expiresAt) <= now || lease.principalId !== client.principalId
        || lease.clientId !== client.clientId || lease.controlLeaseId !== params.controlLeaseId || lease.controlEpoch !== params.controlEpoch) {
        throw new AgentFault('CONTROL_REQUIRED', '需要当前客户端持有的有效控制租约',
            { controlEpoch: lease?.controlEpoch ?? null, expiresAt: lease?.expiresAt ?? null });
    }
    return lease;
}

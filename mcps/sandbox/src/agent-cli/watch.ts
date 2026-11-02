import { AgentClient, clientFailure } from '../agent-client/client.js';
import { AgentFault, METHOD_SPECS, type AgentEvent, type RpcResult } from '../agent-server/protocol.js';
import type { EventPage } from '../agent-client/events.js';
import { decodeArtifactJson } from '../agent-client/artifacts.js';

export async function resolveRunResult(client: AgentClient, conversationId: string, result: RpcResult<Record<string, unknown>>): Promise<RpcResult<Record<string, unknown>>> {
    const contentId = result.data?.resultContentId;
    if (!result.ok || typeof contentId !== 'string' || !METHOD_SPECS['conversations.readArtifact']) return result;
    const artifact = await client.readArtifact(conversationId, contentId);
    if (!artifact.ok || !artifact.data) return { ...artifact, data: { run: result.data } };
    try {
        const { bytes: _bytes, ...reference } = artifact.data;
        return { ...result, data: { ...result.data, result: decodeArtifactJson(artifact.data), resultArtifact: reference } };
    } catch (error) { return { ...clientFailure(error), data: { run: result.data } }; }
}

export async function resolveContentPage(client: AgentClient, conversationId: string, result: RpcResult<Record<string, unknown>>, field: 'content' | 'value'): Promise<RpcResult<Record<string, unknown>>> {
    if (!result.ok || !Array.isArray(result.data?.items) || !METHOD_SPECS['conversations.readArtifact']) return result;
    const items: unknown[] = [];
    let remaining = 32 * 1024 * 1024;
    for (const source of result.data.items) {
        const item = source as Record<string, unknown>;
        if (Object.hasOwn(item, field) || typeof item.contentId !== 'string') { items.push(item); continue; }
        const objectRef = item.objectRef as Record<string, unknown> | undefined;
        const expected = field === 'value' && typeof objectRef?.hash === 'string' && typeof objectRef.rawBytes === 'number'
            ? { sha256: objectRef.hash, totalBytes: objectRef.rawBytes, mime: 'application/json' } : undefined;
        const artifact = await client.readArtifact(conversationId, item.contentId, { maxTotalBytes: remaining, expected });
        if (!artifact.ok || !artifact.data) return { ...artifact, data: { page: result.data, resolvedItems: items } };
        try {
            const { bytes: _bytes, ...reference } = artifact.data;
            items.push({ ...item, [field]: decodeArtifactJson(artifact.data), contentArtifact: reference });
            remaining -= artifact.data.totalBytes;
        } catch (error) { return { ...clientFailure(error), data: { page: result.data, resolvedItems: items } }; }
    }
    return { ...result, data: { ...result.data, items } };
}

export function eventText(event: AgentEvent): string | undefined {
    const payload = event.payload;
    for (const key of ['delta', 'text', 'textDelta', 'outputText']) if (typeof payload[key] === 'string') return payload[key] as string;
    const content = payload.content;
    if (typeof content === 'string') return content;
    return undefined;
}

export class ConversationMonitor {
    private running = false;
    private work: Promise<void> | null = null;
    private subscriptionId?: string;
    private wake?: () => void;
    private lastSnapshotAt = 0;
    private reconnectEvents = false;
    private retryEventsAt = 0;
    private readonly onEventsDisconnected = () => { this.subscriptionId = undefined; this.reconnectEvents = true; this.wake?.(); };
    private readonly onNotification = (notification: { params?: Record<string, unknown> }) => {
        if (notification.params?.subscriptionId === this.subscriptionId) this.wake?.();
    };

    constructor(readonly client: AgentClient, readonly conversationId: string, readonly handlers: {
        event?: (event: AgentEvent) => void | Promise<void>;
        snapshot?: (snapshot: Record<string, unknown>) => void | Promise<void>;
        error?: (result: RpcResult) => void | Promise<void>;
    }) {}

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.client.on('notification', this.onNotification);
        this.client.on('eventsDisconnected', this.onEventsDisconnected);
        await this.refresh();
        if (!this.running) return;
        const subscription = await this.client.subscribeEvents(this.conversationId);
        if (!this.running) {
            const subscriptionId = (subscription.data as Record<string, unknown> | undefined)?.subscriptionId;
            if (typeof subscriptionId === 'string') await this.client.unsubscribeEvents(subscriptionId);
            return;
        }
        if (subscription.ok && subscription.data && typeof subscription.data === 'object') {
            this.subscriptionId = (subscription.data as Record<string, unknown>).subscriptionId as string;
        } else await this.handlers.error?.(subscription);
        if (!subscription.ok) this.reconnectEvents = true;
        this.work = this.poll();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.wake?.();
        this.client.removeListener('notification', this.onNotification);
        this.client.removeListener('eventsDisconnected', this.onEventsDisconnected);
        await this.work;
        if (this.subscriptionId) await this.client.unsubscribeEvents(this.subscriptionId);
        this.subscriptionId = undefined;
    }

    private async refresh(): Promise<void> {
        const result = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId: this.conversationId });
        this.lastSnapshotAt = Date.now();
        if (result.ok && result.data) {
            if (this.client.eventCursor.get(this.conversationId) === undefined && result.eventCursor) this.client.eventCursor.reset(this.conversationId, result.eventCursor);
            await this.handlers.snapshot?.(result.data);
        }
        else await this.handlers.error?.(result);
    }

    private async poll(): Promise<void> {
        try {
            while (this.running) {
                if (this.reconnectEvents && Date.now() >= this.retryEventsAt) {
                    const resumed = await this.client.subscribeEvents(this.conversationId, this.client.eventCursor.get(this.conversationId));
                    if (resumed.ok && resumed.data) {
                        this.subscriptionId = (resumed.data as Record<string, unknown>).subscriptionId as string;
                        this.reconnectEvents = false;
                    } else { this.retryEventsAt = Date.now() + 5000; await this.handlers.error?.(resumed); }
                }
                const result = await this.client.readEvents(this.conversationId, { limit: 100, maxBytes: 256 * 1024 });
                if (!this.running) break;
                if (result.ok && result.data) {
                    const page = result.data as EventPage;
                    let cursor: string;
                    try { cursor = await this.client.eventCursor.apply(this.conversationId, page, async event => { await this.handlers.event?.(event); }); }
                    catch (error) {
                        if (!(error instanceof AgentFault) || error.code !== 'EVENT_GAP') throw error;
                        await this.handlers.error?.(clientFailure(error));
                        const snapshot = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId: this.conversationId });
                        if (!snapshot.ok || !snapshot.data || !snapshot.eventCursor) { await this.handlers.error?.(snapshot); break; }
                        await this.handlers.snapshot?.(snapshot.data);
                        this.client.eventCursor.reset(this.conversationId, snapshot.eventCursor);
                        continue;
                    }
                    const ack = await this.client.ackEvents(this.conversationId, cursor, this.subscriptionId);
                    if (!ack.ok) {
                        this.subscriptionId = undefined;
                        this.reconnectEvents = true;
                        await this.handlers.error?.(ack);
                    }
                    if (page.events.length || Date.now() - this.lastSnapshotAt >= 1000) await this.refresh();
                    if (page.hasMore) continue;
                } else if (result.error?.code === 'CURSOR_EXPIRED') {
                    const snapshot = await this.client.request<Record<string, unknown>>('conversations.get', { conversationId: this.conversationId });
                    if (snapshot.ok) {
                        this.client.eventCursor.reset(this.conversationId, snapshot.eventCursor);
                        if (snapshot.data) await this.handlers.snapshot?.(snapshot.data);
                    } else await this.handlers.error?.(snapshot);
                } else await this.handlers.error?.(result);
                await new Promise<void>(resolveWait => {
                    const timer = setTimeout(() => { this.wake = undefined; resolveWait(); }, 500);
                    this.wake = () => { clearTimeout(timer); this.wake = undefined; resolveWait(); };
                    if (!this.running) this.wake();
                });
            }
        } catch (error) { await this.handlers.error?.(clientFailure(error)); }
    }
}

export async function waitForExecution(client: AgentClient, conversationId: string, runId: string, options: {
    event?: (event: AgentEvent) => void | Promise<void>;
    signal?: AbortSignal;
    nonInteractive?: boolean;
    afterCursor?: string;
    cleanupTimeoutMs?: number;
} = {}): Promise<RpcResult> {
    if (options.afterCursor !== undefined) client.eventCursor.reset(conversationId, options.afterCursor);
    const monitor = new ConversationMonitor(client, conversationId, { event: options.event });
    let cleanupDeadline: number | undefined;
    try {
        await monitor.start();
        while (!options.signal?.aborted) {
            const result = await client.request<Record<string, unknown>>('runs.get', { conversationId, runId });
            if (!result.ok || !result.data) return result;
            const run = result.data;
            if (run.state === 'outcome_unknown' || run.cleanupState === 'unconfirmed') return resolveRunResult(client, conversationId, result);
            if (['succeeded', 'failed', 'cancelled', 'paused'].includes(String(run.state))) {
                if (['released', 'not_needed'].includes(String(run.cleanupState))) return resolveRunResult(client, conversationId,
                    options.nonInteractive && run.state === 'paused' ? { ...result, data: { ...run, waitingForHuman: true } } : result);
                cleanupDeadline ??= Date.now() + (options.cleanupTimeoutMs ?? 30_000);
                if (Date.now() >= cleanupDeadline) return { ...clientFailure(new AgentFault('CLEANUP_UNCONFIRMED', '执行已到终态，资源收尾仍待确认，请查询原执行', { conversationId, runId }, true)), data: { run } };
            } else cleanupDeadline = undefined;
            if (options.nonInteractive && (run.state === 'waiting' || Array.isArray(run.pendingInteractionIds) && run.pendingInteractionIds.length)) {
                return { ...result, data: { ...run, waitingForHuman: true } };
            }
            await new Promise<void>(resolveWait => setTimeout(resolveWait, 200));
        }
        return clientFailure(new AgentFault('FRONTEND_DETACHED', '前台已退出，原执行保留在核心，请按原runId查询', { conversationId, runId }, true));
    } finally { await monitor.stop(); }
}

export async function cancelExecution(client: AgentClient, conversationId: string, runId: string, timeoutMs = 30_000): Promise<RpcResult> {
    let snapshot = await client.request<Record<string, unknown>>('runs.get', { conversationId, runId });
    if (!snapshot.ok || !snapshot.data) return snapshot;
    if (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(snapshot.data.state))) {
        const cancelled = await client.request('runs.cancel', { conversationId, runId, expectedRunEpoch: snapshot.data.runEpoch, reason: '人工前台请求取消' });
        if (!cancelled.ok) return cancelled;
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
        snapshot = await client.request<Record<string, unknown>>('runs.get', { conversationId, runId });
        if (!snapshot.ok || !snapshot.data) return snapshot;
        if (snapshot.data.state === 'outcome_unknown') return snapshot;
        if (['succeeded', 'failed', 'cancelled'].includes(String(snapshot.data.state)) && ['released', 'not_needed'].includes(String(snapshot.data.cleanupState))) return resolveRunResult(client, conversationId, snapshot);
        if (Date.now() >= deadline) return clientFailure(new AgentFault('CLEANUP_UNCONFIRMED', '取消已请求，资源收尾仍待确认，请查询原执行', { conversationId, runId }, true));
        await new Promise<void>(resolveWait => setTimeout(resolveWait, 100));
    }
}

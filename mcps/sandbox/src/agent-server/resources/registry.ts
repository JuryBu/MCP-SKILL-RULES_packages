import { createHash, randomUUID } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import { canonicalJson } from '../protocol.js';
import type { BoundToolContext } from '../tools/types.js';

export interface OwnedResource {
    resourceId: string;
    issuerId: string;
    principalId: string;
    conversationId: string;
    runId: string;
    rootRunId: string;
    runEpoch: number;
    actionId: string;
    requestId: string;
    argsHash: string;
    adapterId: string;
    kind: string;
    externalId?: string;
    leaseUntil: string;
    state: 'allocating' | 'active' | 'closing' | 'released' | 'unresolved';
    cleanupState: 'pending' | 'released' | 'unconfirmed';
    retention: BoundToolContext['retention'];
    receipt?: ResourceReceipt;
}

export interface ResourceReceipt {
    externalId?: string;
    started: boolean | null;
    terminalConfirmed: boolean;
    released: boolean;
    evidence: Record<string, unknown>;
}

export interface ResourceConversationOwner { conversationId: string; principalId: string }

export interface ResourceAdapter {
    adapterId: string;
    supports: { authenticated: boolean; findByRequest: boolean; finiteLease: boolean; status: boolean; renew: boolean; cancel: boolean; release: boolean; ephemeralContent: boolean };
    create(resource: OwnedResource, parameters: Record<string, unknown>, signal: AbortSignal): Promise<ResourceReceipt>;
    findByRequest(resource: OwnedResource): Promise<ResourceReceipt | null>;
    status(resource: OwnedResource): Promise<ResourceReceipt>;
    renew(resource: OwnedResource, leaseUntil: string): Promise<ResourceReceipt>;
    cancel(resource: OwnedResource): Promise<ResourceReceipt>;
    release(resource: OwnedResource): Promise<ResourceReceipt>;
    prepareTemporaryClose?(resource: OwnedResource): Promise<ResourceReceipt>;
    releaseTemporaryOutput?(resource: OwnedResource): void;
}

export interface ResourceStorePort {
    allocate(resource: OwnedResource): Promise<{ resource: OwnedResource; reused: boolean }>;
    get(resourceId: string): Promise<OwnedResource | undefined>;
    put(resource: OwnedResource): Promise<void>;
    list(conversationId: string, rootRunId: string): Promise<OwnedResource[]>;
    listTemporaryConversation?(conversationId: string): Promise<OwnedResource[]>;
    forgetTemporaryConversation?(conversationId: string, expected: readonly OwnedResource[]): Promise<void>;
}

export class MemoryResourceStore implements ResourceStorePort {
    private readonly records = new Map<string, OwnedResource>();
    private readonly operations = new Map<string, string>();
    async allocate(resource: OwnedResource): Promise<{ resource: OwnedResource; reused: boolean }> {
        const key = JSON.stringify([resource.principalId, resource.conversationId, resource.runId, resource.actionId, resource.adapterId]);
        const previousId = this.operations.get(key);
        const previous = previousId ? this.records.get(previousId) : undefined;
        if (previous) {
            if (previous.argsHash !== resource.argsHash) throw new AgentFault('COMMAND_ID_REUSED', '同一资源动作的参数已变化');
            return { resource: structuredClone(previous), reused: true };
        }
        this.operations.set(key, resource.resourceId);
        this.records.set(resource.resourceId, structuredClone(resource));
        return { resource: structuredClone(resource), reused: false };
    }
    async get(resourceId: string): Promise<OwnedResource | undefined> { return structuredClone(this.records.get(resourceId)); }
    async put(resource: OwnedResource): Promise<void> { this.records.set(resource.resourceId, structuredClone(resource)); }
    async list(conversationId: string, rootRunId: string): Promise<OwnedResource[]> {
        return structuredClone([...this.records.values()].filter(resource => resource.conversationId === conversationId && resource.rootRunId === rootRunId));
    }
    async listTemporaryConversation(conversationId: string): Promise<OwnedResource[]> {
        return structuredClone([...this.records.values()].filter(resource => resource.conversationId === conversationId && resource.retention.mode === 'temporary'));
    }
    async forgetTemporaryConversation(conversationId: string, expected: readonly OwnedResource[]): Promise<void> {
        const current = [...this.records.values()].filter(resource => resource.conversationId === conversationId && resource.retention.mode === 'temporary');
        const originals = new Map(expected.map(resource => [resource.resourceId, resource]));
        if (originals.size !== expected.length || current.length !== expected.length || current.some(resource => {
            const original = originals.get(resource.resourceId);
            return !original || canonicalJson(original) !== canonicalJson(resource) || resource.state !== 'released'
                || resource.cleanupState !== 'released' || !resource.receipt?.released || !resource.receipt.terminalConfirmed;
        }) || expected.some(resource => resource.conversationId !== conversationId || resource.retention.mode !== 'temporary')) {
            throw new AgentFault('CLEANUP_UNCONFIRMED', '临时资源映射已变化或终态尚未确认，原记录继续保留');
        }
        const operations = [...this.operations].filter(([key, resourceId]) => originals.has(resourceId)
            || !this.records.has(resourceId) && (JSON.parse(key) as string[])[1] === conversationId).map(([key]) => key);
        for (const resource of current) this.records.delete(resource.resourceId);
        for (const key of operations) this.operations.delete(key);
    }
}

export class ResourceRegistry {
    private readonly adapters = new Map<string, ResourceAdapter>();
    private readonly adapterLoaders = new Map<string, () => Promise<ResourceAdapter>>();
    private readonly loadingAdapters = new Map<string, Promise<ResourceAdapter>>();
    private readonly closedRuns = new Set<string>();
    private readonly closingConversations = new Set<string>();
    private readonly pendingConversations = new Map<string, Set<Promise<unknown>>>();
    private readonly preparingConversations = new Map<string, Promise<OwnedResource[]>>();
    private readonly forgettingConversations = new Map<string, Promise<void>>();

    constructor(readonly store: ResourceStorePort = new MemoryResourceStore(), readonly issuerId: string = randomUUID(), readonly now: () => number = Date.now) {}

    register(adapter: ResourceAdapter): void {
        const support = adapter.supports;
        if (!support.authenticated || !support.findByRequest || !support.finiteLease || !support.status || !support.renew || !support.cancel || !support.release) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '持久能力缺少认证、原请求查回或有限租约，保持关闭', { adapterId: adapter.adapterId });
        }
        if (this.adapters.get(adapter.adapterId) === adapter) return;
        if (this.adapters.has(adapter.adapterId)) throw new AgentFault('INVALID_PARAMS', '资源适配器已登记');
        this.adapters.set(adapter.adapterId, adapter);
    }

    registerLoader(adapterId: string, load: () => Promise<ResourceAdapter>): void {
        if (!adapterId || this.adapterLoaders.has(adapterId)) throw new AgentFault('INVALID_PARAMS', '资源适配器加载入口重复或无效');
        this.adapterLoaders.set(adapterId, load);
    }

    private key(context: Pick<BoundToolContext, 'conversationId' | 'runId'>): string { return JSON.stringify([context.conversationId, context.runId]); }
    private isClosed(context: BoundToolContext): boolean {
        return this.closingConversations.has(context.conversationId) || this.closedRuns.has(this.key(context))
            || this.closedRuns.has(this.key({ conversationId: context.conversationId, runId: context.rootRunId }));
    }

    private async track<Value>(conversationId: string, operation: () => Promise<Value>): Promise<Value> {
        const pending = this.pendingConversations.get(conversationId) ?? new Set<Promise<unknown>>();
        const result = Promise.resolve().then(operation);
        pending.add(result); this.pendingConversations.set(conversationId, pending);
        try { return await result; }
        finally { pending.delete(result); if (!pending.size) this.pendingConversations.delete(conversationId); }
    }

    private async requireAdapter(resource: OwnedResource): Promise<ResourceAdapter> {
        let adapter = this.adapters.get(resource.adapterId);
        const load = this.adapterLoaders.get(resource.adapterId);
        if (!adapter && load) {
            let pending = this.loadingAdapters.get(resource.adapterId);
            if (!pending) {
                pending = load().then(loaded => {
                    if (loaded.adapterId !== resource.adapterId) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '原资源适配器身份已变化');
                    this.register(loaded);
                    return loaded;
                });
                this.loadingAdapters.set(resource.adapterId, pending);
            }
            try { adapter = await pending; }
            catch (error) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '原资源连接尚未恢复，保留原请求并继续查询',
                    { resourceId: resource.resourceId, requestId: resource.requestId, causeCode: error instanceof AgentFault ? error.code : 'RESOURCE_CONNECTION_FAILED' }, true);
            }
            finally { if (this.loadingAdapters.get(resource.adapterId) === pending) this.loadingAdapters.delete(resource.adapterId); }
        }
        if (!adapter) throw new AgentFault('RESOURCE_UNRESOLVED', '原资源适配器尚未接回，请保留原请求标识', { resourceId: resource.resourceId }, true);
        return adapter;
    }

    private leaseUntil(context: BoundToolContext): string {
        const now = this.now();
        const deadline = context.deadlineAt === undefined ? Infinity : Date.parse(context.deadlineAt);
        if (Number.isNaN(deadline)) throw new AgentFault('INVALID_PARAMS', '资源缺少有效的运行截止时间');
        if (deadline <= now) throw new AgentFault('E_BUDGET_DEADLINE', '所属运行已经到期，停止创建或续租资源');
        return new Date(Math.min(now + 90000, deadline)).toISOString();
    }

    async create(adapterId: string, kind: string, parameters: Record<string, unknown>, context: BoundToolContext): Promise<OwnedResource> {
        return this.track(context.conversationId, () => this.createOwned(adapterId, kind, parameters, context));
    }

    private async createOwned(adapterId: string, kind: string, parameters: Record<string, unknown>, context: BoundToolContext): Promise<OwnedResource> {
        if (context.signal.aborted || this.isClosed(context)) throw new AgentFault('TOOL_CANCELLED', '所属执行已停止新增资源');
        const adapter = this.adapters.get(adapterId);
        if (!adapter || (context.retention.mode === 'temporary' && !adapter.supports.ephemeralContent)) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '该资源未具备当前保存方式需要的完整生命周期');
        }
        await context.assertCurrent?.();
        if (this.isClosed(context)) throw new AgentFault('TOOL_CANCELLED', '所属会话已开始关闭，停止新增资源');
        const resource: OwnedResource = { resourceId: randomUUID(), issuerId: this.issuerId, principalId: context.principalId,
            conversationId: context.conversationId, runId: context.runId, rootRunId: context.rootRunId, runEpoch: context.runEpoch,
            actionId: context.actionId, requestId: randomUUID(), argsHash: createHash('sha256').update(canonicalJson({ kind, parameters, policyRevision: context.policyRevision })).digest('hex'),
            adapterId, kind, leaseUntil: this.leaseUntil(context),
            state: 'allocating', cleanupState: 'pending', retention: context.retention };
        const allocated = await this.store.allocate(resource);
        if (allocated.reused) {
            if (allocated.resource.state === 'allocating' || allocated.resource.state === 'unresolved') return this.reconcile(allocated.resource.resourceId, context);
            return allocated.resource;
        }
        try {
            const receipt = await adapter.create(structuredClone(resource), parameters, context.signal);
            this.apply(resource, receipt);
            await this.store.put(resource);
            if (context.signal.aborted || this.isClosed(context)) return this.close(resource.resourceId, context);
            return structuredClone(resource);
        } catch (error) {
            resource.state = 'unresolved';
            resource.cleanupState = 'unconfirmed';
            await this.store.put(resource);
            throw new AgentFault('RESOURCE_UNRESOLVED', '资源创建结果待查回，保留原requestId且不重复创建',
                { resourceId: resource.resourceId, requestId: resource.requestId }, !(error instanceof AgentFault) || error.mayHaveStarted);
        }
    }

    async trackAttempt(adapterId: string, resourceId: string, kind: string, argsHash: string, context: BoundToolContext): Promise<OwnedResource> {
        return this.track(context.conversationId, () => this.trackOwnedAttempt(adapterId, resourceId, kind, argsHash, context));
    }

    private async trackOwnedAttempt(adapterId: string, resourceId: string, kind: string, argsHash: string, context: BoundToolContext): Promise<OwnedResource> {
        if (context.signal.aborted || this.isClosed(context)) throw new AgentFault('TOOL_CANCELLED', '所属执行已停止新增资源');
        const resource: OwnedResource = { resourceId, issuerId: this.issuerId, principalId: context.principalId,
            conversationId: context.conversationId, runId: context.runId, rootRunId: context.rootRunId, runEpoch: context.runEpoch,
            actionId: context.actionId, requestId: resourceId, argsHash, adapterId, kind,
            leaseUntil: this.leaseUntil(context), state: 'allocating', cleanupState: 'pending', retention: context.retention };
        const allocated = await this.store.allocate(resource);
        if (allocated.reused) throw new AgentFault('RESOURCE_UNRESOLVED', '原命令资源已登记，请查询原回执', { resourceId: allocated.resource.resourceId }, true);
        return allocated.resource;
    }

    async settleTracked(resourceId: string, receipt: ResourceReceipt, context: BoundToolContext): Promise<OwnedResource> {
        const resource = await this.owned(resourceId, context);
        this.apply(resource, receipt);
        await this.store.put(resource);
        return structuredClone(resource);
    }

    private apply(resource: OwnedResource, receipt: ResourceReceipt): void {
        if (resource.externalId && receipt.externalId && resource.externalId !== receipt.externalId) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '资源回执的原对象标识变化', { resourceId: resource.resourceId }, true);
        }
        resource.receipt = structuredClone(receipt);
        resource.externalId ??= receipt.externalId;
        resource.state = receipt.released && receipt.terminalConfirmed ? 'released' : receipt.started === true ? 'active' : 'unresolved';
        resource.cleanupState = resource.state === 'released' ? 'released' : 'pending';
    }

    private async owned(resourceId: string, context: BoundToolContext): Promise<OwnedResource> {
        const resource = await this.store.get(resourceId);
        if (!resource || resource.issuerId !== this.issuerId || resource.principalId !== context.principalId
            || resource.conversationId !== context.conversationId || resource.rootRunId !== context.rootRunId
            || (context.runId !== context.rootRunId && resource.runId !== context.runId)) {
            throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '资源未绑定当前可信执行树');
        }
        return resource;
    }

    async reconcile(resourceId: string, context: BoundToolContext): Promise<OwnedResource> {
        const resource = await this.owned(resourceId, context);
        const adapter = await this.requireAdapter(resource);
        let receipt: ResourceReceipt | null;
        try { receipt = await adapter.findByRequest(structuredClone(resource)); }
        catch (error) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '原资源查询未确认终态，保留原请求',
                { resourceId, requestId: resource.requestId, causeCode: error instanceof AgentFault ? error.code : 'RESOURCE_QUERY_FAILED' }, true);
        }
        if (!receipt) throw new AgentFault('RESOURCE_UNRESOLVED', '原请求尚无可确认回执', { resourceId, requestId: resource.requestId }, true);
        this.apply(resource, receipt);
        await this.store.put(resource);
        return structuredClone(resource);
    }

    async renew(resourceId: string, context: BoundToolContext): Promise<OwnedResource> {
        const resource = await this.owned(resourceId, context);
        if (resource.state !== 'active' || context.signal.aborted || this.isClosed(context) || resource.runEpoch !== context.runEpoch) {
            throw new AgentFault('POLICY_CHANGED', '资源执行代际已失效，停止续租');
        }
        await context.assertCurrent?.();
        const adapter = await this.requireAdapter(resource);
        await context.assertCurrent?.();
        const leaseUntil = this.leaseUntil(context);
        const receipt = await adapter.renew(structuredClone(resource), leaseUntil);
        this.apply(resource, receipt);
        resource.leaseUntil = leaseUntil;
        await this.store.put(resource);
        return structuredClone(resource);
    }

    async close(resourceId: string, context: BoundToolContext): Promise<OwnedResource> {
        const resource = await this.owned(resourceId, context);
        if (resource.state === 'released') return resource;
        resource.state = 'closing';
        resource.cleanupState = 'pending';
        await this.store.put(resource);
        try {
            const adapter = await this.requireAdapter(resource);
            this.apply(resource, await adapter.cancel(structuredClone(resource)));
            this.apply(resource, await adapter.release(structuredClone(resource)));
            const final = await adapter.status(structuredClone(resource));
            this.apply(resource, final);
            if (!final.released || !final.terminalConfirmed) resource.state = 'unresolved';
        } catch {
            resource.state = 'unresolved';
            resource.cleanupState = 'unconfirmed';
        }
        await this.store.put(resource);
        return structuredClone(resource);
    }

    async closeRun(context: BoundToolContext): Promise<OwnedResource[]> {
        this.closedRuns.add(this.key(context));
        const records = await this.store.list(context.conversationId, context.rootRunId);
        const results: OwnedResource[] = [];
        for (const resource of [...records].reverse()) if (context.runId === context.rootRunId || resource.runId === context.runId) results.push(await this.close(resource.resourceId, context));
        return results;
    }

    async releaseIdle(context: BoundToolContext): Promise<OwnedResource[]> {
        const records = await this.store.list(context.conversationId, context.rootRunId);
        const results: OwnedResource[] = [];
        for (const resource of [...records].reverse()) if (context.runId === context.rootRunId || resource.runId === context.runId) results.push(await this.close(resource.resourceId, context));
        return results;
    }

    async prepareTemporaryConversationClose(owner: ResourceConversationOwner): Promise<OwnedResource[]> {
        if (!this.store.listTemporaryConversation || !this.store.forgetTemporaryConversation) {
            throw new AgentFault('CLEANUP_UNCONFIRMED', '当前资源Store尚未提供完整临时CID列举及原子清理，原映射保留');
        }
        const key = canonicalJson([owner.principalId, owner.conversationId]);
        const previous = this.preparingConversations.get(key);
        if (previous) return previous;
        this.closingConversations.add(owner.conversationId);
        const pending = Promise.resolve().then(async () => {
            await Promise.allSettled([...(this.pendingConversations.get(owner.conversationId) ?? [])]);
            const records = await this.store.listTemporaryConversation!(owner.conversationId);
            const results: OwnedResource[] = [];
            for (const original of [...records].reverse()) {
                if (original.conversationId !== owner.conversationId || original.principalId !== owner.principalId
                    || original.issuerId !== this.issuerId || original.retention.mode !== 'temporary') {
                    throw new AgentFault('CLEANUP_UNCONFIRMED', '临时资源原归属尚未核实，保留原CID映射', { resourceId: original.resourceId });
                }
                const resource = structuredClone(original);
                const adapter = await this.requireAdapter(resource);
                let receipt: ResourceReceipt;
                if (adapter.prepareTemporaryClose) receipt = await adapter.prepareTemporaryClose(resource);
                else if (resource.receipt?.released && resource.receipt.terminalConfirmed) receipt = await adapter.release(resource);
                else {
                    this.apply(resource, await adapter.cancel(resource));
                    this.apply(resource, await adapter.release(resource));
                    receipt = await adapter.status(resource);
                }
                if (!receipt.released || !receipt.terminalConfirmed) throw new AgentFault('CLEANUP_UNCONFIRMED', '临时原请求终态尚未确认，原字节及映射保留', { resourceId: resource.resourceId, requestId: resource.requestId }, true);
                this.apply(resource, receipt);
                await this.store.put(resource);
                const persisted = await this.store.get(resource.resourceId);
                if (!persisted || persisted.conversationId !== owner.conversationId || persisted.principalId !== owner.principalId
                    || persisted.issuerId !== this.issuerId || persisted.requestId !== resource.requestId || persisted.retention.mode !== 'temporary'
                    || persisted.state !== 'released' || persisted.cleanupState !== 'released'
                    || !persisted.receipt?.released || !persisted.receipt.terminalConfirmed) {
                    throw new AgentFault('CLEANUP_UNCONFIRMED', '原资源关闭回执尚未保存完整，原字节及映射保留', { resourceId: resource.resourceId });
                }
                results.push(persisted);
            }
            return results;
        });
        this.preparingConversations.set(key, pending);
        try { return await pending; }
        catch (error) {
            throw new AgentFault('CLEANUP_UNCONFIRMED', '临时CID资源关闭尚未确认，原字节及映射继续保留',
                { conversationId: owner.conversationId, causeCode: error instanceof AgentFault ? error.code : 'RESOURCE_CLOSE_FAILED' }, true);
        }
        finally { if (this.preparingConversations.get(key) === pending) this.preparingConversations.delete(key); }
    }

    async forgetTemporaryConversation(owner: ResourceConversationOwner): Promise<void> {
        const key = canonicalJson([owner.principalId, owner.conversationId]);
        const previous = this.forgettingConversations.get(key);
        if (previous) return previous;
        const pending = Promise.resolve().then(async () => {
            const records = await this.prepareTemporaryConversationClose(owner);
            await this.store.forgetTemporaryConversation!(owner.conversationId, records);
            for (const resource of records) (await this.requireAdapter(resource)).releaseTemporaryOutput?.(resource);
            for (const closed of this.closedRuns) if ((JSON.parse(closed) as string[])[0] === owner.conversationId) this.closedRuns.delete(closed);
            this.closingConversations.delete(owner.conversationId);
        });
        this.forgettingConversations.set(key, pending);
        try { await pending; }
        catch (error) {
            throw new AgentFault('CLEANUP_UNCONFIRMED', '临时CID映射清理尚未确认，保留原恢复信息',
                { conversationId: owner.conversationId, causeCode: error instanceof AgentFault ? error.code : 'RESOURCE_FORGET_FAILED' }, true);
        }
        finally { if (this.forgettingConversations.get(key) === pending) this.forgettingConversations.delete(key); }
    }
}

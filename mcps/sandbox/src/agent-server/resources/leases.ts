import type { BoundToolContext } from '../tools/types.js';
import type { OwnedResource, ResourceRegistry } from './registry.js';

export const RESOURCE_LEASE_MS = 90000;
export const RESOURCE_RENEW_MS = 30000;

export class ResourceLeaseKeeper {
    private timer?: ReturnType<typeof setInterval>;
    private pending: Promise<void> = Promise.resolve();
    private stopped = false;
    private renewing = false;

    constructor(readonly registry: ResourceRegistry, readonly context: BoundToolContext,
        readonly onFailure: (resource: OwnedResource | null, error: unknown) => void | Promise<void>) {}

    start(): void {
        if (this.timer || this.stopped) return;
        this.timer = setInterval(() => {
            if (this.stopped || this.renewing) return;
            this.renewing = true;
            this.pending = this.renew().catch(error => this.onFailure(null, error)).catch(() => {})
                .finally(() => { this.renewing = false; });
        }, RESOURCE_RENEW_MS);
        this.timer.unref();
    }

    private async renew(): Promise<void> {
        if (this.stopped || this.context.signal.aborted) return;
        const resources = await this.registry.store.list(this.context.conversationId, this.context.rootRunId);
        for (const resource of resources) if (resource.state === 'active' && resource.runId === this.context.runId) {
            try { await this.registry.renew(resource.resourceId, this.context); }
            catch (error) { await this.onFailure(resource, error); }
        }
    }

    async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.pending; }
}

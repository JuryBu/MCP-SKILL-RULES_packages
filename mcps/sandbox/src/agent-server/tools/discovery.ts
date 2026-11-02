import { AgentFault } from '../protocol.js';
import { ToolCatalogService } from './service.js';
import type { ToolRouter } from './router.js';
import type { BoundToolContext, ToolCatalogEntry } from './types.js';

export class ModelToolDiscovery {
    private readonly catalog: ToolCatalogService;
    constructor(readonly router: ToolRouter) { this.catalog = new ToolCatalogService(router); }

    handles(name: string): boolean { return ['tool_catalog', 'tool_describe', 'tool_load'].includes(name); }

    private visible(entry: ToolCatalogEntry, context: BoundToolContext): boolean {
        return entry.modelEffect !== 'unknown' && (context.runId === context.rootRunId || entry.resourceKind !== 'internal_child')
            && entry.availability !== 'disabled';
    }

    private entries(context: BoundToolContext): ToolCatalogEntry[] {
        const entries = this.router.list().filter(entry => this.visible(entry, context));
        let cursor: string | undefined;
        do {
            const page = this.router.shared?.list({ cursor, limit: 100 });
            if (!page) break;
            entries.push(...page.entries.filter(entry => this.visible(entry, context)));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return entries;
    }

    async execute(name: string, args: Record<string, unknown>, context: BoundToolContext): Promise<unknown> {
        if (!this.handles(name)) throw new AgentFault('TOOL_NOT_ALLOWED', '该工具未在基础发现工具中启用');
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具发现已取消');
        await context.assertCurrent?.();
        const entries = this.entries(context);
        if (name === 'tool_catalog') {
            const query = String(args.query ?? '').trim().toLocaleLowerCase('en-US');
            const filtered = entries.filter(entry => !query || `${entry.toolId} ${entry.name} ${entry.summary}`.toLocaleLowerCase('en-US').includes(query));
            const offset = args.cursor ? Number(args.cursor) : 0;
            const limit = Number(args.limit ?? 24);
            if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentFault('INVALID_PARAMS', '工具目录cursor无效');
            return { entries: filtered.slice(offset, offset + limit), nextCursor: offset + limit < filtered.length ? String(offset + limit) : null };
        }
        const names = name === 'tool_describe' ? [String(args.name)] : args.names as string[];
        const selected = [...new Set(names)].map(selectedName => {
            const entry = entries.find(candidate => candidate.toolId === selectedName || candidate.name === selectedName);
            if (!entry) throw new AgentFault('TOOL_NOT_ALLOWED', '该工具未在当前可信任务的目录中启用', { name: selectedName });
            return entry;
        });
        if (name === 'tool_describe') {
            const description = await this.catalog.describe({ name: selected[0].toolId }, context.signal);
            await context.assertCurrent?.();
            if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具说明读取已取消');
            return description;
        }
        const prepared = await this.catalog.prepareForModel({ names: selected.map(entry => entry.toolId) }, context.signal);
        const sharedNames = selected.filter(entry => entry.serviceId !== 'local').map(entry => entry.toolId);
        if (sharedNames.length) await this.router.shared!.load(sharedNames, context);
        await context.assertCurrent?.();
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具加载已取消');
        return { loaded: prepared.functions.map(schema => ({ name: schema.name, schemaHash: prepared.schemaHashes[schema.name] })),
            unavailable: selected.filter(entry => entry.serviceId === 'local' && entry.availability !== 'available')
                .map(entry => ({ toolId: entry.toolId, reason: entry.reason })), effectiveFrom: 'next_model_request' };
    }
}

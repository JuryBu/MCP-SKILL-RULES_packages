import { AgentFault } from '../protocol.js';
import { ToolCatalogService } from './service.js';
import type { ToolRouter } from './router.js';
import type { BoundToolContext, ToolCatalogEntry } from './types.js';
import { searchToolCatalog } from './catalog-search.js';

export class ModelToolDiscovery {
    private readonly catalog: ToolCatalogService;
    constructor(readonly router: ToolRouter) { this.catalog = new ToolCatalogService(router); }

    handles(name: string): boolean { return ['tool_catalog', 'tool_describe', 'tool_load'].includes(name); }

    private visible(entry: ToolCatalogEntry, context: BoundToolContext): boolean {
        return entry.modelEffect !== 'unknown' && (entry.resourceKind !== 'internal_child'
            || context.runId === context.rootRunId && context.allowInternalDelegation === true)
            && entry.availability !== 'disabled';
    }

    private publicationReason(entry: ToolCatalogEntry, context: BoundToolContext): string | null {
        if (context.modelToolNames && !context.modelToolNames.some(name => name === entry.name || name === entry.toolId)) {
            return '本任务固定工具选择未包含此工具，请由主调用方调整选择后再加载';
        }
        return entry.serviceId === 'local' ? null : this.router.shared?.modelPublicationReason(entry.toolId, context) ?? null;
    }

    private entries(context: BoundToolContext): ToolCatalogEntry[] {
        const entries = this.router.list().filter(entry => this.visible(entry, context));
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = this.router.shared?.list({ cursor, limit: 100 });
            if (!page) break;
            entries.push(...page.entries.filter(entry => this.visible(entry, context)));
            cursor = page.nextCursor ?? undefined;
            if (cursor && (seen.has(cursor) || seen.size >= 64)) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享工具目录分页未前进或超出读取预算');
            if (cursor) seen.add(cursor);
        } while (cursor);
        return entries;
    }

    async execute(name: string, args: Record<string, unknown>, context: BoundToolContext): Promise<unknown> {
        if (!this.handles(name)) throw new AgentFault('TOOL_NOT_ALLOWED', '该工具未在基础发现工具中启用');
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具发现已取消');
        await context.assertCurrent?.();
        const entries = this.entries(context);
        if (name === 'tool_catalog') {
            const page = searchToolCatalog(entries, args);
            return { ...page, entries: page.entries.map(entry => ({ ...entry,
                publication: { allowed: this.publicationReason(entry, context) === null, reason: this.publicationReason(entry, context) } })) };
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
            return { ...description, publication: { allowed: this.publicationReason(selected[0], context) === null,
                reason: this.publicationReason(selected[0], context) } };
        }
        const eligible = selected.filter(entry => this.publicationReason(entry, context) === null);
        const prepared = await this.catalog.prepareForModel({ names: eligible.map(entry => entry.toolId) }, context.signal);
        const sharedNames = eligible.filter(entry => entry.serviceId !== 'local').map(entry => entry.toolId);
        if (sharedNames.length) await this.router.shared!.load(sharedNames, context);
        await context.assertCurrent?.();
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '工具加载已取消');
        return { loaded: prepared.functions.map(schema => ({ name: schema.name, schemaHash: prepared.schemaHashes[schema.name] })),
            unavailable: selected.filter(entry => this.publicationReason(entry, context) !== null
                || !prepared.functions.some(schema => schema.name === entry.name))
                .map(entry => ({ toolId: entry.toolId, reason: this.publicationReason(entry, context)
                    ?? this.router.list().find(candidate => candidate.toolId === entry.toolId)?.reason ?? entry.reason })),
            effectiveFrom: prepared.functions.length ? 'next_model_request' : null };
    }
}

import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import type { FunctionTool } from '../providers/types.js';
import { ToolSchemaCache } from './schema-cache.js';
import type { ToolRouter } from './router.js';
import type { ModelFunctionSchema, ToolCatalogEntry } from './types.js';

export interface ToolCatalogListInput { cursor?: string; limit?: number; includeUnavailable?: boolean }
export interface ToolCatalogPage { entries: ToolCatalogEntry[]; nextCursor: string | null }
export interface ToolDescription {
    toolId: string;
    schemaHash: string;
    availability: ToolCatalogEntry['availability'];
    reason: string | null;
    function: ModelFunctionSchema;
}
export interface PreparedModelTools {
    functions: ModelFunctionSchema[];
    definitions: FunctionTool[];
    schemaHashes: Readonly<Record<string, string>>;
}

export class ToolCatalogService {
    private readonly localSchemas = new ToolSchemaCache();
    constructor(readonly router: ToolRouter) {}

    private localDescription(entry: ToolCatalogEntry): ToolDescription {
        const schema = this.router.describe(entry.name);
        const cached = this.localSchemas.get('local', entry.name)
            ?? this.localSchemas.put('local', entry.name, entry.adapterVersion, schema.parameters);
        return { toolId: entry.toolId, schemaHash: entry.schemaHash ?? cached.schemaHash,
            availability: entry.availability, reason: entry.reason, function: schema };
    }

    list(input: ToolCatalogListInput = {}): ToolCatalogPage {
        const limit = input.limit ?? 24;
        const offset = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new AgentFault('INVALID_PARAMS', '工具目录分页参数无效');
        const entries: ToolCatalogEntry[] = this.router.list().map(entry => ({ ...entry,
            schemaHash: entry.schemaHash ?? this.localSchemas.get('local', entry.name, entry.adapterVersion)?.schemaHash ?? null }));
        let cursor: string | undefined;
        do {
            const page = this.router.shared?.list({ limit: 100, cursor, includeUnavailable: input.includeUnavailable });
            if (!page) break;
            entries.push(...page.entries);
            if (page.nextCursor === cursor) throw new AgentFault('TOOL_SERVICE_UNAVAILABLE', '共享工具目录分页未前进');
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return { entries: entries.slice(offset, offset + limit), nextCursor: offset + limit < entries.length ? String(offset + limit) : null };
    }

    async describe(input: { name: string }, signal?: AbortSignal): Promise<ToolDescription> {
        if (signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '工具描述读取已取消');
        if (!input?.name || typeof input.name !== 'string') throw new AgentFault('INVALID_PARAMS', '工具描述需要明确名称');
        const local = this.router.list().find(entry => entry.name === input.name || entry.toolId === input.name);
        if (local) {
            if (local.name === 'run_command' && local.availability === 'schema_pending') {
                await this.router.checkCommandCapability();
                return this.localDescription(this.router.list().find(entry => entry.toolId === local.toolId)!);
            }
            return this.localDescription(local);
        }
        if (!this.router.shared) throw new AgentFault('TOOL_NOT_ALLOWED', '共享工具目录尚未显式装配');
        const descriptor = await this.router.shared.describe(input.name, signal);
        return { ...descriptor, availability: 'available', reason: null };
    }

    async prepareForModel(input: { names: readonly string[] }, signal?: AbortSignal): Promise<PreparedModelTools> {
        if (!Array.isArray(input?.names) || input.names.length > 32 || input.names.some(name => typeof name !== 'string' || !name)) throw new AgentFault('INVALID_PARAMS', '模型工具需要明确选择至多32个名称');
        const functions: ModelFunctionSchema[] = [];
        const schemaHashes: Record<string, string> = {};
        for (const name of [...new Set(input.names)]) {
            const description = await this.describe({ name }, signal);
            if (description.availability !== 'available') continue;
            if (schemaHashes[description.function.name]) continue;
            functions.push(structuredClone(description.function));
            schemaHashes[description.function.name] = description.schemaHash;
        }
        return { functions, schemaHashes: Object.freeze(schemaHashes), definitions: functions.map(schema => ({ name: schema.name,
            description: schema.description, parameters: structuredClone(schema.parameters) as JsonObject })) };
    }
}

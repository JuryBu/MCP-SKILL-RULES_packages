import { AgentFault, failure } from '../protocol.js';
import type { ClientIdentity, RpcResult } from '../protocol.js';
import type { ConfigurationServiceOptions } from './contracts.js';
import { MODULE_RPC_SPECS } from './rpc-specs.js';
import { ConfigurationExtraPort } from '../storage/configuration-extra.js';
import { ConfigurationSourceReader } from './source-reader.js';
import { ConfigurationSettingsService } from './settings.js';
import { ConfigurationInstructions } from './instructions.js';
import { searchConfigurationHistory } from './history-search.js';

export function createConfigurationService(options: ConfigurationServiceOptions) {
    const port = new ConfigurationExtraPort(options.store, options);
    const reader = new ConfigurationSourceReader(options.sourceRoots);
    const settings = new ConfigurationSettingsService(port, reader);
    const instructions = new ConfigurationInstructions(port, settings, reader);
    const dispatch = async (method: string, input: Record<string, unknown>, client: ClientIdentity): Promise<RpcResult | undefined> => {
        const spec = MODULE_RPC_SPECS[method];
        if (!spec) return undefined;
        try {
            if (!client?.principalId || !client.clientId) throw new AgentFault('AUTH_FAILED', '配置操作需要明确客户端身份');
            const parsed = spec.schema.safeParse(input);
            if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '配置参数不符合公开定义', {
                method, fields: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
            const params = parsed.data as Record<string, unknown>;
            if (spec.scope === 'conversation') {
                if (spec.writes) await options.authorizeConversationWrite(client, params);
                else await options.authorizeConversationRead(client, String(params.conversationId));
            } else if (spec.writes) await options.authorizeGlobalWrite(client, params);
            if (spec.writes) {
                const replay = await port.replay(client, method, params);
                if (replay) return replay;
            }
            if (method === 'server.settings.get') return { ok: true, data: { ...await settings.get(client.principalId),
                instructionSourceRoots: [...options.sourceRoots], instructionSourceRootsOrigin: 'server_startup_configuration' } };
            if (method === 'server.settings.put') return await settings.put(client, method, params);
            if (method === 'conversations.search') return { ok: true, data: await searchConfigurationHistory(options.store, {
                conversationId: String(params.conversationId), query: String(params.query), scope: params.scope as 'input' | 'conversation',
                cursor: params.cursor as string | undefined, limit: params.limit as number | undefined, maxBytes: params.maxBytes as number | undefined,
            }) };
            const kind = method.includes('.skills.') ? 'skill' : 'rule';
            const conversationId = String(params.conversationId);
            if (method.endsWith('.list')) return { ok: true, data: await instructions.list(client.principalId, conversationId, kind,
                params.cursor as string | undefined, params.limit as number | undefined) };
            if (method.endsWith('.get')) return { ok: true, data: await instructions.get(client.principalId, conversationId, kind,
                String(kind === 'skill' ? params.qualifiedName : params.sourceId)) };
            if (method.endsWith('.reload')) return await instructions.reload(client, method, params);
            return await instructions.skill(client, method, params);
        } catch (error) { return failure(error); }
    };
    return { dispatch, resolveInstructions: instructions.resolveInstructions.bind(instructions), settings, instructions };
}

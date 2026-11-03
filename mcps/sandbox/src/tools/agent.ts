import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentClient } from '../agent-client/client.js';
import { AgentFault, METHOD_SPECS, failure, validateParams, type RpcResult } from '../agent-server/protocol.js';
import { touchActivity } from '../lifecycle.js';

const actionNames = Object.keys(METHOD_SPECS) as [string, ...string[]];
export const AgentParamsSchema = z.object({
    action: z.enum(actionNames).describe('正式Agent Server方法；与CLI使用同一协议'),
    callerConversationId: z.string().min(1).max(256).describe('外部主调用方的稳定宿主会话ID，与新Agent会话ID分开'),
    callerHost: z.enum(['codex', 'antigravity', 'windsurf', 'claude-code', 'dsh', 'other']).describe('外部主调用方宿主'),
    params: z.record(z.unknown()).default({}).describe('action的方法参数；写操作需要稳定clientCommandId，重试先查原回执'),
}).strict();

interface ClientEntry {
    client: AgentClient;
    lastUsedAt: number;
    inFlight: number;
}

const clients = new Map<string, ClientEntry>();
const opening = new Map<string, Promise<ClientEntry>>();
let cleanupTimer: NodeJS.Timeout | null = null;

function identityFor(host: string, conversationId: string): string {
    return createHash('sha256').update(JSON.stringify([host, conversationId])).digest('hex');
}

async function getClient(host: string, conversationId: string): Promise<ClientEntry> {
    const key = identityFor(host, conversationId);
    const existing = clients.get(key);
    if (existing) { existing.lastUsedAt = Date.now(); return existing; }
    const pending = opening.get(key);
    if (pending) return pending;
    if (clients.size + opening.size >= 64) throw new AgentFault('CLIENT_CAPACITY', '客户端连接正在使用，请等待原调用结束', undefined, false, true);
    const work = (async () => {
        const { AgentClient: Client } = await import('../agent-client/client.js');
        const client = await Client.connect({ clientId: `mcp-${key}`, clientName: 'sandbox-agent-mcp' });
        const entry = { client, lastUsedAt: Date.now(), inFlight: 0 };
        clients.set(key, entry);
        if (!cleanupTimer) {
            cleanupTimer = setInterval(() => {
                for (const [clientKey, item] of clients) {
                    if (item.inFlight === 0 && Date.now() - item.lastUsedAt >= 120_000) {
                        clients.delete(clientKey);
                        void item.client.close();
                    }
                }
                if (clients.size === 0 && cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
            }, 30_000);
            cleanupTimer.unref();
        }
        return entry;
    })().finally(() => { opening.delete(key); });
    opening.set(key, work);
    return work;
}

export async function cleanupAgentClients(): Promise<void> {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
    await Promise.allSettled(opening.values());
    const closing = [...clients.values()].map(entry => entry.client.close());
    clients.clear();
    await Promise.allSettled(closing);
}

export function validateAgentCallParams(action: string, input: Record<string, unknown>): Record<string, unknown> {
    const temporary = action === 'conversations.create' && input.retention !== null && typeof input.retention === 'object'
        && (input.retention as { mode?: unknown }).mode === 'temporary' && input.clientCommandId === undefined;
    const params = validateParams(action, temporary ? { ...input, clientCommandId: 'temporary-create-preflight' } : input);
    if (temporary) delete params.clientCommandId;
    return params;
}

export async function handleAgentCall(input: unknown): Promise<RpcResult> {
    let entry: ClientEntry | undefined;
    try {
        const call = AgentParamsSchema.parse(input);
        const params = validateAgentCallParams(call.action, call.params);
        if (call.action === 'conversations.create') {
            params.callerHost = call.callerHost;
            params.callerConversationId = call.callerConversationId;
        }
        entry = await getClient(call.callerHost, call.callerConversationId);
        entry.inFlight += 1;
        entry.lastUsedAt = Date.now();
        return await entry.client.request(call.action, params);
    } catch (error) {
        if (error instanceof z.ZodError) return failure(new AgentFault('INVALID_PARAMS', 'sandbox_agent参数不完整或含未知字段', {
            fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }));
        return failure(error);
    } finally {
        if (entry) { entry.inFlight -= 1; entry.lastUsedAt = Date.now(); }
    }
}

export function registerAgent(server: McpServer): void {
    const description = '外部API模型会话入口，与人工sandbox_agent CLI共用独立Agent Server。'
        + '用户指定或任务确需外部模型时使用；普通辅助继续使用宿主原生子代理和工具。callerHost/callerConversationId显式标识外部主调用方，params.conversationId标识Agent会话。'
        + 'action为正式RPC方法，params按该方法schema填写，server.info返回实际已安装能力。创建须选temporary/ttl/archive，ttl须给时长。'
        + '普通资料按当前账号权限读取，写入限批准根，危险动作交主调用方批准。内部子任务默认关闭，明确启用后最多一层，规则、模型、权限及预算由主调用方指定；内部模型禁止调用模型类MCP工具。'
        + '写命令保留稳定clientCommandId；临时新建省略时由共同客户端取得服务端命令号，显式旧号沿原号查询。控制租约由共同客户端取得，接管须显式takeover。'
        + '费用默认hard；只有新累计额度definition.amountMode=estimated与根budget.costMode=estimated同时显式时才按估计运行，单次实际费用可超过估计。estimated累计额度的未知费用保留原预留并阻止同额度新增预留和派发。'
        + '未知结果先查原回执、执行及预算，停止自动重发。runs.cancel的acknowledgeUnknown=true仅在所属资源确认释放后结束本地等待，waitEnded=true时原结果和费用未知继续保留。'
        + '命令、规则选择、保存与恢复示例见包内src/agent-cli/README.md。';
    const handler = async (params: unknown) => {
        touchActivity();
        const result = await handleAgentCall(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: { ...result }, isError: !result.ok };
    };
    const compatible = server as unknown as {
        registerTool?: (name: string, config: { description: string; inputSchema: typeof AgentParamsSchema;
            annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }, callback: typeof handler) => unknown;
        tool?: (name: string, description: string, shape: typeof AgentParamsSchema.shape, callback: typeof handler) => unknown;
    };
    if (compatible.registerTool) compatible.registerTool('sandbox_agent', { description, inputSchema: AgentParamsSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }, handler);
    else if (compatible.tool) compatible.tool('sandbox_agent', description, AgentParamsSchema.shape, handler);
    else throw new Error('MCP server lacks tool registration support');
}

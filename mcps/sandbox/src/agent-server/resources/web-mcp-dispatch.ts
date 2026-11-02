import { AgentFault, canonicalJson } from '../protocol.js';
import type { BoundToolContext } from '../tools/types.js';
import { bindOwnedWebResourceCall } from '../tools/adapters/web.js';
import type { ResourceRegistry, OwnedResource } from './registry.js';
import type { OwnedWebToolName, WebMcpResourceAdapter, WebResourceReference } from './web-mcp-adapter.js';

export interface OwnedWebResourceDispatch {
    adapter: WebMcpResourceAdapter;
    registry: ResourceRegistry;
    toolName: OwnedWebToolName;
    args: Record<string, unknown>;
    context: BoundToolContext;
    outputRoot: string;
    reference?: WebResourceReference;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function result(resource: OwnedResource, output: unknown, recovered: boolean): Record<string, unknown> {
    const original = object(output) ?? { content: [{ type: 'text', text: '已查回原网页请求及所属产物引用' }] };
    return { ...original, structuredContent: { ...object(original.structuredContent),
        ownedResource: { resourceId: resource.resourceId, requestId: resource.requestId, state: resource.state,
            cleanupState: resource.cleanupState, leaseUntil: resource.leaseUntil, recovered },
        outputRefs: resource.receipt?.evidence.outputRefs ?? [] } };
}

export async function dispatchOwnedWebResource(input: OwnedWebResourceDispatch): Promise<Record<string, unknown>> {
    if (input.registry.store !== input.adapter.options.resourceStore) throw new AgentFault('INVALID_PARAMS', '网页资源登记与适配器须共用同一个ResourceStorePort');
    const call = await bindOwnedWebResourceCall(input.toolName, input.args, input.context, input.outputRoot, input.reference);
    let resource = await input.registry.create(input.adapter.adapterId, input.toolName, call as unknown as Record<string, unknown>, input.context);
    const output = input.adapter.takeOutput(resource.requestId);
    if (output !== undefined) return result(resource, output, false);
    resource = await input.registry.reconcile(resource.resourceId, input.context);
    const outputRefs = await input.adapter.verifyOutputReferences(resource, input.context.signal);
    if (resource.receipt && canonicalJson(outputRefs) !== canonicalJson(resource.receipt.evidence.outputRefs ?? [])) {
        resource = await input.registry.settleTracked(resource.resourceId, { ...resource.receipt,
            evidence: { ...resource.receipt.evidence, outputRefs } }, input.context);
    }
    return result(resource, undefined, true);
}

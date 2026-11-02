import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentFault } from '../protocol.js';
import { createAgentBaseView } from '../agent-instructions.js';
import type { ProviderProtocol } from '../providers/types.js';
import type { ResolvedInstructions } from './contracts.js';

export function createConfigurationRequestBridge(resolveInstructions: (input: {
    ownerId: string; conversationId: string; additionalInstructions?: unknown;
}) => Promise<ResolvedInstructions>) {
    const preparations = new AsyncLocalStorage<{ snapshot?: ResolvedInstructions }>();
    return {
        async resolveBaseView(input: { ownerId: string; conversationId: string; protocol: ProviderProtocol; additionalInstructions?: unknown }) {
            const snapshot = await resolveInstructions(input);
            const scope = preparations.getStore();
            if (scope) scope.snapshot = snapshot;
            return createAgentBaseView(input.protocol, snapshot.text);
        },
        async prepareView<Value extends { view: unknown }>(operation: () => Promise<Value>): Promise<Value & {
            skillVersions: Record<string, string>; ruleVersions: Record<string, string>; instructionPrefixHash: string;
        }> {
            const scope: { snapshot?: ResolvedInstructions } = {};
            return preparations.run(scope, async () => {
                const prepared = await operation();
                if (!scope.snapshot) throw new AgentFault('CONFIGURATION_REQUEST_BINDING', '请求准备没有解析对应的规则和技能版本');
                return { ...prepared, skillVersions: structuredClone(scope.snapshot.skillVersions), ruleVersions: structuredClone(scope.snapshot.ruleVersions),
                    instructionPrefixHash: scope.snapshot.prefixHash };
            });
        },
    };
}

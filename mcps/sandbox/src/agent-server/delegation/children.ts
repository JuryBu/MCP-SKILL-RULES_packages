import { randomUUID } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import { isWithin, pathIdentity } from '../security/policy.js';
import type { BoundToolContext } from '../tools/types.js';
import { ruleForTask, selectModelRules } from './rules.js';
import type { ModelRuleDocument } from './rules.js';
import type { PreparedChild } from './contracts.js';

export interface DelegationPolicy {
    allowInternalAgents?: boolean;
    depth: number;
    taskModelRules?: ModelRuleDocument | null;
    apiGlobalModelRules?: ModelRuleDocument | null;
    maxContextTokens: number;
}

export interface DelegationCatalogPort {
    resolve(profileId: string, modelId: string): Promise<{ profileRevision: number; modelId: string; reasoningEfforts: readonly string[];
        capabilities: readonly string[]; maxOutputTokens: number; available: boolean; quotaLimitId?: string | null;
        quotaScopeId?: string | null; currency?: string | null }>;
}

export class DelegationPlanner {
    constructor(readonly catalog: DelegationCatalogPort) {}

    async prepare(input: { taskKind: string; task: string; contextRefs: string[]; contextTokens: number; writeRoots: string[] },
        policy: DelegationPolicy, context: BoundToolContext): Promise<PreparedChild> {
        if (policy.allowInternalAgents !== true) throw new AgentFault('CHILD_AGENTS_DISABLED', '本次任务未由可信调用方开启内部子代理');
        if (policy.depth !== 0) throw new AgentFault('CHILD_DEPTH_EXCEEDED', '内部派发最多一层，子任务独立完成');
        if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '所属任务已取消');
        if (!input.task || !Number.isInteger(input.contextTokens) || input.contextTokens < 0 || input.contextTokens > policy.maxContextTokens) {
            throw new AgentFault('CHILD_CONTEXT_TOO_LARGE', '子任务上下文超过当前预算，请缩小选中原文范围');
        }
        const rules = selectModelRules(policy.taskModelRules, policy.apiGlobalModelRules);
        const rule = ruleForTask(rules, input.taskKind);
        const model = await this.catalog.resolve(rule.profileId, rule.modelId);
        if (!model.available || model.modelId !== rule.modelId || !model.reasoningEfforts.includes(rule.reasoningEffort)
            || rule.requiredCapabilities.some(capability => !model.capabilities.includes(capability)) || rule.maxOutputTokens > model.maxOutputTokens) {
            throw new AgentFault('MODEL_RULE_UNSUPPORTED', '当前模型目录无法满足规则指定的模型、档位或能力，保留原选择');
        }
        const roots = input.writeRoots.map(pathIdentity).filter(root => context.roots.some(allowed => isWithin(root, allowed)));
        if (roots.length !== input.writeRoots.length) throw new AgentFault('TOOL_NOT_ALLOWED', '子任务写入根须为父任务已批准范围的子集');
        await context.assertCurrent?.();
        return { childRunId: randomUUID(), rootRunId: context.rootRunId, parentRunId: context.runId, parentActionId: context.actionId,
            depth: 1, allowInternalAgents: false, conversationId: context.conversationId, task: input.task, taskKind: input.taskKind,
            contextRefs: [...input.contextRefs], historyInheritance: 'independent', writeRoots: roots,
            contextTokens: input.contextTokens,
            rulesSource: rules.source, rulesSourceId: rules.sourceId, rulesRevision: rules.revision, rulesHash: rules.hash,
            rulesDocument: structuredClone(rules.source === 'task' ? policy.taskModelRules! : policy.apiGlobalModelRules!),
            profileId: rule.profileId, profileRevision: model.profileRevision, modelId: rule.modelId, reasoningEffort: rule.reasoningEffort,
            quotaLimitId: model.quotaLimitId ?? null, quotaScopeId: model.quotaScopeId ?? null, currency: model.currency ?? null,
            maxOutputTokens: rule.maxOutputTokens, policyRevision: context.policyRevision, runEpoch: context.runEpoch,
            dispatchState: 'prepared' };
    }
}

import { z } from 'zod';
import { AgentFault, canonicalJson, failure } from '../protocol.js';
import { DelegationPlanner } from '../delegation/children.js';
import type { DelegationCatalogPort } from '../delegation/children.js';
import type { ChildSelection, InternalDelegationPort } from '../delegation/contracts.js';
import { readModelRuleDocument } from '../delegation/rules.js';
import type { ModelRuleDocument } from '../delegation/rules.js';
import type { FrozenDelegationRules } from '../delegation/rule-snapshot.js';
import type { BoundToolContext, ModelFunctionSchema, ToolExecutionResult } from './types.js';

const spawnSchema = z.object({ taskKind: z.string().min(1).max(128), task: z.string().min(1).max(65536),
    contextRefs: z.array(z.string().min(1).max(2048)).max(64).default([]), writeRoots: z.array(z.string().min(1).max(32768)).max(32).default([]),
    limits: z.object({ wallMs: z.number().int().positive().max(3600000), maxModelCalls: z.number().int().positive().max(128),
        maxCostMicros: z.number().int().nonnegative().nullable(), maxContextTokens: z.number().int().positive().max(1048576) }).strict() }).strict();
const waitSchema = z.object({ childRunId: z.string().uuid(), waitMs: z.number().int().min(0).max(45000).default(1000) }).strict();
const cancelSchema = z.object({ childRunId: z.string().uuid() }).strict();

export const DELEGATION_FUNCTION_SCHEMAS: readonly ModelFunctionSchema[] = [
    { type: 'function', name: 'child_spawn', description: '在可信调用方已开启时，按固定模型规则启动一层独立子任务，共用原根预算。',
        parameters: { ...zodObjectSchema(), required: ['taskKind', 'task', 'limits'], properties: {
            taskKind: { type: 'string' }, task: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'string' }, maxItems: 64 },
            writeRoots: { type: 'array', items: { type: 'string' }, maxItems: 32 }, limits: { ...zodObjectSchema(),
                required: ['wallMs', 'maxModelCalls', 'maxCostMicros', 'maxContextTokens'], properties: {
                    wallMs: { type: 'integer', minimum: 1, maximum: 3600000 }, maxModelCalls: { type: 'integer', minimum: 1, maximum: 128 },
                    maxCostMicros: { type: ['integer', 'null'], minimum: 0 }, maxContextTokens: { type: 'integer', minimum: 1, maximum: 1048576 } } } } } },
    { type: 'function', name: 'child_wait', description: '查询原子任务，等待到期仅返回当前事实，保留原任务和未知费用。',
        parameters: { ...zodObjectSchema(), required: ['childRunId'], properties: { childRunId: { type: 'string', format: 'uuid' },
            waitMs: { type: 'integer', minimum: 0, maximum: 45000 } } } },
    { type: 'function', name: 'child_cancel', description: '取消当前父任务所拥有的子任务，返回实际清理状态。',
        parameters: { ...zodObjectSchema(), required: ['childRunId'], properties: { childRunId: { type: 'string', format: 'uuid' } } } },
];

function zodObjectSchema() { return { type: 'object', additionalProperties: false }; }

export interface DelegationToolOptions {
    runtime: InternalDelegationPort;
    catalog: DelegationCatalogPort;
    globalModelRulesRef(profileId: string): Promise<string | null>;
    frozenRules?(context: BoundToolContext): Promise<FrozenDelegationRules>;
    selectContext?(refs: readonly string[], context: BoundToolContext): Promise<ChildSelection>;
}

export class DelegationTools {
    private readonly planner: DelegationPlanner;
    constructor(private readonly options: DelegationToolOptions) { this.planner = new DelegationPlanner(options.catalog); }

    get modelFunctionSchemas(): readonly ModelFunctionSchema[] { return structuredClone(DELEGATION_FUNCTION_SCHEMAS); }

    handles(name: string): boolean { return DELEGATION_FUNCTION_SCHEMAS.some(schema => schema.name === name || `local.${schema.name}` === name); }

    async execute(name: string, args: unknown, context: BoundToolContext): Promise<ToolExecutionResult> {
        try {
            if (name.startsWith('local.')) name = name.slice('local.'.length);
            if (name === 'child_wait') {
                const input = waitSchema.parse(args);
                return { ok: true, data: await this.options.runtime.wait(input.childRunId, input.waitMs, context) };
            }
            if (name === 'child_cancel') return { ok: true, data: await this.options.runtime.cancel(cancelSchema.parse(args).childRunId, context) };
            if (name !== 'child_spawn') throw new AgentFault('TOOL_NOT_ALLOWED', '未知内部派发工具');
            const input = spawnSchema.parse(args);
            const replay = await this.options.runtime.replay(input, context);
            if (replay) return { ok: true, data: replay };
            const policy = await this.options.runtime.policy(context);
            let taskModelRules: ModelRuleDocument | undefined;
            let apiGlobalModelRules: ModelRuleDocument | undefined;
            if (this.options.frozenRules) {
                const frozen = await this.options.frozenRules(context);
                if (frozen.source === 'task') taskModelRules = frozen.document;
                else if (frozen.source === 'api_global') apiGlobalModelRules = frozen.document;
                else throw new AgentFault('MODEL_RULES_PIN_INVALID', '固定模型规则的来源无效');
            } else {
                const taskRef = policy.options.modelRulesRef;
                const profileId = policy.options.profileId;
                const globalRef = taskRef === undefined || taskRef === null
                    ? typeof profileId === 'string' ? await this.options.globalModelRulesRef(profileId) : null : null;
                if (taskRef !== undefined && taskRef !== null && typeof taskRef !== 'string') throw new AgentFault('MODEL_RULES_INVALID', '本次规则引用须为明确文件');
                taskModelRules = typeof taskRef === 'string' ? await readModelRuleDocument(taskRef) : undefined;
                apiGlobalModelRules = globalRef ? await readModelRuleDocument(globalRef) : undefined;
            }
            const selection: ChildSelection = input.contextRefs.length
                ? this.options.selectContext ? await this.options.selectContext(input.contextRefs, context)
                    : (() => { throw new AgentFault('CHILD_CONTEXT_UNAVAILABLE', '选中上下文尚未接入原件引用解析，未读取其它对话'); })()
                : { content: {}, contextTokens: 0, provenance: [] };
            const contextTokens = Buffer.byteLength(input.task, 'utf8') + Math.max(selection.contextTokens, Buffer.byteLength(canonicalJson(selection.content), 'utf8'));
            const plan = await this.planner.prepare({ ...input, contextTokens }, { allowInternalAgents: true, depth: 0,
                maxContextTokens: Math.min(policy.maxContextTokens, input.limits.maxContextTokens), taskModelRules, apiGlobalModelRules }, context);
            return { ok: true, data: await this.options.runtime.start(plan, input.limits, { ...selection, contextTokens }, context) };
        } catch (error) {
            const result = failure(error);
            return { ...result, error: { ...(result.error ?? { code: 'INTERNAL_ERROR', message: '内部派发工具执行失败', retryable: false, mayHaveStarted: true }),
                actionId: context.actionId, attemptId: context.attemptId } };
        }
    }
}

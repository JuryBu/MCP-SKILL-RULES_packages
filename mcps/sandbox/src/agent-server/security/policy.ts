import path from 'node:path';
import { AgentFault } from '../protocol.js';
import type { EffectKind, TrustedToolContext } from '../tools/types.js';

export interface ToolEffects {
    kinds: readonly EffectKind[];
    readPaths?: readonly string[];
    writePaths?: readonly string[];
    dangerous?: boolean;
    reason?: string;
}

export interface PolicyDecision {
    decision: 'allow' | 'needs_approval' | 'deny';
    code?: string;
    reason?: string;
    paths?: string[];
    details?: Record<string, unknown>;
}

export function pathIdentity(value: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) {
        throw new AgentFault('INVALID_PARAMS', '文件路径须为完整绝对路径');
    }
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isWithin(candidate: string, root: string): boolean {
    const relative = path.relative(pathIdentity(root), pathIdentity(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function assertNotProtected(candidate: string, context: Pick<TrustedToolContext, 'protectedPaths'>): void {
    if ((context.protectedPaths ?? []).some(root => isWithin(candidate, root))) {
        throw new AgentFault('TOOL_NOT_ALLOWED', '该路径属于本机控制或凭据保留区域，任务工具禁止访问；当前执行须暂停并交主调用方核对，停止自动重试', {
            localPolicyViolation: true, source: 'local', policy: 'protected_path', paths: [candidate],
        });
    }
}

export function evaluatePolicy(effects: ToolEffects, context: TrustedToolContext): PolicyDecision {
    const paths = [...(effects.readPaths ?? []), ...(effects.writePaths ?? [])];
    for (const candidate of paths) {
        pathIdentity(candidate);
        if ((context.protectedPaths ?? []).some(root => isWithin(candidate, root))) {
            return { decision: 'deny', code: 'TOOL_NOT_ALLOWED', reason: '路径属于本机控制或凭据保留区域，请交主调用方核对并停止自动重试',
                paths: [candidate], details: { localPolicyViolation: true, source: 'local', policy: 'protected_path', paths: [candidate] } };
        }
    }
    const outside = (effects.writePaths ?? []).filter(candidate => !context.roots.some(root => isWithin(candidate, root)));
    if (outside.length) return { decision: 'needs_approval', code: 'APPROVAL_REQUIRED', reason: '需可信调用方更新获准写入根', paths: outside };
    const historyChange = (effects.writePaths ?? []).some(candidate => pathIdentity(candidate).split(path.sep).includes('.git'));
    if (effects.dangerous || effects.kinds.includes('delete') || effects.kinds.includes('configuration') || historyChange) {
        return { decision: 'needs_approval', code: 'APPROVAL_REQUIRED', reason: effects.reason ?? '该动作需要可信调用方批准', paths: [...(effects.writePaths ?? [])] };
    }
    return { decision: 'allow' };
}

export function requirePolicy(effects: ToolEffects, context: TrustedToolContext): void {
    const result = evaluatePolicy(effects, context);
    if (result.decision !== 'allow') throw new AgentFault(result.code!, result.reason!, { ...result.details, decision: result.decision, paths: result.paths ?? [] });
}

const reservedNames = new Set(['ownerId', 'owner', 'principalId', 'conversationId', 'runId', 'rootRunId', 'runEpoch',
    'policyRevision', 'credentialRef', 'authorization', 'authToken', 'apiKey', 'controlRoot', 'approvedAclRoots', 'aclApprovalId',
    'approvalId', 'pendingToolId', 'pendingExecution', 'approvalRequiredTools', 'writeRoots', 'actionId', 'attemptId', 'stepId',
    'roundId', 'callId', 'providerCallId', 'rootBudgetId', 'assertCurrent']);

export function assertModelArguments(value: unknown, depth = 0): void {
    if (depth > 20) throw new AgentFault('INVALID_PARAMS', '工具参数嵌套过深');
    if (Array.isArray(value)) {
        for (const entry of value) assertModelArguments(entry, depth + 1);
    } else if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            if (reservedNames.has(key)) throw new AgentFault('TOOL_ARGUMENT_RESERVED', '工具身份与凭据由可信核心绑定', { field: key });
            assertModelArguments(entry, depth + 1);
        }
    }
}

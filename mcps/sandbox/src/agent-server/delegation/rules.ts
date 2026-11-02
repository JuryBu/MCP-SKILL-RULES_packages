import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { AgentFault } from '../protocol.js';

export interface ModelRuleDocument {
    sourceId: string;
    revision: string;
    text: string;
}

export async function readModelRuleDocument(file: string): Promise<ModelRuleDocument> {
    let handle;
    try {
        const sourceId = await realpath(file);
        handle = await open(sourceId, 'r');
        const before = await handle.stat();
        if (!before.isFile() || before.size > 262144) throw new Error('size');
        const bytes = Buffer.alloc(262145);
        let length = 0;
        while (length < bytes.length) {
            const next = await handle.read(bytes, length, bytes.length - length, length);
            if (!next.bytesRead) break;
            length += next.bytesRead;
        }
        const after = await handle.stat();
        if (length > 262144 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new Error('changed');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
        const document = { sourceId, revision: createHash('sha256').update(text).digest('hex'), text };
        parseModelRules(document, 'task');
        return document;
    } catch {
        throw new AgentFault('MODEL_RULES_INVALID', '模型规则文件缺失、变化、超出256KiB或格式无效', { sourceId: file });
    } finally { await handle?.close(); }
}

const entrySchema = z.object({ taskKind: z.string().min(1).max(128), profileId: z.string().min(1).max(256), modelId: z.string().min(1).max(256),
    reasoningEffort: z.string().min(1).max(32), requiredCapabilities: z.array(z.string().min(1).max(128)).max(64),
    maxOutputTokens: z.number().int().min(1).max(1048576) }).strict();
const rulesSchema = z.object({ rulesVersion: z.union([z.literal('sandbox-agent-model-rules/v1'), z.literal(1)]), entries: z.array(entrySchema).min(1).max(128) }).strict();

export type DelegationModelRule = z.infer<typeof entrySchema>;

export interface FixedModelRules {
    sourceId: string;
    revision: string;
    hash: string;
    source: 'task' | 'api_global';
    entries: DelegationModelRule[];
}

export function parseModelRules(document: ModelRuleDocument, source: FixedModelRules['source']): FixedModelRules {
    try {
        if (!document.sourceId || !document.revision || Buffer.byteLength(document.text) > 262144) throw new Error('document');
        const text = document.text.trim();
        let candidate: unknown;
        if (text.startsWith('{')) candidate = JSON.parse(text);
        else {
            const blocks = [...text.matchAll(/```(?:sandbox-agent-model-rules\/v1|json)\s*\n([\s\S]*?)\n```/g)]
                .map(match => { try { return JSON.parse(match[1]); } catch { throw new Error('json-block'); } })
                .filter(block => block.rulesVersion === 'sandbox-agent-model-rules/v1' || block.rulesVersion === 1);
            if (blocks.length !== 1) throw new Error('unique-block');
            candidate = blocks[0];
        }
        const parsed = rulesSchema.parse(candidate);
        const kinds = parsed.entries.map(entry => entry.taskKind);
        if (new Set(kinds).size !== kinds.length) throw new Error('ambiguous-kind');
        return { sourceId: document.sourceId, revision: document.revision, hash: createHash('sha256').update(document.text).digest('hex'),
            source, entries: structuredClone(parsed.entries) };
    } catch {
        throw new AgentFault('MODEL_RULES_INVALID', '模型规则文档无效或任务类别匹配有歧义', { sourceId: document.sourceId, revision: document.revision });
    }
}

export function selectModelRules(taskDocument?: ModelRuleDocument | null, apiGlobalDocument?: ModelRuleDocument | null): FixedModelRules {
    if (taskDocument !== undefined && taskDocument !== null) return parseModelRules(taskDocument, 'task');
    if (apiGlobalDocument) return parseModelRules(apiGlobalDocument, 'api_global');
    throw new AgentFault('MODEL_RULES_REQUIRED', '内部派发需要本次模型规则文档或API配置的全局模型文档');
}

export function ruleForTask(rules: FixedModelRules, taskKind: string): DelegationModelRule {
    const matching = rules.entries.filter(entry => entry.taskKind === taskKind);
    if (matching.length !== 1) throw new AgentFault('MODEL_RULES_INVALID', '任务类别缺少唯一模型规则', { taskKind, sourceId: rules.sourceId });
    return structuredClone(matching[0]);
}

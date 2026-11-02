export type ChildToolRetentionMode = 'temporary' | 'ttl' | 'archive';
export type ChildToolModelEffect = 'none' | 'invokes_model' | 'unknown';
export type ChildToolAvailability = 'available' | 'unavailable' | 'disabled' | 'unknown';

export interface ChildToolArgumentPolicy {
    scope: 'all_allowed_arguments' | 'unknown';
    modelEffect: ChildToolModelEffect;
    schemaHash: string;
    adapterVersion: string;
    sourceRef: string;
}

export interface ChildToolCatalogFact {
    toolId: string;
    name: string;
    modelEffect: ChildToolModelEffect;
    availability: ChildToolAvailability;
    reason?: string | null;
    schemaHash: string | null;
    adapterVersion: string;
    retentionAvailability: Partial<Readonly<Record<ChildToolRetentionMode, ChildToolAvailability>>>;
    retentionReasons?: Partial<Readonly<Record<ChildToolRetentionMode, string>>>;
    argumentPolicy?: Readonly<ChildToolArgumentPolicy>;
}

export interface ChildToolSelectionInput {
    parentTools?: readonly unknown[];
    childRetentionMode: ChildToolRetentionMode;
}

export type ChildToolDecisionCode = 'existing_base_tool' | 'inherited_selected_non_model' | 'invalid_selection'
    | 'duplicate_selection' | 'catalog_missing' | 'catalog_ambiguous' | 'catalog_identity_invalid'
    | 'model_call' | 'model_effect_unknown' | 'catalog_unavailable' | 'retention_unavailable'
    | 'retention_unknown' | 'argument_policy_unknown';

export interface ChildToolSelectionDecision {
    requestedName: string;
    toolId: string | null;
    selectedName: string | null;
    inherited: boolean;
    code: ChildToolDecisionCode;
    reason: string;
}

export interface ChildToolSelectionResult {
    tools: readonly string[];
    sharedToolIds: readonly string[];
    decisions: readonly Readonly<ChildToolSelectionDecision>[];
}

export type ChildToolSelectionPolicy = (input: Readonly<ChildToolSelectionInput>) => ChildToolSelectionResult;

const baseTools = new Set(['read_file', 'write_file', 'list_files', 'run_command']);
const defaultTools = ['read_file', 'write_file', 'list_files'];

function argumentPolicyVerified(fact: Readonly<ChildToolCatalogFact>): boolean {
    const policy = fact.argumentPolicy;
    return Boolean(policy && policy.scope === 'all_allowed_arguments' && policy.modelEffect === 'none'
        && typeof fact.schemaHash === 'string' && /^[a-f0-9]{64}$/u.test(fact.schemaHash)
        && policy.schemaHash === fact.schemaHash && typeof fact.adapterVersion === 'string' && fact.adapterVersion.length > 0
        && policy.adapterVersion === fact.adapterVersion && typeof policy.sourceRef === 'string' && policy.sourceRef.trim().length > 0);
}

export function selectChildTools(input: Readonly<ChildToolSelectionInput>, catalog: readonly Readonly<ChildToolCatalogFact>[] = []): ChildToolSelectionResult {
    const tools: string[] = [];
    const sharedToolIds: string[] = [];
    const decisions: ChildToolSelectionDecision[] = [];
    const selected = Array.isArray(input.parentTools) ? input.parentTools : defaultTools;
    const seen = new Set<string>();
    const decide = (requestedName: string, fact: Readonly<ChildToolCatalogFact> | undefined,
        code: ChildToolDecisionCode, reason: string, inherited = false) => {
        decisions.push({ requestedName, toolId: fact?.toolId ?? null,
            selectedName: inherited ? fact?.name ?? requestedName : null, inherited, code, reason });
    };
    for (const selectedName of selected) {
        if (typeof selectedName !== 'string' || !selectedName.trim()) {
            decide(typeof selectedName === 'string' ? selectedName : '', undefined, 'invalid_selection', '父任务工具选择缺少有效名称');
            continue;
        }
        if (baseTools.has(selectedName)) {
            if (seen.has(selectedName)) { decide(selectedName, undefined, 'duplicate_selection', '同一基础工具只保留一次'); continue; }
            seen.add(selectedName);
            tools.push(selectedName);
            decide(selectedName, undefined, 'existing_base_tool', '保留父任务原有基础工具选择及原执行权限', true);
            continue;
        }
        const matches = catalog.filter(fact => fact.toolId === selectedName || fact.name === selectedName);
        if (!matches.length) { decide(selectedName, undefined, 'catalog_missing', '当前可信目录没有这项明确选择的工具'); continue; }
        if (matches.length !== 1) { decide(selectedName, undefined, 'catalog_ambiguous', '工具选择命中多个目录身份，需要先固定唯一目录记录'); continue; }
        const fact = matches[0];
        if (!fact.toolId || !fact.name || !fact.name.startsWith('mcp_')) {
            decide(selectedName, fact, 'catalog_identity_invalid', '共享工具缺少原目录ID或模型可调用名称'); continue;
        }
        if (fact.modelEffect === 'invokes_model') { decide(selectedName, fact, 'model_call', '该工具会调用模型，子任务不继承'); continue; }
        if (fact.modelEffect !== 'none') { decide(selectedName, fact, 'model_effect_unknown', '目录尚未证明该工具无模型调用'); continue; }
        if (fact.availability !== 'available') { decide(selectedName, fact, 'catalog_unavailable', fact.reason || '该工具在当前可信目录中尚不可用'); continue; }
        const retention = fact.retentionAvailability?.[input.childRetentionMode];
        if (retention !== 'available') {
            const known = retention === 'disabled' || retention === 'unavailable';
            decide(selectedName, fact, known ? 'retention_unavailable' : 'retention_unknown',
                fact.retentionReasons?.[input.childRetentionMode] || (known ? '该工具与子会话保存方式不兼容' : '该工具尚未证明兼容子会话保存方式'));
            continue;
        }
        if (!argumentPolicyVerified(fact)) {
            decide(selectedName, fact, 'argument_policy_unknown', '缺少与当前schema及适配器版本一致的全参数无模型调用证明，smart或ai_summary等分支保持不继承');
            continue;
        }
        if (seen.has(fact.name) || sharedToolIds.includes(fact.toolId)) {
            decide(selectedName, fact, 'duplicate_selection', '同一共享工具的目录ID和模型名称只继承一次'); continue;
        }
        seen.add(fact.name);
        tools.push(fact.name);
        sharedToolIds.push(fact.toolId);
        decide(selectedName, fact, 'inherited_selected_non_model', '父任务明确选择，目录及全参数策略证明无模型调用，且兼容子保存方式', true);
    }
    return Object.freeze({ tools: Object.freeze(tools), sharedToolIds: Object.freeze(sharedToolIds),
        decisions: Object.freeze(decisions.map(decision => Object.freeze(decision))) });
}

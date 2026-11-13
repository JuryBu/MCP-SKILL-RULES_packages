import type { FunctionTool } from '../providers/types.js';
import type { JsonObject } from '../protocol.js';
import { checkAbort, ContextFault } from './errors.js';
import { hashBytes } from './config.js';

export type TaskPlanWorkKind = 'simple_qa' | 'single_image' | 'multi_step';
export interface TaskPlanScope {
    conversationId: string;
    taskId: string;
    directory: string;
    workKind?: TaskPlanWorkKind;
}

export interface TaskPlanFile {
    path: string;
    text: string;
    sha256: string;
}

export interface TaskPlanSnapshot {
    scope: TaskPlanScope;
    task: TaskPlanFile | null;
    plan: TaskPlanFile | null;
    planRequired: boolean | null;
}

export interface TaskPlanFilesPort {
    read(input: { scope: TaskPlanScope; path: string; signal?: AbortSignal }): Promise<TaskPlanFile | null>;
    write(input: { scope: TaskPlanScope; path: string; text: string; expectedSha256: string | null; signal?: AbortSignal }): Promise<TaskPlanFile>;
}

export function taskPlanReadyForTakeover(snapshot?: TaskPlanSnapshot | null): boolean {
    if (!snapshot?.task || !snapshot.plan) return false;
    const paths = scopePaths(snapshot.scope);
    return (['task', 'plan'] as const).every(document => {
        const file = snapshot[document]!;
        return file.path === paths[document] && typeof file.text === 'string' && Boolean(file.text.trim())
            && file.sha256 === hashBytes(file.text);
    });
}

function scopePaths(scope: TaskPlanScope) {
    if (!scope.conversationId || !scope.taskId || scope.workKind !== undefined && !['simple_qa', 'single_image', 'multi_step'].includes(scope.workKind)
        || !scope.directory || scope.directory.startsWith('/') || /^[A-Za-z]:/.test(scope.directory)
        || scope.directory.includes('\\') || scope.directory.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new ContextFault('CONFIG_INVALID', 'Task/Plan需要明确任务身份及批准工作区内的相对目录');
    }
    return { task: `${scope.directory}/Task.md`, plan: `${scope.directory}/Plan.md` };
}

function verifyFile(file: TaskPlanFile | null, path: string, maximum: number): TaskPlanFile | null {
    if (file && (file.path !== path || typeof file.text !== 'string'
        || Buffer.byteLength(file.text) > maximum || hashBytes(file.text) !== file.sha256)) {
        throw new ContextFault('SOURCE_GAP', 'Task/Plan工作区原件的路径、大小或哈希不一致');
    }
    return file;
}

export const TASK_PLAN_TOOLS: FunctionTool[] = [
    { name: 'task_plan_read', description: 'Read the current task and plan workspace originals. Simple questions and single-image work do not require a plan.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'task_plan_write', description: 'Main model updates an actual Task.md or Plan.md file using its expected SHA256. Create a plan before multi-step work; record completion only after actual verification.',
        parameters: { type: 'object', properties: { document: { type: 'string', enum: ['task', 'plan'] },
            text: { type: 'string' }, expectedSha256: { type: ['string', 'null'] } },
        required: ['document', 'text', 'expectedSha256'], additionalProperties: false } },
];

export function createTaskPlanWorkspaceAdapter(port: TaskPlanFilesPort, maximumBytes = 64 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) throw new ContextFault('CONFIG_INVALID', 'Task/Plan读取预算须为至少1024字节的安全整数');
    const read = async (scope: TaskPlanScope, signal?: AbortSignal): Promise<TaskPlanSnapshot> => {
        checkAbort(signal);
        const paths = scopePaths(scope);
        const [task, plan] = await Promise.all([port.read({ scope, path: paths.task, signal }), port.read({ scope, path: paths.plan, signal })]);
        checkAbort(signal);
        return { scope: structuredClone(scope), task: verifyFile(task, paths.task, maximumBytes),
            plan: verifyFile(plan, paths.plan, maximumBytes), planRequired: scope.workKind === undefined ? null : scope.workKind === 'multi_step' };
    };
    const write = async (scope: TaskPlanScope, input: { document: 'task' | 'plan'; text: string; expectedSha256: string | null }, signal?: AbortSignal): Promise<TaskPlanFile> => {
        checkAbort(signal);
        const paths = scopePaths(scope);
        if (!['task', 'plan'].includes(input.document) || typeof input.text !== 'string' || !input.text.trim()
            || Buffer.byteLength(input.text) > maximumBytes
            || input.expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
            throw new ContextFault('CONFIG_INVALID', 'Task/Plan写入需要有效文档、原件哈希及有界正文');
        }
        const path = paths[input.document];
        const result = verifyFile(await port.write({ scope, path, text: input.text, expectedSha256: input.expectedSha256, signal }), path, maximumBytes)!;
        checkAbort(signal);
        if (result.text !== input.text) throw new ContextFault('SOURCE_GAP', 'Task/Plan实际写入内容与主体模型提交不同');
        const confirmed = verifyFile(await port.read({ scope, path, signal }), path, maximumBytes);
        checkAbort(signal);
        if (!confirmed || confirmed.sha256 !== result.sha256) throw new ContextFault('SOURCE_GAP', 'Task/Plan写入后查回版本不同');
        return confirmed;
    };
    const execute = async (scope: TaskPlanScope, name: string, args: JsonObject, signal?: AbortSignal): Promise<TaskPlanSnapshot | TaskPlanFile> => {
        if (name === 'task_plan_read') return read(scope, signal);
        if (name !== 'task_plan_write') throw new ContextFault('CONFIG_INVALID', '未知Task/Plan主体工具');
        if (args.document !== 'task' && args.document !== 'plan' || typeof args.text !== 'string'
            || args.expectedSha256 !== null && typeof args.expectedSha256 !== 'string') {
            throw new ContextFault('CONFIG_INVALID', 'Task/Plan主体工具参数不完整');
        }
        return write(scope, { document: args.document, text: args.text, expectedSha256: args.expectedSha256 }, signal);
    };
    return { read, write, execute, tools: structuredClone(TASK_PLAN_TOOLS) };
}

export function renderTaskPlanSnapshot(snapshot: TaskPlanSnapshot): string {
    const paths = scopePaths(snapshot.scope);
    const ready = taskPlanReadyForTakeover(snapshot);
    return ['The main task model exclusively owns workspace Task/Plan files and all task states. Compression never creates, edits or resolves task records, including before entity files exist.',
        'Simple QA and single-image work may finish directly. Multi-step work requires a workspace plan before implementation; update it as verified work changes.',
        ...(snapshot.planRequired === null ? ['Task complexity has not been preclassified. The main model decides from the actual request: establish workspace Task/Plan files before multi-step work; simple questions and single-image requests may proceed directly.'] : []),
        `Task=${snapshot.scope.taskId}; taskStateOwner=main_model; legacyRequirementsReadOnly=true; taskPlanManaged=${ready}; planRequired=${snapshot.planRequired}; planPresent=${Boolean(snapshot.plan)}; tools=task_plan_read/task_plan_write`,
        ...(!ready ? ['Preserved unfinished requirements remain handoff material until readable, non-empty Task.md and Plan.md originals are established and checked by the main model. For multi-step work, reconcile those requirements with the workspace files before taking over their state.'] : []),
        ...(snapshot.planRequired && !snapshot.plan ? ['Create Plan.md using task_plan_write before multi-step implementation tools.'] : []),
        ...(['task', 'plan'] as const).map(document => {
            const file = snapshot[document];
            return file ? `[workspace original ${file.path}; sha256=${file.sha256}]\n${file.text}` : `[workspace ${paths[document]} not created]`;
        })].join('\n\n');
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { createTaskPlanWorkspaceAdapter, TASK_PLAN_TOOLS } from '../context/task-plan.js';
import type { TaskPlanFile, TaskPlanScope, TaskPlanSnapshot, TaskPlanWorkKind } from '../context/task-plan.js';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { assertModelArguments, pathIdentity, requirePolicy } from '../security/policy.js';
import { WorkspaceFileOperations } from '../workspace/file-operations.js';
import type { WorkspaceFileOperationsOptions } from '../workspace/file-operations.js';
import { changeIdentity } from '../workspace/journal.js';
import type { ChangeAction } from '../workspace/journal.js';
import { assertReadablePath, readFilePage } from '../workspace/versions.js';
import type { FileVersion } from '../workspace/versions.js';
import type { BoundToolContext, ModelFunctionSchema, ToolExecutionResult } from './types.js';

export interface TaskPlanWriteResult extends TaskPlanFile {
    workspaceRevision: number;
    coverage: { actionIds: string[] };
}

export interface TaskPlanToolsOptions extends WorkspaceFileOperationsOptions {
    maximumBytes?: number;
    workKind?: TaskPlanWorkKind | ((context: BoundToolContext) => TaskPlanWorkKind | Promise<TaskPlanWorkKind>);
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function current(context: BoundToolContext): Promise<void> {
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', 'Task/Plan操作已取消');
    await context.assertCurrent?.();
}

export class TaskPlanTools {
    readonly fileOperations: WorkspaceFileOperations;
    readonly maximumBytes: number;
    readonly tools = structuredClone(TASK_PLAN_TOOLS).map(tool => ({ ...tool, description: `${tool.description} The main task model may add or reorder steps. Ask the initiator before removing confirmed goals or lowering acceptance criteria. The compression model never edits these files.` }));

    constructor(readonly options: TaskPlanToolsOptions) {
        this.fileOperations = new WorkspaceFileOperations(options);
        this.maximumBytes = Math.min(options.maximumBytes ?? 64 * 1024, this.fileOperations.maximum);
        if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes < 1024) {
            throw new AgentFault('INVALID_PARAMS', 'Task/Plan原件预算须为至少1024字节的安全整数');
        }
    }

    get modelFunctionSchemas(): readonly ModelFunctionSchema[] {
        return this.tools.map(tool => ({ type: 'function', ...structuredClone(tool) }));
    }

    handles(name: string): boolean { return name === 'task_plan_read' || name === 'task_plan_write'; }

    private async scope(context: BoundToolContext): Promise<TaskPlanScope> {
        if (!context?.conversationId || !context.rootRunId || !context.roots?.length || !context.signal) {
            throw new AgentFault('TOOL_CONTEXT_REQUIRED', 'Task/Plan需要可信会话身份及批准的第一工作区根');
        }
        pathIdentity(context.roots[0]);
        await current(context);
        const identity = /^[a-zA-Z0-9_-]{1,128}$/.test(context.conversationId) ? context.conversationId : hash(context.conversationId);
        const workKind = typeof this.options.workKind === 'function' ? await this.options.workKind(context) : this.options.workKind ?? 'simple_qa';
        return { conversationId: context.conversationId, taskId: context.rootRunId,
            directory: `plans/sandbox-agent-${identity}`, workKind };
    }

    private filePath(relativePath: string, context: BoundToolContext): string {
        return path.join(context.roots[0], ...relativePath.split('/'));
    }

    private adapter(context: BoundToolContext) {
        return createTaskPlanWorkspaceAdapter({
            read: input => this.readFile(input.path, context),
            write: input => this.writeFile(input.path, input.text, input.expectedSha256, context),
        }, this.maximumBytes);
    }

    async read(context: BoundToolContext): Promise<TaskPlanSnapshot> {
        const scope = await this.scope(context);
        const snapshot = await this.adapter(context).read(scope, context.signal);
        await current(context);
        return snapshot;
    }

    async execute(name: string, args: JsonObject, context: BoundToolContext): Promise<ToolExecutionResult<TaskPlanSnapshot | TaskPlanWriteResult>> {
        let scope: TaskPlanScope | undefined;
        try {
            if (!this.handles(name)) throw new AgentFault('TOOL_NOT_ALLOWED', '未注册的Task/Plan工具');
            assertModelArguments(args);
            if (!args || typeof args !== 'object' || Array.isArray(args)
                || Object.keys(args).some(key => !(name === 'task_plan_read' ? [] : ['document', 'text', 'expectedSha256']).includes(key))) {
                throw new AgentFault('INVALID_PARAMS', 'Task/Plan工具只接收文档、正文及原件哈希，身份和目录由可信上下文绑定');
            }
            scope = await this.scope(context);
            const data = await this.adapter(context).execute(scope, name, args, context.signal);
            const result = name === 'task_plan_write' ? { ...(data as TaskPlanFile), ...await this.writeCoverage(scope, context) }
                : data as TaskPlanSnapshot;
            await current(context);
            return { ok: true, data: result };
        } catch (error) {
            const fault = error instanceof AgentFault ? error : new AgentFault('TOOL_IO_FAILED', 'Task/Plan工作区操作失败', {
                systemCode: (error as NodeJS.ErrnoException)?.code ?? null,
            });
            const failure = { ...fault.toJSON(), actionId: context.actionId, attemptId: context.attemptId };
            if (name === 'task_plan_write' && scope) {
                try {
                    const actions = await Promise.all(this.actionIds(scope, context).map(actionId => this.options.journal.get(context.conversationId, actionId)));
                    const effects = actions.filter(action => action && ['applied', 'unknown', 'prepared'].includes(action.state));
                    if (effects.length) {
                        failure.mayHaveStarted = true;
                        failure.details = { ...failure.details, workspaceActions: effects.map(action => ({ actionId: action!.actionId, state: action!.state })) };
                    }
                } catch {
                    failure.mayHaveStarted = true;
                    failure.details = { ...failure.details, journalState: 'unconfirmed' };
                }
            }
            return { ok: false, error: failure };
        }
    }

    private actionIds(scope: TaskPlanScope, context: BoundToolContext): string[] {
        const parts = scope.directory.split('/');
        return [context.actionId, ...parts.map((_, index) => {
            const directory = this.filePath(parts.slice(0, index + 1).join('/'), context);
            return hash(`${context.actionId}:task-plan-directory:${directory}`);
        })];
    }

    private async writeCoverage(scope: TaskPlanScope, context: BoundToolContext): Promise<Pick<TaskPlanWriteResult, 'workspaceRevision' | 'coverage'>> {
        const actions = await Promise.all(this.actionIds(scope, context).map(actionId => this.options.journal.get(context.conversationId, actionId)));
        const write = actions[0];
        if (!write || write.state !== 'applied' || !Number.isSafeInteger(write.workspaceRevisionAfter) || write.workspaceRevisionAfter! < 0) {
            throw new AgentFault('CHANGE_COMMIT_UNKNOWN', 'Task/Plan已写入，本轮修改回执及版本尚待确认', undefined, true);
        }
        const applied = actions.filter((action): action is ChangeAction => action?.state === 'applied');
        applied.sort((first, second) => (first.workspaceRevisionAfter ?? 0) - (second.workspaceRevisionAfter ?? 0));
        return { workspaceRevision: write.workspaceRevisionAfter!, coverage: { actionIds: applied.map(action => action.actionId) } };
    }

    private async readFile(relativePath: string, context: BoundToolContext): Promise<TaskPlanFile | null> {
        await current(context);
        const filePath = this.filePath(relativePath, context);
        requirePolicy({ kinds: ['read'], readPaths: [filePath] }, context);
        const page = await readFilePage(filePath, context, 0, this.maximumBytes, this.fileOperations.files);
        if (!page.version.exists) return null;
        if (page.nextOffset !== null || page.version.byteLength > this.maximumBytes) {
            throw new AgentFault('CHANGE_PREPARE_FAILED', 'Task/Plan原件超过读取预算，请由可信调用方调整预算');
        }
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(page.bytes); }
        catch { throw new AgentFault('FILE_ENCODING_UNSUPPORTED', 'Task/Plan原件需要有效UTF-8文本'); }
        const sha256 = hash(text);
        if (page.version.sha256 !== null && page.version.sha256 !== sha256) {
            throw new AgentFault('VERSION_CONFLICT', 'Task/Plan读取期间原件已变化，请重新读取');
        }
        await current(context);
        return { path: relativePath, text, sha256 };
    }

    private requireJournal(context: BoundToolContext): void {
        const journal = this.options.journal;
        if (!journal.supportedRetentions.includes(context.retention.mode)
            || context.retention.mode !== 'temporary' && journal.persistence !== 'durable') {
            throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', 'Task/Plan写入需要与当前保存方式一致的原字节修改记录');
        }
    }

    private async ensureDirectories(relativePath: string, context: BoundToolContext): Promise<void> {
        const parts = relativePath.split('/').slice(0, -1);
        for (let index = 1; index <= parts.length; index++) {
            await current(context);
            const directory = this.filePath(parts.slice(0, index).join('/'), context);
            await assertReadablePath(directory, context);
            const version = await this.fileOperations.files.inspect(directory, context.roots);
            if (version.exists) {
                if (version.kind !== 'directory') throw new AgentFault('FILE_TYPE_UNSUPPORTED', 'Task/Plan父目录位置已被普通文件占用');
                continue;
            }
            try {
                await this.fileOperations.execute('mkdir', { path: directory, expectedVersion: version.versionToken }, {
                    ...context, actionId: hash(`${context.actionId}:task-plan-directory:${directory}`),
                });
            } catch (error) {
                if (!(error instanceof AgentFault) || error.code !== 'VERSION_CONFLICT' || error.mayHaveStarted
                    || (await this.fileOperations.files.inspect(directory, context.roots)).kind !== 'directory') throw error;
            }
        }
    }

    private checkHash(version: FileVersion, expectedSha256: string | null): void {
        if (version.exists && version.kind !== 'file') throw new AgentFault('FILE_TYPE_UNSUPPORTED', 'Task/Plan原件需要普通文件');
        if ((version.exists ? version.sha256 : null) !== expectedSha256) {
            throw new AgentFault('VERSION_CONFLICT', 'Task/Plan原件哈希已经变化，外部修改已保留，请重新读取', {
                expectedSha256, currentSha256: version.sha256, exists: version.exists,
            });
        }
    }

    private async writeFile(relativePath: string, text: string, expectedSha256: string | null, context: BoundToolContext): Promise<TaskPlanFile> {
        await current(context);
        const filePath = this.filePath(relativePath, context);
        requirePolicy({ kinds: ['write'], writePaths: [filePath] }, context);
        this.requireJournal(context);
        await assertReadablePath(filePath, context);
        const previous = await this.options.journal.get(context.conversationId, context.actionId);
        if (previous) {
            if (!['local.write_file', 'local.patch_file'].includes(previous.toolId) || pathIdentity(previous.path) !== pathIdentity(filePath)
                || previous.beforeVersion.sha256 !== expectedSha256 || !previous.after.equals(Buffer.from(text))) {
                throw new AgentFault('COMMAND_ID_REUSED', '同一Task/Plan动作的文档、正文或原件哈希已经变化');
            }
            if (previous.state !== 'applied') throw new AgentFault('RESTORE_PENDING', 'Task/Plan原动作尚待核对，请查询本轮修改记录', { state: previous.state }, previous.state !== 'failed');
            const replay = await this.readFile(relativePath, context);
            if (!replay || replay.sha256 !== previous.afterVersion?.sha256) throw new AgentFault('VERSION_CONFLICT', 'Task/Plan原动作之后已有新修改，请重新读取');
            return replay;
        }
        const observed = await this.readFile(relativePath, context);
        if ((observed?.sha256 ?? null) !== expectedSha256) {
            throw new AgentFault('VERSION_CONFLICT', 'Task/Plan原件哈希已经变化，外部修改已保留，请重新读取', { currentSha256: observed?.sha256 ?? null });
        }
        const forcedTools = ['task_plan_write', 'local.task_plan_write', ...(!observed ? ['write_file', 'local.write_file'] : [])];
        if (context.approvalRequiredTools?.some(name => forcedTools.includes(name))) {
            if (!context.approvalId) throw new AgentFault('APPROVAL_REQUIRED', 'Task/Plan写入按本次可信策略等待批准', { paths: [filePath] });
            const args = { document: relativePath.endsWith('/Task.md') ? 'task' : 'plan', text, expectedSha256 };
            await this.fileOperations.approvals.consume(context.approvalId, context, hash(canonicalJson({ name: 'task_plan_write', args })));
        }
        if (!observed) await this.ensureDirectories(relativePath, context);
        const version = await this.fileOperations.files.inspect(filePath, context.roots);
        this.checkHash(version, expectedSha256);
        if (version.exists) {
            await this.fileOperations.execute('patch_file', { path: filePath, expectedVersion: version.versionToken,
                edits: [{ offset: 0, deleteBytes: version.byteLength, content: text, encoding: 'utf8' }] }, context);
        } else {
            await this.fileOperations.coordinator.withPaths([filePath], async () => {
                await current(context);
                const beforeVersion = await this.fileOperations.files.inspect(filePath, context.roots);
                this.checkHash(beforeVersion, expectedSha256);
                const content = Buffer.from(text);
                const argsHash = hash(canonicalJson({ path: filePath, text, expectedSha256 }));
                await this.options.journal.prepare(changeIdentity(context, filePath, argsHash, beforeVersion, null, content,
                    await this.options.journal.revision(context.conversationId)));
                let committed = false;
                try {
                    await current(context);
                    const receipt = await this.fileOperations.files.commit(filePath, content, beforeVersion, context.roots, 'utf8');
                    committed = true;
                    await this.options.journal.settle(context.conversationId, context.actionId, { receipt });
                } catch (error) {
                    const fault = committed ? new AgentFault('CHANGE_COMMIT_UNKNOWN', 'Task/Plan已写入，原修改回执待确认', undefined, true)
                        : error instanceof AgentFault ? error : new AgentFault('CHANGE_COMMIT_UNKNOWN', 'Task/Plan写入结果待核对', undefined, true);
                    try { await this.options.journal.settle(context.conversationId, context.actionId, { errorCode: fault.code, unknown: fault.mayHaveStarted }); }
                    catch { throw new AgentFault(fault.code, fault.message, { ...fault.details, journalState: 'unconfirmed' }, fault.mayHaveStarted); }
                    throw fault;
                }
            });
        }
        const confirmed = await this.readFile(relativePath, context);
        if (!confirmed) throw new AgentFault('CHANGE_COMMIT_UNKNOWN', 'Task/Plan提交后原件尚未查回', undefined, true);
        return confirmed;
    }
}

export function createTaskPlanTools(options: TaskPlanToolsOptions): TaskPlanTools { return new TaskPlanTools(options); }

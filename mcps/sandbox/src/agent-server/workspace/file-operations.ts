import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AgentFault, canonicalJson } from '../protocol.js';
import { ApprovalLedger } from '../security/approvals.js';
import { evaluatePolicy, isWithin, pathIdentity, requirePolicy } from '../security/policy.js';
import type { ToolEffects } from '../security/policy.js';
import type { BoundToolContext, ModelFunctionSchema } from '../tools/types.js';
import type { StoredRestorePlan } from '../storage/workspace-port.js';
import { changeIdentity, sharedWorkspaceCoordinator } from './journal.js';
import type { ChangeAction, WorkspaceCoordinator, WorkspaceJournalPort } from './journal.js';
import { WorkspaceRestorer } from './restore.js';
import type { RestorePathResult, RestorePreviewInput } from './restore.js';
import { fileHunks, reverseTextChange } from './text-restore.js';
import { assertReadablePath, captureFile, ControlledFiles } from './versions.js';
import type { FileCommitReceipt, FileVersion } from './versions.js';

const maximumFileBytes = 8 * 1024 * 1024;
const filePath = z.string().min(1).max(32768);
const token = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const patchTarget = { path: filePath, expectedVersion: token };
const patchText = z.string().max(12 * 1024 * 1024);
const patchFileSchema = z.union([
    z.object({ ...patchTarget, oldText: patchText.min(1), newText: patchText }).strict(),
    z.object({ ...patchTarget, appendText: patchText }).strict(),
    z.object({ ...patchTarget, edits: z.array(z.object({ offset, deleteBytes: offset,
        content: patchText, encoding: z.enum(['utf8', 'base64']).default('utf8') }).strict()).min(1) }).strict(),
]);
export type PatchFileInput = z.input<typeof patchFileSchema>;
type ParsedPatchFileInput = z.output<typeof patchFileSchema>;
export const fileOperationSchemas = {
    patch_file: patchFileSchema,
    move_file: z.object({ path: filePath, destinationPath: filePath, expectedVersion: token, expectedDestinationVersion: token }).strict(),
    delete_file: z.object({ path: filePath, expectedVersion: token }).strict(),
    mkdir: z.object({ path: filePath, expectedVersion: token }).strict(),
};
export type FileOperationName = keyof typeof fileOperationSchemas;
export const FILE_OPERATION_EFFECT_KINDS = {
    patch_file: ['write'], move_file: ['write'], delete_file: ['write', 'delete'], mkdir: ['write'],
} as const;
export type FileOperationKind = 'patch' | 'move' | 'delete' | 'mkdir' | 'remove_directory' | 'remove_created_file';
export interface FileOperationMetadata {
    kind: FileOperationKind;
    destinationPath?: string;
    destinationBeforeVersion?: FileVersion;
    originActionId?: string;
}
export interface FileOperationChange extends ChangeAction { fileOperation?: FileOperationMetadata }

const pathSchema = { type: 'string', description: '获准根内完整绝对路径' };
const versionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const FILE_OPERATION_SCHEMAS: readonly ModelFunctionSchema[] = [
    { type: 'function', name: 'patch_file', description: '文本优先用oldText/newText精确替换唯一原文，或用appendText追加，不需要计算字节偏移。三种方式只能选一种，oldText须非空且唯一；不匹配或重复时保留原件并返回错误。旧edits的偏移对应同一expectedVersion且不得交叠；UTF-8文本须处于完整字符边界，明确二进制操作使用encoding=base64。',
        parameters: { type: 'object', additionalProperties: false, required: ['path', 'expectedVersion'], oneOf: [
            { required: ['oldText', 'newText'], not: { anyOf: [{ required: ['appendText'] }, { required: ['edits'] }] } },
            { required: ['appendText'], not: { anyOf: [{ required: ['oldText'] }, { required: ['newText'] }, { required: ['edits'] }] } },
            { required: ['edits'], not: { anyOf: [{ required: ['oldText'] }, { required: ['newText'] }, { required: ['appendText'] }] } },
        ], properties: {
            path: pathSchema, expectedVersion: versionSchema,
            oldText: { type: 'string', minLength: 1, description: '文件中完整、准确且只出现一次的原文；重复时增加前后文' },
            newText: { type: 'string', description: '替换后的UTF-8文本，可为空以删除唯一原文' },
            appendText: { type: 'string', description: '直接追加到文件末尾的UTF-8文本，无需offset' },
            edits: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
                required: ['offset', 'deleteBytes', 'content'], properties: { offset: { type: 'integer', minimum: 0 }, deleteBytes: { type: 'integer', minimum: 0 },
                    content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } } } },
        } } },
    { type: 'function', name: 'move_file', description: '把普通文件移到另一获准路径，两端都需准确版本且目标须缺失；记录两端和恢复原字节。',
        parameters: { type: 'object', additionalProperties: false, required: ['path', 'destinationPath', 'expectedVersion', 'expectedDestinationVersion'],
            properties: { path: pathSchema, destinationPath: pathSchema, expectedVersion: versionSchema, expectedDestinationVersion: versionSchema } } },
    { type: 'function', name: 'delete_file', description: '明确批准后删除准确版本的普通文件，先保存原字节；拒绝或取消时保留文件。',
        parameters: { type: 'object', additionalProperties: false, required: ['path', 'expectedVersion'], properties: { path: pathSchema, expectedVersion: versionSchema } } },
    { type: 'function', name: 'mkdir', description: '按缺失路径的expectedVersion创建一级目录，父目录须存在；撤回仅移除本动作创建且仍为空的目录。',
        parameters: { type: 'object', additionalProperties: false, required: ['path', 'expectedVersion'], properties: { path: pathSchema, expectedVersion: versionSchema } } },
];

function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function samePath(first: string, second: string): boolean { return pathIdentity(first) === pathIdentity(second); }
function missing(version: FileVersion): boolean { return !version.exists && version.kind === 'missing' && version.sha256 === null && version.byteLength === 0; }
function versionValid(version: FileVersion): boolean { return /^[a-f0-9]{64}$/.test(version.versionToken ?? ''); }
function decodePatchText(bytes: Buffer, source: string): string {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new AgentFault('PATCH_TEXT_ENCODING_INVALID', `${source}含非法UTF-8字节，文件保持原样；先读取原件，文本修改使用oldText/newText或appendText，明确二进制操作使用全部base64的edits`); }
}
function encodePatchText(value: string, field: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.toString('utf8') !== value) throw new AgentFault('INVALID_PARAMS', `${field}含不完整Unicode字符，请提供完整文本`, { field });
    return bytes;
}
function patchLocation(text: string, position: number): Record<string, number> {
    const prefix = text.slice(0, position);
    return { utf16Offset: position, utf8ByteOffset: Buffer.byteLength(prefix, 'utf8'),
        line: prefix.split('\n').length, utf16Column: position - prefix.lastIndexOf('\n') };
}
function patchContent(before: Buffer, patch: ParsedPatchFileInput, maximum: number): { after: Buffer; encoding?: 'utf8' } {
    if (!('edits' in patch)) {
        const text = decodePatchText(before, '原文件');
        if ('appendText' in patch) {
            const appended = encodePatchText(patch.appendText, 'appendText');
            if (before.length + appended.length > maximum) throw new AgentFault('CHANGE_PREPARE_FAILED', '补丁结果超过修改记录预算');
            return { after: Buffer.concat([before, appended]), encoding: 'utf8' };
        }
        const oldBytes = encodePatchText(patch.oldText, 'oldText');
        const newBytes = encodePatchText(patch.newText, 'newText');
        const first = text.indexOf(patch.oldText);
        if (first < 0) throw new AgentFault('PATCH_TEXT_NOT_FOUND', 'oldText未在当前文件中精确出现，请重新读取并提供完整原文，或用appendText追加；文件保持原样');
        const second = text.indexOf(patch.oldText, first + 1);
        if (second >= 0) throw new AgentFault('PATCH_TEXT_NOT_UNIQUE', 'oldText出现多处，请增加前后文使原文唯一；文件保持原样', {
            matchCountAtLeast: 2, matches: [patchLocation(text, first), patchLocation(text, second)],
        });
        if (before.length - oldBytes.length + newBytes.length > maximum) throw new AgentFault('CHANGE_PREPARE_FAILED', '补丁结果超过修改记录预算');
        const start = Buffer.byteLength(text.slice(0, first), 'utf8');
        return { after: Buffer.concat([before.subarray(0, start), newBytes, before.subarray(start + oldBytes.length)]), encoding: 'utf8' };
    }
    const textMode = patch.edits.some(edit => edit.encoding === 'utf8');
    if (textMode) decodePatchText(before, '原文件');
    let replacementBytes = 0;
    const ordered = patch.edits.map((edit, editIndex) => {
        if (edit.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(edit.content)) throw new AgentFault('INVALID_PARAMS', '补丁base64格式无效');
        const bytes = edit.encoding === 'utf8' ? encodePatchText(edit.content, `edits[${editIndex}].content`) : Buffer.from(edit.content, 'base64');
        replacementBytes += bytes.length;
        if (replacementBytes > maximum + before.length) throw new AgentFault('CHANGE_PREPARE_FAILED', '补丁替换字节超过原件及结果预算');
        return { ...edit, bytes, editIndex };
    }).sort((first, second) => first.offset - second.offset);
    const pieces: Buffer[] = [];
    let end = 0;
    let total = before.length;
    for (let index = 0; index < ordered.length; index++) {
        const edit = ordered[index];
        const next = edit.offset + edit.deleteBytes;
        if (!Number.isSafeInteger(next) || edit.offset < end || next > before.length
            || (index > 0 && edit.offset === ordered[index - 1].offset)) throw new AgentFault('INVALID_PARAMS', '补丁范围须处于原文件内，且不得交叠或使用重复偏移；文本修改优先使用oldText/newText或appendText');
        if (textMode && [edit.offset, next].some(position => position < before.length && (before[position] & 0xc0) === 0x80)) {
            throw new AgentFault('PATCH_TEXT_BOUNDARY_INVALID', '补丁字节范围切在UTF-8字符中间，文件保持原样；用oldText/newText精确替换或appendText追加，无需计算偏移', {
                editIndex: edit.editIndex, offset: edit.offset, deleteBytes: edit.deleteBytes, fileByteLength: before.length,
            });
        }
        total += edit.bytes.length - edit.deleteBytes;
        pieces.push(before.subarray(end, edit.offset), edit.bytes);
        end = next;
    }
    if (total > maximum) throw new AgentFault('CHANGE_PREPARE_FAILED', '补丁结果超过修改记录预算');
    pieces.push(before.subarray(end));
    const after = Buffer.concat(pieces);
    if (textMode) decodePatchText(after, '补丁结果');
    return { after, ...(textMode ? { encoding: 'utf8' as const } : {}) };
}
export function fileOperationPaths(action: FileOperationChange): string[] {
    return action.fileOperation?.kind === 'move' && action.fileOperation.destinationPath
        ? [action.path, action.fileOperation.destinationPath] : [action.path];
}

export function validateFileOperationPrepared(action: FileOperationChange): boolean {
    const operation = action.fileOperation;
    if (!operation) return false;
    const before = action.before === null ? null : Buffer.from(action.before);
    const after = Buffer.from(action.after);
    let valid = samePath(action.path, action.beforeVersion.canonicalPath) && versionValid(action.beforeVersion)
        && (before?.length ?? 0) <= maximumFileBytes && after.length <= maximumFileBytes;
    if (operation.kind === 'mkdir') valid &&= missing(action.beforeVersion) && before === null && after.length === 0;
    else if (operation.kind === 'remove_directory') valid &&= action.beforeVersion.exists && action.beforeVersion.kind === 'directory'
        && action.beforeVersion.sha256 === null && action.beforeVersion.byteLength === 0 && before === null && after.length === 0 && Boolean(operation.originActionId);
    else {
        valid &&= action.beforeVersion.exists && action.beforeVersion.kind === 'file' && before !== null
            && before.length === action.beforeVersion.byteLength && hash(before) === action.beforeVersion.sha256;
        if (operation.kind === 'move') valid &&= Boolean(operation.destinationPath && operation.destinationBeforeVersion
            && !samePath(action.path, operation.destinationPath) && samePath(operation.destinationPath, operation.destinationBeforeVersion.canonicalPath)
            && missing(operation.destinationBeforeVersion) && versionValid(operation.destinationBeforeVersion)) && after.length === 0;
        else if (['delete', 'remove_created_file'].includes(operation.kind)) valid &&= after.length === 0;
        else if (operation.kind !== 'patch') valid = false;
    }
    if (!valid) throw new AgentFault('VERSION_CONFLICT', '文件操作的prepared原字节、路径或版本不一致');
    return true;
}

export function validateFileOperationReceipt(action: FileOperationChange, receipt: FileCommitReceipt): boolean {
    const operation = action.fileOperation;
    if (!operation) return false;
    validateFileOperationPrepared(action);
    let valid = Boolean(receipt.receiptId) && receipt.effectState === 'applied' && receipt.cleanupState === 'released'
        && samePath(receipt.path, action.path) && receipt.beforeVersion.versionToken === action.beforeVersion.versionToken
        && samePath(receipt.afterVersion.canonicalPath, action.path) && versionValid(receipt.afterVersion);
    if (operation.kind === 'patch') valid &&= receipt.afterVersion.kind === 'file' && receipt.afterVersion.exists
        && receipt.afterVersion.sha256 === hash(Buffer.from(action.after)) && receipt.afterVersion.byteLength === action.after.length;
    else if (operation.kind === 'mkdir') valid &&= receipt.afterVersion.exists && receipt.afterVersion.kind === 'directory'
        && receipt.afterVersion.sha256 === null && receipt.afterVersion.byteLength === 0 && Boolean(receipt.afterVersion.fileId)
        && receipt.commitMode === 'single_level_directory_create' && receipt.bytesWritten === 0;
    else {
        valid &&= missing(receipt.afterVersion);
        if (operation.kind === 'move') valid &&= Boolean(receipt.destinationPath && receipt.destinationBeforeVersion && receipt.destinationAfterVersion
            && samePath(receipt.destinationPath, operation.destinationPath!) && samePath(receipt.destinationAfterVersion.canonicalPath, operation.destinationPath!)
            && receipt.destinationBeforeVersion.versionToken === operation.destinationBeforeVersion?.versionToken
            && receipt.destinationAfterVersion.exists && receipt.destinationAfterVersion.kind === 'file'
            && receipt.destinationAfterVersion.sha256 === action.beforeVersion.sha256 && receipt.destinationAfterVersion.byteLength === action.beforeVersion.byteLength
            && versionValid(receipt.destinationAfterVersion) && ['exclusive_rename_no_replace', 'verified_copy_exclusive_delete'].includes(receipt.commitMode));
        else if (operation.kind === 'delete') valid &&= receipt.commitMode === 'approved_exclusive_delete' && receipt.deletionActionId === action.actionId && receipt.bytesWritten === 0;
        else if (operation.kind === 'remove_directory') valid &&= receipt.commitMode === 'restore_created_empty_directory'
            && receipt.restoredCreationActionId === operation.originActionId;
        else if (operation.kind === 'remove_created_file') valid &&= receipt.commitMode === 'restore_created_exclusive_delete'
            && receipt.restoredCreationActionId === operation.originActionId;
    }
    if (!valid) throw new AgentFault('VERSION_CONFLICT', '文件操作回执与prepared原字节、两端或版本不一致', undefined, true);
    return true;
}

export async function reconcileFileOperationReceipt(journal: WorkspaceJournalPort, files: ControlledFiles, actionId: string,
    receipt: FileCommitReceipt, context: BoundToolContext): Promise<Record<string, unknown>> {
    await current(context);
    const action: FileOperationChange | undefined = await journal.get(context.conversationId, actionId);
    if (!action || action.runId !== context.runId || action.policyRevision !== context.policyRevision) throw new AgentFault('POLICY_CHANGED', '原文件动作不属于当前恢复上下文');
    if (!['prepared', 'unknown', 'applied'].includes(action.state)) throw new AgentFault('RESTORE_PENDING', '该动作没有待确认的原生提交');
    if (!validateFileOperationReceipt(action, receipt)) {
        if (!receipt.receiptId || !samePath(action.path, receipt.path) || receipt.beforeVersion.versionToken !== action.beforeVersion.versionToken
            || receipt.effectState !== 'applied' || receipt.cleanupState !== 'released' || receipt.afterVersion.kind !== 'file'
            || receipt.afterVersion.sha256 !== hash(Buffer.from(action.after)) || receipt.afterVersion.byteLength !== action.after.length
            || !versionValid(receipt.afterVersion)) throw new AgentFault('VERSION_CONFLICT', '原生写入回执与prepared记录不一致');
    }
    if (action.state === 'applied' && action.receipt?.receiptId !== receipt.receiptId) throw new AgentFault('COMMAND_ID_REUSED', '原动作已有不同提交回执');
    const changedPaths: string[] = [];
    for (const candidate of fileOperationPaths(action)) {
        requirePolicy({ kinds: ['write'], writePaths: [candidate] }, context);
        await assertReadablePath(candidate, context);
        const observed = await files.inspect(candidate, context.roots);
        const expected = samePath(candidate, action.path) ? receipt.afterVersion : receipt.destinationAfterVersion;
        if (observed.versionToken !== expected?.versionToken) changedPaths.push(candidate);
    }
    const settled = await journal.settle(context.conversationId, actionId, { receipt });
    return { actionId, state: settled.state, workspaceRevision: settled.workspaceRevisionAfter,
        changedPaths, laterChangesPreserved: true, repeatedFileAction: false, replayed: action.state === 'applied' };
}

export interface WorkspaceFileOperationsOptions {
    journal: WorkspaceJournalPort;
    files?: ControlledFiles;
    coordinator?: WorkspaceCoordinator;
    approvals?: ApprovalLedger;
    maxCaptureBytes?: number;
}

async function current(context: BoundToolContext): Promise<void> {
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '文件动作提交前已取消');
    await context.assertCurrent?.();
}

function requireJournal(journal: WorkspaceJournalPort, context: BoundToolContext): void {
    if (!journal.supportedRetentions.includes(context.retention.mode) || (context.retention.mode !== 'temporary' && journal.persistence !== 'durable')) {
        throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '当前保存方式需要可先提交原字节和prepared记录的工作区端口');
    }
}

export class WorkspaceFileOperations {
    readonly files: ControlledFiles;
    readonly coordinator: WorkspaceCoordinator;
    readonly approvals: ApprovalLedger;
    readonly maximum: number;
    constructor(readonly options: WorkspaceFileOperationsOptions) {
        this.files = options.files ?? new ControlledFiles();
        this.coordinator = options.coordinator ?? sharedWorkspaceCoordinator;
        this.approvals = options.approvals ?? new ApprovalLedger();
        this.maximum = Math.min(options.maxCaptureBytes ?? maximumFileBytes, maximumFileBytes);
    }
    handles(name: string): name is FileOperationName { return Object.hasOwn(fileOperationSchemas, name); }

    private async authorize(name: FileOperationName, paths: string[], context: BoundToolContext, argsHash: string): Promise<void> {
        const effects: ToolEffects = { kinds: FILE_OPERATION_EFFECT_KINDS[name], writePaths: paths };
        const decision = evaluatePolicy(effects, context);
        if (decision.decision === 'deny') throw new AgentFault(decision.code!, decision.reason!, decision.details);
        const within = paths.every(candidate => context.roots.some(root => isWithin(candidate, root)));
        const forced = context.approvalRequiredTools?.some(tool => tool === name || tool === `local.${name}`);
        if (decision.decision === 'allow' && !forced) return;
        if (context.approvalId && within) { await this.approvals.consume(context.approvalId, context, argsHash); return; }
        throw new AgentFault('APPROVAL_REQUIRED', decision.reason ?? '该文件动作按本次策略等待批准', { paths });
    }

    async execute(name: string, input: unknown, context: BoundToolContext, approvalArgsHash?: string): Promise<Record<string, unknown>> {
        if (!this.handles(name)) throw new AgentFault('TOOL_NOT_ALLOWED', '该工具未在普通文件操作目录中注册');
        const parsed = fileOperationSchemas[name].safeParse(input);
        if (!parsed.success) throw new AgentFault('INVALID_PARAMS', name === 'patch_file'
            ? 'patch_file只能选择oldText/newText（oldText非空）、appendText或edits中的一种方式，请提供完整配对参数'
            : '文件操作参数无效', { issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
        pathIdentity(parsed.data.path);
        if (name === 'move_file') pathIdentity(fileOperationSchemas.move_file.parse(parsed.data).destinationPath);
        const destinationPath = name === 'move_file' ? path.resolve(fileOperationSchemas.move_file.parse(parsed.data).destinationPath) : undefined;
        const args = { ...parsed.data, path: path.resolve(parsed.data.path), ...(destinationPath ? { destinationPath } : {}) };
        const paths = destinationPath ? [args.path, destinationPath] : [args.path];
        paths.forEach(pathIdentity);
        if (paths.length === 2 && samePath(paths[0], paths[1])) throw new AgentFault('INVALID_PARAMS', '移动需要两个不同路径');
        requireJournal(this.options.journal, context);
        const argsHash = hash(canonicalJson({ name, args }));
        const boundHash = approvalArgsHash ?? hash(canonicalJson({ name, args: input }));
        return this.coordinator.withPaths(paths, async () => {
            await current(context);
            const existing = await this.options.journal.get(context.conversationId, context.actionId);
            if (existing) {
                if (existing.argsHash !== argsHash) throw new AgentFault('COMMAND_ID_REUSED', '同一文件动作的参数已经变化');
                if (existing.state === 'applied') return { ...existing.receipt, workspaceRevision: existing.workspaceRevisionAfter, replayed: true };
                throw new AgentFault('RESTORE_PENDING', '该文件动作已有记录，请查询原动作', { state: existing.state }, existing.state !== 'failed');
            }
            await this.authorize(name, paths, context, boundHash);
            for (const candidate of paths) await assertReadablePath(candidate, context);
            const version = await this.files.inspect(args.path, context.roots);
            if (version.versionToken !== args.expectedVersion) throw new AgentFault('VERSION_CONFLICT', '原文件版本已变化，请重新读取', { currentVersion: version });
            if (name === 'mkdir' ? version.exists : !version.exists || version.kind !== 'file') throw new AgentFault('FILE_TYPE_UNSUPPORTED', '该动作需要普通文件，或创建尚未存在的一级目录');
            const before = name === 'mkdir' ? null : await captureFile(args.path, version, this.maximum);
            let destination: FileVersion | undefined;
            let after: Buffer = Buffer.alloc(0);
            let commitEncoding: 'utf8' | undefined;
            const operation: FileOperationMetadata = { kind: name === 'patch_file' ? 'patch' : name === 'move_file' ? 'move' : name === 'delete_file' ? 'delete' : 'mkdir' };
            if (name === 'move_file') {
                const move = fileOperationSchemas.move_file.parse(args);
                destination = await this.files.inspect(move.destinationPath, context.roots);
                if (destination.versionToken !== move.expectedDestinationVersion || destination.exists) throw new AgentFault('VERSION_CONFLICT', '移动目标版本已变化或目标已经存在', { currentVersion: destination });
                operation.destinationPath = move.destinationPath;
                operation.destinationBeforeVersion = destination;
            } else if (name === 'patch_file') {
                const patch = fileOperationSchemas.patch_file.parse(args);
                const patched = patchContent(before!, patch, this.maximum);
                after = patched.after;
                commitEncoding = patched.encoding;
            }
            const action: FileOperationChange = { ...changeIdentity(context, args.path, argsHash, version, before, after,
                await this.options.journal.revision(context.conversationId), `local.${name}`), fileOperation: operation };
            validateFileOperationPrepared(action);
            await this.options.journal.prepare(action);
            let committed = false;
            let nativeReceipt: FileCommitReceipt | undefined;
            try {
                await current(context);
                const receipt = name === 'patch_file' ? await this.files.commit(args.path, after, version, context.roots, commitEncoding)
                    : name === 'move_file' ? await this.files.move(args.path, operation.destinationPath!, version, destination!, context.roots, context.actionId)
                    : name === 'delete_file' ? await this.files.delete(args.path, version, context.roots, context.actionId)
                    : await this.files.mkdir(args.path, version, context.roots, context.actionId);
                committed = true;
                nativeReceipt = receipt;
                validateFileOperationReceipt(action, receipt);
                const applied = await this.options.journal.settle(context.conversationId, context.actionId, { receipt });
                return { ...receipt, workspaceRevision: applied.workspaceRevisionAfter, replayed: false };
            } catch (error) {
                const fault = committed ? new AgentFault('CHANGE_COMMIT_UNKNOWN', '文件动作已提交，原修改回执待确认', {
                    nativeReceipt, causeCode: error instanceof AgentFault ? error.code : 'CHANGE_COMMIT_UNKNOWN',
                }, true)
                    : error instanceof AgentFault ? error : new AgentFault('CHANGE_COMMIT_UNKNOWN', '文件动作效果待确认', undefined, true);
                try { await this.options.journal.settle(context.conversationId, context.actionId, { errorCode: fault.code, unknown: fault.mayHaveStarted }); }
                catch (settlementError) {
                    throw new AgentFault(fault.code, fault.message, { ...fault.details, journalState: 'unconfirmed',
                        journalErrorCode: settlementError instanceof AgentFault ? settlementError.code : 'STORAGE_RESPONSE_INVALID' }, fault.mayHaveStarted);
                }
                throw fault;
            }
        });
    }
}

interface OperationRestoreStep {
    kind: 'write' | 'move' | 'mkdir' | 'remove_created_file' | 'remove_directory';
    path: string;
    destinationPath?: string;
    actionId: string;
    originActionId: string;
    targetBase64?: string;
    code?: string;
    restoredHunks?: string[];
    conflictedHunks?: string[];
}
interface OperationRestorePlan {
    fileOperationsVersion: 1;
    restorePlanId: string;
    input: RestorePreviewInput;
    principalId: string;
    conversationId: string;
    policyRevision: number;
    rootsHash: string;
    actionIds: string[];
    baselines: FileVersion[];
    operations: OperationRestoreStep[];
    state: 'preview' | 'committing' | 'complete' | 'pending';
    results: OperationRestoreResult[];
    commandId?: string;
    historyReceipt?: Record<string, unknown>;
    revision: number;
}
interface OperationRestoreResult extends RestorePathResult { nativeReceipt?: FileCommitReceipt; causeCode?: string }
interface VirtualFile { version: FileVersion; bytes: Buffer | null; touched: boolean }

export class FileOperationsRestorer extends WorkspaceRestorer {
    private rootsDigest(context: BoundToolContext): string { return hash(canonicalJson([...context.roots])); }

    private async operationPlan(planId: string, context: BoundToolContext): Promise<OperationRestorePlan | undefined> {
        const stored = await this.planStore.get(planId);
        if (!stored || stored.data.fileOperationsVersion !== 1) return undefined;
        const plan = structuredClone(stored.data) as unknown as OperationRestorePlan;
        if (stored.restorePlanId !== plan.restorePlanId || stored.conversationId !== plan.conversationId || !Array.isArray(plan.operations)
            || !Array.isArray(plan.baselines)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '文件操作恢复计划与索引不一致');
        if (plan.principalId !== context.principalId || plan.conversationId !== context.conversationId) throw new AgentFault('TOOL_NOT_ALLOWED', '恢复计划未绑定当前可信主体');
        plan.revision = stored.revision;
        return plan;
    }

    private async operationPlanForExecution(planId: string, context: BoundToolContext): Promise<OperationRestorePlan | undefined> {
        const plan = await this.operationPlan(planId, context);
        if (plan && (plan.policyRevision !== context.policyRevision || plan.rootsHash !== this.rootsDigest(context))) throw new AgentFault('POLICY_CHANGED', '恢复预览后的有效写入策略已经变化');
        return plan;
    }

    private async storeOperationPlan(plan: OperationRestorePlan, expectedRevision: number | null = plan.revision): Promise<void> {
        const stored: StoredRestorePlan = { restorePlanId: plan.restorePlanId, conversationId: plan.conversationId, principalId: plan.principalId,
            mode: plan.input.mode, historyEpoch: plan.input.expectedHistoryEpoch, workspaceRevision: plan.input.expectedWorkspaceRevision,
            policyRevision: plan.policyRevision, state: plan.state, actionIds: [...plan.actionIds], data: { ...plan }, revision: plan.revision };
        plan.revision = (await this.planStore.put(stored, expectedRevision)).revision;
    }

    private describeOperationPlan(plan: OperationRestorePlan): Record<string, unknown> {
        return { restorePlanId: plan.restorePlanId, mode: plan.input.mode, state: plan.state, revision: plan.revision,
            policyRevision: plan.policyRevision, rootsHash: plan.rootsHash,
            expectedHistoryEpoch: plan.input.expectedHistoryEpoch, expectedWorkspaceRevision: plan.input.expectedWorkspaceRevision,
            actionIds: [...plan.actionIds], operations: plan.operations.map(step => ({ path: step.path, destinationPath: step.destinationPath ?? null,
                operation: step.kind, conflict: step.code ?? null, targetSha256: step.targetBase64 === undefined ? null : hash(Buffer.from(step.targetBase64, 'base64')),
                currentVersion: plan.baselines.find(version => samePath(version.canonicalPath, step.path)) ?? null })),
            results: structuredClone(plan.results), historyReceipt: plan.historyReceipt ?? null,
            coverage: { restoreSupport: 'file-bytes-text-hunks-move-delete-created-directory',
                unavailable: ['未记录的命令、MCP及远端效果'], historyCommit: this.core ? 'core-port-required-and-bound' : 'not-bound' } };
    }

    private chooseOperationActions(all: FileOperationChange[], input: RestorePreviewInput, roundIds?: string[]): FileOperationChange[] {
        if (input.mode === 'round_restart') {
            if (!input.roundId || input.actionIds || input.paths || input.hunks) throw new AgentFault('INVALID_PARAMS', '重做一轮只接受目标roundId');
            if (roundIds) return all.filter(action => action.state !== 'failed' && roundIds.includes(action.roundId));
            const first = all.findIndex(action => action.roundId === input.roundId);
            return first < 0 ? [] : all.slice(first).filter(action => action.state !== 'failed');
        }
        if (!input.actionIds?.length && !input.paths?.length && !input.roundId && !input.hunks?.length) throw new AgentFault('INVALID_PARAMS', '文件恢复需要明确选择动作、路径、片段或轮次');
        return all.filter(action => action.state !== 'failed' && (!input.actionIds || input.actionIds.includes(action.actionId))
            && (!input.roundId || action.roundId === input.roundId) && (!input.hunks || input.hunks.some(selection => selection.actionId === action.actionId))
            && (!input.paths || input.paths.some(selected => fileOperationPaths(action).some(candidate => samePath(candidate, selected)))));
    }

    override async preview(input: RestorePreviewInput, context: BoundToolContext, restorePlanId?: string): Promise<Record<string, unknown>> {
        requireJournal(this.journal, context);
        await current(context);
        if (context.retention.mode !== 'temporary' && this.planStore.persistence !== 'durable') throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '持久恢复需要持久计划端口');
        if (!['files_only', 'round_restart'].includes(input.mode) || !Number.isSafeInteger(input.expectedHistoryEpoch) || input.expectedHistoryEpoch < 0
            || !Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 0) throw new AgentFault('INVALID_PARAMS', '恢复模式或版本无效');
        if (restorePlanId) {
            const previous = await this.operationPlanForExecution(restorePlanId, context);
            if (previous) {
                if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentFault('COMMAND_ID_REUSED', '原恢复预览已绑定不同选择或版本');
                return this.describeOperationPlan(previous);
            }
            if (await this.planStore.get(restorePlanId)) return super.preview(input, context, restorePlanId);
        }
        if (await this.journal.revision(context.conversationId) !== input.expectedWorkspaceRevision) throw new AgentFault('VERSION_CONFLICT', '工作区版本已变化，请重新预览');
        const selection = await this.core?.validatePreview?.(input, context);
        const selected = this.chooseOperationActions(await this.journal.list(context.conversationId), input, selection?.roundIds);
        if (!selected.some(action => action.fileOperation && action.fileOperation.kind !== 'patch')) return super.preview(input, context, restorePlanId);
        if (input.hunks?.some(item => !selected.some(action => action.actionId === item.actionId))) throw new AgentFault('INVALID_PARAMS', '所选片段不属于当前恢复动作');
        const paths = [...new Map(selected.flatMap(fileOperationPaths).map(candidate => [pathIdentity(candidate), candidate])).values()];
        const states = new Map<string, VirtualFile>();
        const baselines: FileVersion[] = [];
        for (const candidate of paths) {
            requirePolicy({ kinds: ['write'], writePaths: [candidate] }, context);
            await assertReadablePath(candidate, context);
            const version = await this.files.inspect(candidate, context.roots);
            baselines.push(version);
            states.set(pathIdentity(candidate), { version, bytes: version.kind === 'file' ? await captureFile(candidate, version, maximumFileBytes) : null, touched: false });
        }
        const virtual = (candidate: string): VirtualFile => states.get(pathIdentity(candidate))!;
        const replace = (candidate: string, version: FileVersion, bytes: Buffer | null) => {
            states.set(pathIdentity(candidate), { version: { ...structuredClone(version), canonicalPath: candidate }, bytes, touched: true });
            for (const state of states.values()) if (state.version.kind === 'directory' && samePath(path.dirname(candidate), state.version.canonicalPath)) {
                const entries = new Set(state.version.entryNames ?? []);
                const name = path.basename(candidate);
                for (const entry of entries) if (samePath(path.join(state.version.canonicalPath, entry), candidate)) entries.delete(entry);
                if (version.exists) entries.add(name);
                state.version = { ...state.version, entryNames: [...entries].sort() };
                state.touched = true;
            }
        };
        const matches = (state: VirtualFile, expected?: FileVersion): boolean => Boolean(expected && state.version.exists === expected.exists
            && state.version.kind === expected.kind && (state.touched || state.version.versionToken === expected.versionToken));
        const operations: OperationRestoreStep[] = [];
        for (const action of [...selected].reverse()) {
            const state = virtual(action.path);
            const operation = action.fileOperation;
            const step: OperationRestoreStep = { kind: 'write', path: action.path, actionId: randomUUID(), originActionId: action.actionId };
            if (action.state !== 'applied' || !action.afterVersion) step.code = 'RESTORE_PENDING';
            else if (operation?.kind === 'move') {
                if (input.hunks?.some(item => item.actionId === action.actionId)) throw new AgentFault('INVALID_PARAMS', '移动必须选择完整对象');
                step.kind = 'move'; step.path = operation.destinationPath!; step.destinationPath = action.path;
                const destination = virtual(operation.destinationPath!);
                if (!matches(state, action.afterVersion) || state.version.exists || !matches(destination, action.receipt?.destinationAfterVersion)
                    || destination.bytes === null || action.before === null || !destination.bytes.equals(Buffer.from(action.before))) step.code = 'RESTORE_CONFLICT';
                else {
                    replace(action.path, action.beforeVersion, Buffer.from(action.before));
                    replace(operation.destinationPath!, operation.destinationBeforeVersion!, null);
                }
            } else if (operation?.kind === 'mkdir') {
                step.kind = 'remove_directory';
                if (input.hunks?.some(item => item.actionId === action.actionId)) throw new AgentFault('INVALID_PARAMS', '新目录必须选择完整对象');
                if (!state.version.exists || state.version.kind !== 'directory' || state.version.fileId !== action.afterVersion.fileId
                    || state.version.volumeId !== action.afterVersion.volumeId || state.version.attributes !== action.afterVersion.attributes
                    || (!state.touched && state.version.versionToken !== action.afterVersion.versionToken)
                    || (state.version.entryNames?.length ?? 0) !== 0) step.code = 'RESTORE_CONFLICT';
                else replace(action.path, action.beforeVersion, null);
            } else if (operation?.kind === 'remove_directory') {
                step.kind = 'mkdir';
                if (input.hunks?.some(item => item.actionId === action.actionId)) throw new AgentFault('INVALID_PARAMS', '目录恢复必须选择完整对象');
                if (!matches(state, action.afterVersion) || state.version.exists || (action.beforeVersion.entryNames?.length ?? 0) !== 0) step.code = 'RESTORE_CONFLICT';
                else replace(action.path, action.beforeVersion, null);
            } else if (operation?.kind === 'delete' || operation?.kind === 'remove_created_file' || action.toolId === 'local.restore_created_file') {
                if (input.hunks?.some(item => item.actionId === action.actionId)) throw new AgentFault('INVALID_PARAMS', '删除恢复必须选择完整对象');
                if (!matches(state, action.afterVersion) || state.version.exists || action.before === null) step.code = 'RESTORE_CONFLICT';
                else { step.targetBase64 = Buffer.from(action.before).toString('base64'); replace(action.path, action.beforeVersion, Buffer.from(action.before)); }
            } else if (action.before === null) {
                step.kind = 'remove_created_file';
                if (input.hunks?.some(item => item.actionId === action.actionId)) throw new AgentFault('INVALID_PARAMS', '新建文件必须选择完整对象');
                if (!matches(state, action.afterVersion) || state.bytes === null || !state.bytes.equals(Buffer.from(action.after))) step.code = 'RESTORE_CONFLICT';
                else replace(action.path, action.beforeVersion, null);
            } else if (state.bytes === null || state.version.kind !== 'file') step.code = 'RESTORE_CONFLICT';
            else {
                const before = Buffer.from(action.before); const after = Buffer.from(action.after);
                const selectedHunks = input.hunks?.find(item => item.actionId === action.actionId)?.hunkIds;
                if (!matches(state, action.afterVersion) && fileHunks(before, after) === null) step.code = 'RESTORE_CONFLICT';
                else {
                    const reversed = !selectedHunks && state.bytes.equals(after) ? { bytes: before, restoredHunks: [], conflictedHunks: [] }
                        : reverseTextChange(before, after, state.bytes, selectedHunks);
                    step.targetBase64 = reversed.bytes.toString('base64');
                    step.restoredHunks = reversed.restoredHunks; step.conflictedHunks = reversed.conflictedHunks;
                    if (reversed.conflictedHunks.length && !reversed.restoredHunks.length && reversed.bytes.equals(state.bytes)) step.code = 'RESTORE_CONFLICT';
                    else replace(action.path, action.beforeVersion, reversed.bytes);
                }
            }
            operations.push(step);
        }
        const plan: OperationRestorePlan = { fileOperationsVersion: 1, restorePlanId: restorePlanId ?? randomUUID(), input: structuredClone(input),
            principalId: context.principalId, conversationId: context.conversationId, policyRevision: context.policyRevision, rootsHash: this.rootsDigest(context),
            actionIds: selected.map(action => action.actionId), baselines, operations, state: 'preview', results: [], revision: 0 };
        try { await this.storeOperationPlan(plan, null); }
        catch (error) {
            if (error instanceof AgentFault && error.code === 'WORKSPACE_CAS_CONFLICT') {
                const previous = await this.operationPlanForExecution(plan.restorePlanId, context);
                if (previous && canonicalJson(previous.input) === canonicalJson(input)) return this.describeOperationPlan(previous);
            }
            throw error;
        }
        return this.describeOperationPlan(plan);
    }

    override async get(planId: string, context: BoundToolContext): Promise<Record<string, unknown>> {
        const plan = await this.operationPlan(planId, context);
        return plan ? this.describeOperationPlan(plan) : super.get(planId, context);
    }

    private stepPaths(step: OperationRestoreStep): string[] { return step.destinationPath ? [step.path, step.destinationPath] : [step.path]; }

    private async applyOperationStep(step: OperationRestoreStep, versions: Map<string, FileVersion>, context: BoundToolContext, planId: string): Promise<RestorePathResult> {
        const paths = this.stepPaths(step);
        for (const candidate of paths) {
            requirePolicy({ kinds: ['write'], writePaths: [candidate] }, context);
            await assertReadablePath(candidate, context);
            const observed = await this.files.inspect(candidate, context.roots);
            if (observed.versionToken !== versions.get(pathIdentity(candidate))?.versionToken) throw new AgentFault('VERSION_CONFLICT', '预览后文件对象已变化');
        }
        const version = versions.get(pathIdentity(step.path))!;
        const before = version.kind === 'file' ? await captureFile(step.path, version, maximumFileBytes) : null;
        const target = step.kind === 'write' ? Buffer.from(step.targetBase64!, 'base64') : Buffer.alloc(0);
        const metadata: FileOperationMetadata | undefined = step.kind === 'move' ? { kind: 'move', destinationPath: step.destinationPath,
            destinationBeforeVersion: versions.get(pathIdentity(step.destinationPath!)) }
            : step.kind === 'mkdir' ? { kind: 'mkdir' }
            : step.kind === 'remove_directory' ? { kind: 'remove_directory', originActionId: step.originActionId }
            : step.kind === 'remove_created_file' ? { kind: 'remove_created_file', originActionId: step.originActionId } : undefined;
        const action: FileOperationChange = { ...changeIdentity({ ...context, actionId: step.actionId }, step.path,
            hash(canonicalJson({ planId, step })), version, before, target, await this.journal.revision(context.conversationId),
            step.kind === 'remove_created_file' ? 'local.restore_created_file' : `local.restore_${step.kind}`), ...(metadata ? { fileOperation: metadata } : {}) };
        if (step.kind === 'remove_created_file') action.restoreCreatedFrom = { creationActionId: step.originActionId, lastActionId: step.originActionId, expectedSha256: version.sha256! };
        if (metadata) validateFileOperationPrepared(action);
        await this.journal.prepare(action);
        let committed = false;
        let nativeReceipt: FileCommitReceipt | undefined;
        try {
            await current(context);
            const receipt = step.kind === 'move' ? await this.files.move(step.path, step.destinationPath!, version, versions.get(pathIdentity(step.destinationPath!))!, context.roots, step.actionId)
                : step.kind === 'mkdir' ? await this.files.mkdir(step.path, version, context.roots, step.actionId)
                : step.kind === 'remove_directory' ? await this.files.restoreCreatedDirectory(step.path, version, context.roots, step.originActionId)
                : step.kind === 'remove_created_file' ? await this.files.restoreCreated(step.path, version, context.roots, action.restoreCreatedFrom!)
                : await this.files.commit(step.path, target, version, context.roots);
            committed = true;
            nativeReceipt = receipt;
            if (metadata) validateFileOperationReceipt(action, receipt);
            await this.journal.settle(context.conversationId, step.actionId, { receipt });
            versions.set(pathIdentity(step.path), receipt.afterVersion);
            if (receipt.destinationAfterVersion) versions.set(pathIdentity(receipt.destinationPath!), receipt.destinationAfterVersion);
            for (const [key, directory] of versions) if (directory.kind === 'directory' && paths.some(candidate => samePath(path.dirname(candidate), directory.canonicalPath))) {
                const observed = await this.files.inspect(directory.canonicalPath, context.roots);
                if (observed.fileId !== directory.fileId || observed.volumeId !== directory.volumeId || observed.attributes !== directory.attributes) throw new AgentFault('CHANGE_COMMIT_UNKNOWN', '恢复期间目录身份或属性变化', undefined, true);
                versions.set(key, observed);
            }
            return { path: step.path, status: 'restored', actionId: step.actionId, receiptId: receipt.receiptId,
                operation: step.kind === 'remove_created_file' ? 'remove_created_file' : 'restore_file', restoredHunks: step.restoredHunks, conflictedHunks: step.conflictedHunks };
        } catch (error) {
            const unknown = committed || !(error instanceof AgentFault) || error.mayHaveStarted;
            const code = error instanceof AgentFault ? error.code : 'RESTORE_PENDING';
            const details = nativeReceipt ? { nativeReceipt, causeCode: code } : undefined;
            try { await this.journal.settle(context.conversationId, step.actionId, { errorCode: code, unknown }); }
            catch (settlementError) {
                throw new AgentFault(code, '文件操作恢复的原回执与记录状态待确认', { ...details, journalState: 'unconfirmed',
                    journalErrorCode: settlementError instanceof AgentFault ? settlementError.code : 'STORAGE_RESPONSE_INVALID' }, unknown);
            }
            throw new AgentFault(code, '文件操作恢复尚未完整结清，请查询原计划', details, unknown);
        }
    }

    private async operationHistory(plan: OperationRestorePlan, context: BoundToolContext): Promise<void> {
        if (plan.results.some(result => result.status === 'failed' || result.status === 'unknown')) { plan.state = 'pending'; return; }
        try {
            plan.historyReceipt = await this.core!.commitHistory({ restorePlanId: plan.restorePlanId, mode: plan.input.mode,
                expectedHistoryEpoch: plan.input.expectedHistoryEpoch, workspaceRevision: await this.journal.revision(context.conversationId),
                targetRoundId: plan.input.roundId ?? null, actionIds: plan.actionIds, files: structuredClone(plan.results) }, context);
            plan.state = 'complete';
        } catch { plan.state = 'pending'; }
    }

    override async commit(planId: string, clientCommandId: string, context: BoundToolContext): Promise<Record<string, unknown>> {
        const plan = await this.operationPlanForExecution(planId, context);
        if (!plan) return super.commit(planId, clientCommandId, context);
        if (!clientCommandId) throw new AgentFault('INVALID_PARAMS', '恢复提交需要稳定clientCommandId');
        if (plan.commandId && plan.commandId !== clientCommandId) throw new AgentFault('COMMAND_ID_REUSED', '该预览已绑定另一提交命令');
        if (plan.state === 'complete' || plan.state === 'pending') return this.describeOperationPlan(plan);
        if (plan.state === 'committing') throw new AgentFault('RESTORE_PENDING', '原恢复正在提交，请查询同一计划');
        if (!this.core) throw new AgentFault('RESTORE_PENDING', '文件恢复需要核心安全停止点和历史提交端口');
        await current(context);
        const guard = await this.core.quiesce({ restorePlanId: planId, mode: plan.input.mode, expectedHistoryEpoch: plan.input.expectedHistoryEpoch,
            expectedWorkspaceRevision: plan.input.expectedWorkspaceRevision, targetRoundId: plan.input.roundId ?? null }, context);
        try {
            return await this.coordinator.withPaths(plan.baselines.map(version => version.canonicalPath), async () => {
                if (await this.journal.revision(context.conversationId) !== plan.input.expectedWorkspaceRevision) throw new AgentFault('VERSION_CONFLICT', '预览后工作区已有其它修改');
                const versions = new Map(plan.baselines.map(version => [pathIdentity(version.canonicalPath), version]));
                const blocked = new Set<string>();
                for (const version of plan.baselines) {
                    const observed = await this.files.inspect(version.canonicalPath, context.roots);
                    if (observed.versionToken !== version.versionToken) blocked.add(pathIdentity(version.canonicalPath));
                }
                plan.state = 'committing'; plan.commandId = clientCommandId;
                await this.storeOperationPlan(plan);
                for (const step of plan.operations) {
                    const paths = this.stepPaths(step);
                    let result: OperationRestoreResult;
                    const code = step.code ?? (paths.some(candidate => blocked.has(pathIdentity(candidate))) ? 'RESTORE_CONFLICT' : undefined);
                    if (code) result = { path: step.path, actionId: step.actionId, status: code === 'RESTORE_CONFLICT' ? 'skipped_conflict' : 'failed', code };
                    else {
                        try { result = await this.applyOperationStep(step, versions, context, planId); }
                        catch (error) {
                            const unknown = !(error instanceof AgentFault) || error.mayHaveStarted;
                            const failure = error instanceof AgentFault ? error.code : 'RESTORE_PENDING';
                            result = { path: step.path, actionId: step.actionId, status: unknown ? 'unknown' : failure === 'VERSION_CONFLICT' ? 'skipped_conflict' : 'failed', code: failure,
                                ...(error instanceof AgentFault && error.details?.nativeReceipt
                                    ? { nativeReceipt: error.details.nativeReceipt as unknown as FileCommitReceipt, causeCode: failure } : {}) };
                        }
                    }
                    if (result.status !== 'restored') for (const candidate of paths) blocked.add(pathIdentity(candidate));
                    plan.results.push(result);
                    if (result.status === 'unknown') plan.state = 'pending';
                    await this.storeOperationPlan(plan);
                    if (plan.state === 'pending') return this.describeOperationPlan(plan);
                }
                await this.operationHistory(plan, context);
                await this.storeOperationPlan(plan);
                return this.describeOperationPlan(plan);
            });
        } finally { await guard.release(); }
    }

    override async recover(planId: string, context: BoundToolContext): Promise<Record<string, unknown>> {
        const plan = await this.operationPlanForExecution(planId, context);
        if (!plan) return super.recover(planId, context);
        if (plan.state === 'preview' || plan.state === 'complete') return this.describeOperationPlan(plan);
        if (!this.core || !plan.commandId) throw new AgentFault('RESTORE_PENDING', '恢复查回需要原提交标识和核心安全停止点');
        await current(context);
        const revision = await this.journal.revision(context.conversationId);
        const guard = await this.core.quiesce({ restorePlanId: planId, mode: plan.input.mode, expectedHistoryEpoch: plan.input.expectedHistoryEpoch,
            expectedWorkspaceRevision: revision, targetRoundId: plan.input.roundId ?? null }, context);
        try {
            return await this.coordinator.withPaths(plan.baselines.map(version => version.canonicalPath), async () => {
                if (await this.journal.revision(context.conversationId) !== revision) throw new AgentFault('VERSION_CONFLICT', '查回期间工作区版本已经变化');
                const own = new Set(plan.operations.map(step => step.actionId));
                const later = (await this.journal.list(context.conversationId)).filter(action => (action.workspaceRevisionAfter ?? -1) > plan.input.expectedWorkspaceRevision
                    || action.state === 'prepared' || action.state === 'unknown');
                if (later.some(action => !own.has(action.actionId))) throw new AgentFault('VERSION_CONFLICT', '原恢复之后已有其它动作，保留文件并等待核对');
                const results: RestorePathResult[] = [];
                for (const step of plan.operations) {
                    const action = await this.journal.get(context.conversationId, step.actionId);
                    const saved = plan.results.find(result => result.actionId === step.actionId || (!result.actionId && samePath(result.path, step.path)));
                    if (action?.state === 'applied' && action.receipt) results.push({ path: step.path, actionId: step.actionId, receiptId: action.receipt.receiptId, status: 'restored',
                        operation: step.kind === 'remove_created_file' ? 'remove_created_file' : 'restore_file' });
                    else if (saved && saved.status !== 'unknown') results.push(saved);
                    else results.push({ path: step.path, actionId: step.actionId, status: 'unknown', code: 'RESTORE_PENDING' });
                }
                plan.results = results;
                await this.operationHistory(plan, context);
                await this.storeOperationPlan(plan);
                return this.describeOperationPlan(plan);
            });
        } finally { await guard.release(); }
    }
}

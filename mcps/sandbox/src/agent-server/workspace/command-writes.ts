import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AgentFault } from '../protocol.js';
import { pathIdentity, requirePolicy } from '../security/policy.js';
import type { BoundToolContext } from '../tools/types.js';
import { changeIdentity } from './journal.js';
import type { ChangeAction, WorkspaceCoordinator, WorkspaceJournalPort } from './journal.js';
import { captureFile } from './versions.js';
import type { ControlledFiles, FileCommitReceipt } from './versions.js';

export interface DeclaredCommandWorkspace {
    journal: WorkspaceJournalPort;
    files: ControlledFiles;
    coordinator: WorkspaceCoordinator;
    maxCaptureBytes?: number;
}

export async function withDeclaredCommandWrites<Value extends { terminalConfirmed: boolean; cleanupState: string; coverage: Record<string, unknown> }>(
    workspace: DeclaredCommandWorkspace, writeSet: readonly string[], context: BoundToolContext, argsHash: string,
    execute: () => Promise<Value>): Promise<Value> {
    const paths = [...new Map(writeSet.map(candidate => [pathIdentity(candidate), path.resolve(candidate)])).values()];
    if (!paths.length) return execute();
    const journal = workspace.journal;
    if (!journal.supportedRetentions.includes(context.retention.mode)
        || context.retention.mode !== 'temporary' && journal.persistence !== 'durable') {
        throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '声明文件写集合需要当前保存方式的工作区记录', { commandStarted: false });
    }
    return workspace.coordinator.withPaths(paths, async () => {
        const prepared: ChangeAction[] = [];
        const omitted: { path: string; reason: string }[] = [];
        const recorded: string[] = [];
        const maximum = Math.min(workspace.maxCaptureBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024);
        try {
            for (const candidate of paths) {
                requirePolicy({ kinds: ['write'], writePaths: [candidate] }, context);
                await context.assertCurrent?.();
                if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '声明文件记录准备前已取消', { commandStarted: false });
                const information = await stat(candidate).catch(error => {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    return undefined;
                });
                if (information?.isDirectory() || information && (!information.isFile() || information.size > maximum)) {
                    omitted.push({ path: candidate, reason: information.isDirectory() ? 'directory_effects_untracked'
                        : information.isFile() ? 'file_capture_limit' : 'file_type_untracked' });
                    continue;
                }
                const version = await workspace.files.inspect(candidate, context.roots);
                if (version.kind === 'directory' || version.byteLength > maximum) {
                    omitted.push({ path: candidate, reason: version.kind === 'directory' ? 'directory_effects_untracked' : 'file_capture_limit' });
                    continue;
                }
                const before = await captureFile(candidate, version, maximum);
                const actionId = createHash('sha256').update(JSON.stringify([context.actionId, pathIdentity(candidate)])).digest('hex');
                const action = changeIdentity({ ...context, actionId }, candidate, argsHash, version, before, Buffer.alloc(0),
                    await journal.revision(context.conversationId), 'local.run_command');
                action.commandActionId = context.actionId;
                await journal.prepare(action);
                prepared.push(action);
            }
            for (const action of prepared) {
                const current = await workspace.files.inspect(action.path, context.roots);
                if (current.versionToken !== action.beforeVersion.versionToken) throw new AgentFault('VERSION_CONFLICT', '命令启动前声明文件已变化', { commandStarted: false });
            }
        } catch (error) {
            for (const action of prepared) await journal.settle(context.conversationId, action.actionId, { errorCode: 'COMMAND_NOT_STARTED' });
            throw error;
        }
        let result: Value | undefined;
        let failure: unknown;
        try { result = await execute(); }
        catch (error) { failure = error; }
        const fault = failure instanceof AgentFault ? failure : undefined;
        const terminal = result ? result.terminalConfirmed && result.cleanupState === 'released'
            : fault?.details?.terminalConfirmed === true && fault.details.cleanupState === 'released';
        const notStarted = fault?.details?.commandStarted === false && fault.details.commandStartedKnown !== false && !fault.mayHaveStarted;
        for (const action of prepared) {
            if (notStarted) {
                await journal.settle(context.conversationId, action.actionId, { errorCode: 'COMMAND_NOT_STARTED' });
                continue;
            }
            if (!terminal) {
                await journal.settle(context.conversationId, action.actionId, { errorCode: 'COMMAND_TERMINAL_UNCONFIRMED', unknown: true });
                omitted.push({ path: action.path, reason: 'command_terminal_unconfirmed' });
                continue;
            }
            try {
                const afterVersion = await workspace.files.inspect(action.path, context.roots);
                if (afterVersion.kind !== 'file' || afterVersion.byteLength > maximum) throw new AgentFault('COMMAND_FILE_CAPTURE_PARTIAL', '命令后文件缺失、成为目录或超过记录预算');
                const after = await captureFile(action.path, afterVersion, maximum);
                if (!after) throw new AgentFault('COMMAND_FILE_CAPTURE_PARTIAL', '命令后字节尚未确认');
                if (afterVersion.versionToken === action.beforeVersion.versionToken) {
                    await journal.settle(context.conversationId, action.actionId, { errorCode: 'COMMAND_NO_FILE_CHANGE' });
                    continue;
                }
                const receipt: FileCommitReceipt = { receiptId: randomUUID(), path: action.path, beforeVersion: action.beforeVersion,
                    afterVersion, atomic: false, commitMode: 'command_observed_file', bytesWritten: after.length,
                    effectState: 'applied', cleanupState: 'released', committedAt: new Date().toISOString(),
                    commandObservation: { afterBase64: after.toString('base64') } };
                await journal.settle(context.conversationId, action.actionId, { receipt });
                recorded.push(action.actionId);
            } catch (error) {
                const code = error instanceof AgentFault ? error.code : 'COMMAND_FILE_CAPTURE_PARTIAL';
                await journal.settle(context.conversationId, action.actionId, { errorCode: code, unknown: true });
                omitted.push({ path: action.path, reason: code });
            }
        }
        const coverage = { ...(result?.coverage ?? {}), include: paths, restoreSupport: 'partial', actionIds: recorded,
            fileRestoreSupport: recorded.length ? 'recorded_before_after_versions' : 'no_recorded_file_change', omitted,
            workspaceRevision: await journal.revision(context.conversationId),
            unknownEffects: ['声明写集合以外的文件改动', '联网产生的远端效果', ...omitted.map(item => item.reason)] };
        if (failure) {
            if (fault) throw new AgentFault(fault.code, fault.message, { ...fault.details, coverage }, fault.mayHaveStarted);
            throw new AgentFault('COMMAND_RESULT_UNCONFIRMED', '原命令结果待核对，声明文件的准备记录已保留', { coverage }, true);
        }
        return { ...result!, coverage };
    });
}

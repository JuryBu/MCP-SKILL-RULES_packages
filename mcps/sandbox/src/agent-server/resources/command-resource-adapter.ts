import { AgentFault } from '../protocol.js';
import type { OwnedResource, ResourceAdapter, ResourceReceipt } from './registry.js';
import { readWindowsJobMetadata } from '../../windows-job-runner.js';

export interface CommandResourceOperations {
    cancel(resourceId: string): Promise<ResourceReceipt | undefined>;
}

export function readOriginalCommandReceipt(resource: OwnedResource): ResourceReceipt {
    const original = structuredClone(resource.receipt ?? { started: null, terminalConfirmed: false,
        released: false, evidence: { resourceId: resource.resourceId, actionId: resource.actionId,
            requestId: resource.requestId, recoveryState: 'original_receipt_pending' } });
    if (original.released && original.terminalConfirmed) return original;
    const metadataPath = original.evidence.recoveryMetadataPath;
    const metadata = typeof metadataPath === 'string' ? readWindowsJobMetadata(metadataPath) : null;
    if (metadata && original.evidence.helperExited === true && original.evidence.forcedStop !== true
        && metadata.terminalConfirmed && metadata.activeProcessesAtRelease === 0 && metadata.cleanupState === 'released') {
        return { ...original, started: metadata.commandStarted, terminalConfirmed: true, released: true,
            evidence: { ...original.evidence, commandStarted: metadata.commandStarted,
                commandStartedKnown: true, terminalConfirmed: true, cleanupState: 'released',
                childExitCode: metadata.childExitCode, activeProcessesAtRelease: 0, jobMetadata: metadata,
                manualReviewRequired: false, recoveryState: 'original_job_terminal_confirmed' } };
    }
    return { ...original, evidence: { ...original.evidence, recoveryState: 'original_receipt_pending',
        manualReviewRequired: true, stopAutomaticRetry: true,
        ...(metadata ? { jobMetadata: metadata } : {}) } };
}

export function createCommandResourceAdapter(operations: CommandResourceOperations): ResourceAdapter {
    const read = async (resource: OwnedResource) => readOriginalCommandReceipt(resource);
    const cancel = async (resource: OwnedResource) => await operations.cancel(resource.resourceId) ?? readOriginalCommandReceipt(resource);
    return {
        adapterId: 'native.command',
        supports: { authenticated: true, findByRequest: true, finiteLease: true, status: true,
            renew: true, cancel: true, release: true, ephemeralContent: true },
        async create() { throw new AgentFault('COMMAND_TRACKED_ONLY', '普通命令只由原执行器登记，不通过资源恢复重复启动'); },
        findByRequest: read,
        status: read,
        async renew(resource, leaseUntil) {
            if (!Number.isFinite(Date.parse(leaseUntil))) throw new AgentFault('INVALID_PARAMS', '命令资源查询租约无效');
            return read(resource);
        },
        cancel,
        release: cancel,
        prepareTemporaryClose: cancel,
    };
}

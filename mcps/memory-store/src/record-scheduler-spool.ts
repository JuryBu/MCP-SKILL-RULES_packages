import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { ImmutableBlobReference } from "./record-scheduler-contracts.js";

export const RECORD_SCHEDULER_SPOOL_KINDS = ["source", "output"] as const;
export type RecordSchedulerSpoolKind = typeof RECORD_SCHEDULER_SPOOL_KINDS[number];

export const RECORD_SCHEDULER_SPOOL_FAULT_POINTS = [
    "before-private-root-mkdir",
    "after-private-root-mkdir",
    "before-root-manifest-link",
    "after-root-manifest-link-before-directory-sync",
    "after-root-manifest-link",
    "before-task-manifest-link",
    "after-task-manifest-link-before-directory-sync",
    "after-task-manifest-link",
    "before-blob-temp-write",
    "after-blob-temp-write",
    "before-blob-link",
    "after-blob-link-before-directory-sync",
    "after-blob-link",
    "before-blob-readback",
    "after-blob-readback",
    "before-task-tombstone-link",
    "after-task-tombstone-link-before-directory-sync",
    "after-task-tombstone-link",
    "before-task-manifest-seal",
    "after-task-manifest-rename-before-directory-sync",
    "after-task-manifest-seal",
    "before-cancel-scan",
    "after-cancel-scan",
    "before-cancel-unlink",
    "after-cancel-unlink",
] as const;

export type RecordSchedulerSpoolFaultPoint = typeof RECORD_SCHEDULER_SPOOL_FAULT_POINTS[number];

export interface RecordSchedulerSpoolFaultEvent {
    point: RecordSchedulerSpoolFaultPoint;
    operation: "initialize" | "write" | "read" | "cancel";
    taskId?: string;
    kind?: RecordSchedulerSpoolKind;
    reference?: ImmutableBlobReference;
}

export type RecordSchedulerSpoolFaultInjector = (event: Readonly<RecordSchedulerSpoolFaultEvent>) => void | Promise<void>;

export interface RecordSchedulerSpoolDirectoryDurabilityAdapter {
    sync(directoryPath: string, mutation: "mkdir" | "link" | "rename" | "unlink" | "create-temp"): Promise<void>;
}

export interface RecordSchedulerSpoolDurabilityProfile {
    processCrashAndHotRestart: "supported";
    directoryEntrySync: "posix_fsync" | "windows_unavailable" | "injected_adapter";
    suddenPowerLossDirectoryEntriesGuaranteed: boolean;
}

export interface RecordSchedulerTaskCancellationProof {
    taskId: string;
    ledgerRevision: number;
    ledgerHash: string;
    cancellationEvidenceId: string;
    verifiedAt: string;
}

export interface RecordSchedulerSpoolReleaseProof {
    taskId: string;
    kind: RecordSchedulerSpoolKind;
    reference: ImmutableBlobReference;
    ledgerRevision: number;
    ledgerHash: string;
    cancellationEvidenceId: string;
    releaseEvidenceId: string;
    verifiedAt: string;
}

export interface RecordSchedulerSpoolProofVerifier {
    verifyTaskCancellation(proof: Readonly<RecordSchedulerTaskCancellationProof>): Promise<boolean>;
    verifyBlobRelease(proof: Readonly<RecordSchedulerSpoolReleaseProof>): Promise<boolean>;
}

export interface RecordSchedulerSpoolOptions {
    dataRoot: string;
    proofVerifier?: RecordSchedulerSpoolProofVerifier;
    directoryDurability?: RecordSchedulerSpoolDirectoryDurabilityAdapter;
    faultInjector?: RecordSchedulerSpoolFaultInjector;
}

export interface InitializeRecordSchedulerSpoolRootInput {
    mode: "create" | "open";
}

export interface InitializeRecordSchedulerSpoolRootResult {
    disposition: "created" | "existing";
    rootManifestRef: ImmutableBlobReference;
    durability: RecordSchedulerSpoolDurabilityProfile;
}

export interface InitializeRecordSchedulerSpoolTaskInput {
    taskId: string;
    mode: "create" | "open";
}

export interface InitializeRecordSchedulerSpoolTaskResult {
    disposition: "created" | "existing";
    state: "open" | "sealed";
    manifestRef: ImmutableBlobReference;
    durability: RecordSchedulerSpoolDurabilityProfile;
}

export interface WriteRecordSchedulerSpoolBlobInput {
    taskId: string;
    kind: RecordSchedulerSpoolKind;
    content: string | Uint8Array;
}

export interface WriteRecordSchedulerSpoolBlobResult {
    reference: ImmutableBlobReference;
    disposition: "published" | "existing";
    durability: RecordSchedulerSpoolDurabilityProfile;
}

export interface ReadRecordSchedulerSpoolBlobInput {
    taskId: string;
    kind: RecordSchedulerSpoolKind;
    reference: ImmutableBlobReference;
}

export interface CancelRecordSchedulerSpoolTaskInput {
    taskId: string;
    cancellationProof: RecordSchedulerTaskCancellationProof;
    releaseProofs: RecordSchedulerSpoolReleaseProof[];
}

export interface RecordSchedulerSpoolRetainedBlob {
    reference: ImmutableBlobReference;
    reason: "missing_release_proof" | "mismatched_release_proof" | "release_proof_rejected";
}

export interface RecordSchedulerSpoolCancellationEvidence {
    disposition: "sealed" | "already_sealed";
    taskId: string;
    taskManifestRef: ImmutableBlobReference;
    taskTombstoneRef: ImmutableBlobReference;
    removed: ImmutableBlobReference[];
    retained: RecordSchedulerSpoolRetainedBlob[];
    removedTemporaryFiles: number;
    cleanupComplete: boolean;
    spoolVisible: boolean;
    durability: RecordSchedulerSpoolDurabilityProfile;
}

export type RecordSchedulerSpoolRepairReason = "invalid_reference"
    | "missing_private_root"
    | "missing_root_manifest"
    | "corrupt_root_manifest"
    | "private_root_replaced"
    | "missing_task_manifest"
    | "corrupt_task_manifest"
    | "missing_task_tombstone"
    | "corrupt_task_tombstone"
    | "missing_blob"
    | "corrupt_blob"
    | "unsafe_spool_path"
    | "unexpected_task_artifact";

export class RecordSchedulerSpoolRepairRequiredError extends Error {
    readonly repairState = "RepairRequired" as const;

    constructor(
        readonly reason: RecordSchedulerSpoolRepairReason,
        readonly reference?: ImmutableBlobReference,
    ) {
        super(`Record scheduler spool requires repair: ${reason}`);
        this.name = "RecordSchedulerSpoolRepairRequiredError";
    }
}

export class RecordSchedulerSpoolTaskSealedError extends Error {
    constructor(readonly taskId: string) {
        super(`Record scheduler spool task is sealed: ${taskId}`);
        this.name = "RecordSchedulerSpoolTaskSealedError";
    }
}

export class RecordSchedulerSpoolDiscardDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RecordSchedulerSpoolDiscardDeniedError";
    }
}

export class RecordSchedulerSpoolDurabilityError extends Error {
    readonly durability = "unconfirmed" as const;

    constructor(
        readonly mutation: "mkdir" | "link" | "rename" | "unlink" | "create-temp",
        readonly directoryPath: string,
        readonly causeCode?: string,
    ) {
        super(`Record scheduler spool directory durability is unconfirmed after ${mutation}${causeCode ? ` (${causeCode})` : ""}`);
        this.name = "RecordSchedulerSpoolDurabilityError";
    }
}

interface RootManifest {
    schemaVersion: 2;
    kind: "record-scheduler-spool-root";
    privateRootName: string;
}

interface OpenTaskManifest {
    schemaVersion: 2;
    kind: "record-scheduler-spool-task";
    taskId: string;
    taskHash: string;
    generation: 1;
    state: "open";
}

interface SealedTaskManifest {
    schemaVersion: 2;
    kind: "record-scheduler-spool-task";
    taskId: string;
    taskHash: string;
    generation: 2;
    state: "sealed";
    previousManifestHash: string;
    tombstoneRef: ImmutableBlobReference;
}

type TaskManifest = OpenTaskManifest | SealedTaskManifest;

interface TaskTombstone {
    schemaVersion: 2;
    kind: "record-scheduler-spool-task-tombstone";
    taskId: string;
    taskHash: string;
    cancellationProof: RecordSchedulerTaskCancellationProof;
}

interface FileRead<Value> {
    value: Value;
    bytes: Buffer;
    reference: ImmutableBlobReference;
}

interface RootIdentity {
    dev: number;
    ino: number;
    realPath: string;
}

interface TaskStateRead {
    manifest: FileRead<TaskManifest>;
    tombstone?: FileRead<TaskTombstone>;
    phase: "open" | "sealing" | "sealed";
}

interface FlatBlobEntry {
    fileName: string;
    absolutePath: string;
    kind: RecordSchedulerSpoolKind;
    reference: ImmutableBlobReference;
}

interface PublishHooks {
    operation: RecordSchedulerSpoolFaultEvent["operation"];
    taskId?: string;
    kind?: RecordSchedulerSpoolKind;
    reference?: ImmutableBlobReference;
    beforeLink: RecordSchedulerSpoolFaultPoint;
    afterLinkBeforeSync: RecordSchedulerSpoolFaultPoint;
    afterLink: RecordSchedulerSpoolFaultPoint;
    afterTemporaryWrite?: RecordSchedulerSpoolFaultPoint;
    preLink?: () => Promise<void>;
}

const PRIVATE_ROOT_NAME = ".record-scheduler-spool-v2";
const ROOT_MANIFEST_FILE_NAME = ".record-scheduler-spool-v2.root.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BLOB_FILE_PATTERN = /^b\.([a-f0-9]{64})\.([so])\.([a-f0-9]{64})\.([0-9]+)\.blob$/;

export function hashRecordSchedulerSpoolContent(content: string | Uint8Array): string {
    return hashBuffer(toBuffer(content));
}

export function byteLengthRecordSchedulerSpoolContent(content: string | Uint8Array): number {
    return toBuffer(content).byteLength;
}

export function calculateRecordSchedulerSpoolCancellationEvidenceId(input: {
    dataRoot: string;
    taskId: string;
    ledgerRevision: number;
    ledgerHash: string;
}): string {
    return hashBuffer(Buffer.from(stableJson({
        schemaVersion: 1,
        purpose: "record-scheduler-spool-cancellation",
        rootNamespace: rootNamespace(input.dataRoot),
        taskId: input.taskId,
        ledgerRevision: input.ledgerRevision,
        ledgerHash: input.ledgerHash,
    }), "utf8"));
}

export function calculateRecordSchedulerSpoolReleaseEvidenceId(input: {
    dataRoot: string;
    taskId: string;
    kind: RecordSchedulerSpoolKind;
    reference: ImmutableBlobReference;
    ledgerRevision: number;
    ledgerHash: string;
    cancellationEvidenceId: string;
    verifiedAt: string;
}): string {
    return hashBuffer(Buffer.from(stableJson({
        schemaVersion: 1,
        purpose: "record-scheduler-spool-release",
        rootNamespace: rootNamespace(input.dataRoot),
        taskId: input.taskId,
        kind: input.kind,
        reference: input.reference,
        ledgerRevision: input.ledgerRevision,
        ledgerHash: input.ledgerHash,
        cancellationEvidenceId: input.cancellationEvidenceId,
        verifiedAt: input.verifiedAt,
    }), "utf8"));
}

export class RecordSchedulerSpool {
    private readonly dataRoot: string;
    private readonly privateRoot: string;
    private readonly rootManifestPath: string;
    private readonly proofVerifier?: RecordSchedulerSpoolProofVerifier;
    private readonly directoryDurability?: RecordSchedulerSpoolDirectoryDurabilityAdapter;
    private readonly faultInjector?: RecordSchedulerSpoolFaultInjector;
    private dataRootIdentity?: RootIdentity;
    private privateRootIdentity?: RootIdentity;

    constructor(options: RecordSchedulerSpoolOptions) {
        if (!isAbsolutePath(options.dataRoot)) throw new Error("Record scheduler spool dataRoot must be an absolute path");
        this.dataRoot = path.resolve(options.dataRoot);
        this.privateRoot = path.join(this.dataRoot, PRIVATE_ROOT_NAME);
        this.rootManifestPath = path.join(this.dataRoot, ROOT_MANIFEST_FILE_NAME);
        this.proofVerifier = options.proofVerifier;
        this.directoryDurability = options.directoryDurability;
        this.faultInjector = options.faultInjector;
    }

    getDurabilityProfile(): RecordSchedulerSpoolDurabilityProfile {
        if (this.directoryDurability) {
            return {
                processCrashAndHotRestart: "supported",
                directoryEntrySync: "injected_adapter",
                suddenPowerLossDirectoryEntriesGuaranteed: false,
            };
        }
        if (process.platform === "win32") {
            return {
                processCrashAndHotRestart: "supported",
                directoryEntrySync: "windows_unavailable",
                suddenPowerLossDirectoryEntriesGuaranteed: false,
            };
        }
        return {
            processCrashAndHotRestart: "supported",
            directoryEntrySync: "posix_fsync",
            suddenPowerLossDirectoryEntriesGuaranteed: true,
        };
    }

    async initializeRoot(input: InitializeRecordSchedulerSpoolRootInput): Promise<InitializeRecordSchedulerSpoolRootResult> {
        const dataRootIdentity = await this.readDirectoryIdentity(this.dataRoot, "missing_private_root");
        const rootMetadata = await this.optionalLstat(this.privateRoot);
        const rootManifestMetadata = await this.optionalLstat(this.rootManifestPath);
        let disposition: "created" | "existing" = "existing";

        if (input.mode === "open") {
            if (!rootMetadata) throw new RecordSchedulerSpoolRepairRequiredError("missing_private_root");
            if (!rootManifestMetadata) throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
        } else if (!rootMetadata && !rootManifestMetadata) {
            await this.inject({ point: "before-private-root-mkdir", operation: "initialize" });
            await fs.mkdir(this.privateRoot);
            await this.syncDirectory(this.dataRoot, "mkdir");
            await this.inject({ point: "after-private-root-mkdir", operation: "initialize" });
            disposition = "created";
        } else if (!rootMetadata || !rootManifestMetadata) {
            if (!rootMetadata) throw new RecordSchedulerSpoolRepairRequiredError("missing_private_root");
            if (input.mode !== "create" || (await fs.readdir(this.privateRoot)).length > 0) {
                throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
            }
        }

        const privateRootIdentity = await this.readDirectoryIdentity(this.privateRoot, "missing_private_root");
        this.assertNestedRealPath(dataRootIdentity.realPath, privateRootIdentity.realPath);
        this.dataRootIdentity = dataRootIdentity;
        this.privateRootIdentity = privateRootIdentity;

        const rootManifestBytes = Buffer.from(JSON.stringify(rootManifestValue()), "utf8");
        const rootManifestReference = this.referenceForDataRootFile(ROOT_MANIFEST_FILE_NAME, rootManifestBytes);
        if (!await this.pathExists(this.rootManifestPath)) {
            if (input.mode !== "create") throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
            await this.publishDataRootImmutable(this.rootManifestPath, rootManifestBytes, {
                operation: "initialize",
                beforeLink: "before-root-manifest-link",
                afterLinkBeforeSync: "after-root-manifest-link-before-directory-sync",
                afterLink: "after-root-manifest-link",
            });
            disposition = "created";
        }
        const rootManifest = await this.readRootManifest();
        if (!sameReference(rootManifest.reference, rootManifestReference)) {
            throw new RecordSchedulerSpoolRepairRequiredError("corrupt_root_manifest", rootManifest.reference);
        }
        await this.verifyRootIdentity();
        return { disposition, rootManifestRef: rootManifest.reference, durability: this.getDurabilityProfile() };
    }

    async initializeTask(input: InitializeRecordSchedulerSpoolTaskInput): Promise<InitializeRecordSchedulerSpoolTaskResult> {
        this.assertTaskId(input.taskId);
        await this.requireRoot();
        const taskHash = taskIdHash(input.taskId);
        const manifestPath = this.privateFile(taskManifestFileName(taskHash));
        const existingManifest = await this.readTaskManifestIfPresent(input.taskId);
        if (existingManifest) {
            const state = await this.readTaskState(input.taskId);
            return {
                disposition: "existing",
                state: state.phase === "open" ? "open" : "sealed",
                manifestRef: state.manifest.reference,
                durability: this.getDurabilityProfile(),
            };
        }
        if (input.mode !== "create") throw new RecordSchedulerSpoolRepairRequiredError("missing_task_manifest");
        if (await this.hasTaskArtifacts(taskHash)) throw new RecordSchedulerSpoolRepairRequiredError("missing_task_manifest");

        const manifest: OpenTaskManifest = {
            schemaVersion: 2,
            kind: "record-scheduler-spool-task",
            taskId: input.taskId,
            taskHash,
            generation: 1,
            state: "open",
        };
        const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
        const reference = this.referenceForPrivateFile(taskManifestFileName(taskHash), bytes);
        await this.publishPrivateImmutable(manifestPath, bytes, taskHash, {
            operation: "initialize",
            taskId: input.taskId,
            reference,
            beforeLink: "before-task-manifest-link",
            afterLinkBeforeSync: "after-task-manifest-link-before-directory-sync",
            afterLink: "after-task-manifest-link",
        });
        const readBack = await this.readTaskManifest(input.taskId);
        if (!sameReference(readBack.reference, reference)) {
            throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_manifest", readBack.reference);
        }
        return { disposition: "created", state: "open", manifestRef: readBack.reference, durability: this.getDurabilityProfile() };
    }

    async writeImmutable(input: WriteRecordSchedulerSpoolBlobInput): Promise<WriteRecordSchedulerSpoolBlobResult> {
        this.assertTaskId(input.taskId);
        this.assertKind(input.kind);
        await this.assertTaskOpen(input.taskId);
        const content = toBuffer(input.content);
        const reference = this.createBlobReference(input.taskId, input.kind, content);
        const destination = this.absoluteReferencePath(reference);
        if (await this.pathExists(destination)) {
            await this.inject({ point: "before-blob-readback", operation: "write", taskId: input.taskId, kind: input.kind, reference });
            await this.verifyBlob(reference);
            await this.assertTaskOpen(input.taskId);
            await this.inject({ point: "after-blob-readback", operation: "write", taskId: input.taskId, kind: input.kind, reference });
            return { reference, disposition: "existing", durability: this.getDurabilityProfile() };
        }

        await this.inject({ point: "before-blob-temp-write", operation: "write", taskId: input.taskId, kind: input.kind, reference });
        let disposition: "published" | "existing";
        try {
            disposition = await this.publishPrivateImmutable(destination, content, taskIdHash(input.taskId), {
                operation: "write",
                taskId: input.taskId,
                kind: input.kind,
                reference,
                beforeLink: "before-blob-link",
                afterLinkBeforeSync: "after-blob-link-before-directory-sync",
                afterLink: "after-blob-link",
                afterTemporaryWrite: "after-blob-temp-write",
                preLink: () => this.assertTaskOpen(input.taskId),
            });
        } catch (error) {
            if (errorCode(error) === "ENOENT") {
                const state = await this.readTaskState(input.taskId);
                if (state.phase !== "open") throw new RecordSchedulerSpoolTaskSealedError(input.taskId);
            }
            throw error;
        }
        try {
            await this.assertTaskOpen(input.taskId);
            await this.inject({ point: "before-blob-readback", operation: "write", taskId: input.taskId, kind: input.kind, reference });
            await this.verifyBlob(reference);
            await this.assertTaskOpen(input.taskId);
            await this.inject({ point: "after-blob-readback", operation: "write", taskId: input.taskId, kind: input.kind, reference });
        } catch (error) {
            if (disposition === "published" && error instanceof RecordSchedulerSpoolTaskSealedError) {
                await this.removeOwnedUnreturnedBlob(reference);
            }
            throw error;
        }
        return { reference, disposition, durability: this.getDurabilityProfile() };
    }

    async readImmutable(input: ReadRecordSchedulerSpoolBlobInput): Promise<Buffer> {
        this.assertTaskId(input.taskId);
        this.assertKind(input.kind);
        await this.assertTaskOpen(input.taskId);
        this.validateBlobReference(input.taskId, input.kind, input.reference);
        await this.inject({ point: "before-blob-readback", operation: "read", taskId: input.taskId, kind: input.kind, reference: input.reference });
        const content = await this.verifyBlob(input.reference);
        await this.assertTaskOpen(input.taskId);
        await this.inject({ point: "after-blob-readback", operation: "read", taskId: input.taskId, kind: input.kind, reference: input.reference });
        return content;
    }

    async cancelTask(input: CancelRecordSchedulerSpoolTaskInput): Promise<RecordSchedulerSpoolCancellationEvidence> {
        this.assertTaskId(input.taskId);
        await this.requireRoot();
        const initialState = await this.readTaskState(input.taskId);
        const cancellationProof = cloneCancellationProof(input.cancellationProof);
        this.assertCancellationProofShape(cancellationProof, input.taskId);
        await this.verifyCancellationAuthority(cancellationProof);

        let tombstone = initialState.tombstone;
        let disposition: "sealed" | "already_sealed" = tombstone ? "already_sealed" : "sealed";
        if (tombstone) {
            if (!sameCancellationProof(tombstone.value.cancellationProof, cancellationProof)) {
                throw new RecordSchedulerSpoolDiscardDeniedError("Task tombstone is bound to different cancellation evidence");
            }
        } else {
            const taskHash = taskIdHash(input.taskId);
            const tombstoneValue: TaskTombstone = {
                schemaVersion: 2,
                kind: "record-scheduler-spool-task-tombstone",
                taskId: input.taskId,
                taskHash,
                cancellationProof,
            };
            const bytes = Buffer.from(JSON.stringify(tombstoneValue), "utf8");
            const tombstoneFile = taskTombstoneFileName(taskHash);
            const reference = this.referenceForPrivateFile(tombstoneFile, bytes);
            await this.publishPrivateImmutable(this.privateFile(tombstoneFile), bytes, taskHash, {
                operation: "cancel",
                taskId: input.taskId,
                reference,
                beforeLink: "before-task-tombstone-link",
                afterLinkBeforeSync: "after-task-tombstone-link-before-directory-sync",
                afterLink: "after-task-tombstone-link",
                preLink: async () => {
                    const current = await this.readTaskState(input.taskId);
                    if (current.phase === "sealed" && !current.tombstone) {
                        throw new RecordSchedulerSpoolRepairRequiredError("missing_task_tombstone");
                    }
                },
            });
            tombstone = await this.readTaskTombstone(input.taskId);
            if (!sameReference(tombstone.reference, reference)) {
                throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_tombstone", tombstone.reference);
            }
        }

        const sealedManifest = await this.sealTaskManifest(input.taskId, tombstone);
        const releaseProofs = input.releaseProofs.map(cloneReleaseProof);
        const cleanup = await this.cleanupCancelledTask(input.taskId, tombstone, releaseProofs);
        return {
            disposition,
            taskId: input.taskId,
            taskManifestRef: sealedManifest.reference,
            taskTombstoneRef: tombstone.reference,
            removed: cleanup.removed,
            retained: cleanup.retained,
            removedTemporaryFiles: cleanup.removedTemporaryFiles,
            cleanupComplete: cleanup.retained.length === 0 && cleanup.remainingArtifacts === 0,
            spoolVisible: cleanup.retained.length > 0 || cleanup.remainingArtifacts > 0,
            durability: this.getDurabilityProfile(),
        };
    }

    private async cleanupCancelledTask(
        taskId: string,
        tombstone: FileRead<TaskTombstone>,
        releaseProofs: RecordSchedulerSpoolReleaseProof[],
    ): Promise<{
        removed: ImmutableBlobReference[];
        retained: RecordSchedulerSpoolRetainedBlob[];
        removedTemporaryFiles: number;
        remainingArtifacts: number;
    }> {
        const taskHash = taskIdHash(taskId);
        const proofBuckets = new Map<string, RecordSchedulerSpoolReleaseProof[]>();
        for (const proof of releaseProofs) {
            const key = referenceKey(proof.reference);
            const bucket = proofBuckets.get(key) || [];
            bucket.push(proof);
            proofBuckets.set(key, bucket);
        }
        const acceptedProofs = new Set<string>();
        const removed = new Map<string, ImmutableBlobReference>();
        const retained = new Map<string, RecordSchedulerSpoolRetainedBlob>();
        let removedTemporaryFiles = 0;

        await this.inject({ point: "before-cancel-scan", operation: "cancel", taskId });
        for (let pass = 0; pass < 4; pass += 1) {
            const artifacts = await this.scanTaskArtifacts(taskHash);
            let changed = false;
            for (const temporaryPath of artifacts.temporaryFiles) {
                if (await this.unlinkTaskFileIfPresent(temporaryPath, taskId, undefined)) {
                    removedTemporaryFiles += 1;
                    changed = true;
                }
            }
            for (const blob of artifacts.blobs) {
                const key = referenceKey(blob.reference);
                const proofs = proofBuckets.get(key) || [];
                const exactProof = proofs.find(proof => this.releaseProofMatches(proof, taskId, blob, tombstone.value.cancellationProof));
                if (!exactProof) {
                    retained.set(key, {
                        reference: blob.reference,
                        reason: proofs.length > 0 ? "mismatched_release_proof" : "missing_release_proof",
                    });
                    continue;
                }
                if (!acceptedProofs.has(key)) {
                    const accepted = await this.verifyReleaseAuthority(exactProof);
                    if (!accepted) {
                        retained.set(key, { reference: blob.reference, reason: "release_proof_rejected" });
                        continue;
                    }
                    acceptedProofs.add(key);
                }
                try {
                    await this.verifyBlob(blob.reference);
                } catch (error) {
                    if (error instanceof RecordSchedulerSpoolRepairRequiredError && error.reason === "missing_blob") {
                        retained.delete(key);
                        continue;
                    }
                    throw error;
                }
                if (await this.unlinkTaskFileIfPresent(blob.absolutePath, taskId, blob.reference)) {
                    removed.set(key, blob.reference);
                    changed = true;
                }
                retained.delete(key);
            }
            if (!changed) break;
        }
        const finalArtifacts = await this.scanTaskArtifacts(taskHash);
        for (const blob of finalArtifacts.blobs) {
            const key = referenceKey(blob.reference);
            if (!retained.has(key)) retained.set(key, { reference: blob.reference, reason: "missing_release_proof" });
        }
        await this.inject({ point: "after-cancel-scan", operation: "cancel", taskId });
        return {
            removed: [...removed.values()],
            retained: [...retained.values()],
            removedTemporaryFiles,
            remainingArtifacts: finalArtifacts.temporaryFiles.length,
        };
    }

    private async sealTaskManifest(taskId: string, tombstone: FileRead<TaskTombstone>): Promise<FileRead<SealedTaskManifest>> {
        const state = await this.readTaskState(taskId);
        if (state.phase === "sealed") return state.manifest as FileRead<SealedTaskManifest>;
        const taskHash = taskIdHash(taskId);
        const sealed: SealedTaskManifest = {
            schemaVersion: 2,
            kind: "record-scheduler-spool-task",
            taskId,
            taskHash,
            generation: 2,
            state: "sealed",
            previousManifestHash: state.manifest.reference.hash,
            tombstoneRef: tombstone.reference,
        };
        const bytes = Buffer.from(JSON.stringify(sealed), "utf8");
        const destination = this.privateFile(taskManifestFileName(taskHash));
        const temporaryPath = this.privateFile(taskTemporaryFileName(taskHash));
        let temporaryExists = false;
        let failure: unknown;
        try {
            await this.writeTemporaryFile(temporaryPath, bytes);
            temporaryExists = true;
            await this.inject({ point: "before-task-manifest-seal", operation: "cancel", taskId, reference: tombstone.reference });
            await this.verifyRootIdentity();
            const current = await this.readTaskManifest(taskId);
            const desiredReference = this.referenceForPrivateFile(taskManifestFileName(taskHash), bytes);
            if (sameReference(current.reference, desiredReference)) {
                return current as FileRead<SealedTaskManifest>;
            }
            if (!sameReference(current.reference, state.manifest.reference)) {
                throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_manifest", current.reference);
            }
            await fs.rename(temporaryPath, destination);
            temporaryExists = false;
            await this.inject({ point: "after-task-manifest-rename-before-directory-sync", operation: "cancel", taskId, reference: tombstone.reference });
            await this.syncDirectory(this.privateRoot, "rename");
            await this.verifyRootIdentity();
            await this.inject({ point: "after-task-manifest-seal", operation: "cancel", taskId, reference: tombstone.reference });
            const readBack = await this.readTaskManifest(taskId);
            if (!sameReference(readBack.reference, desiredReference) || readBack.value.state !== "sealed") {
                throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_manifest", readBack.reference);
            }
            return readBack as FileRead<SealedTaskManifest>;
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            if (temporaryExists) await this.cleanupTemporaryFile(temporaryPath, failure);
        }
    }

    private async publishPrivateImmutable(
        destination: string,
        content: Buffer,
        taskHash: string,
        hooks: PublishHooks,
    ): Promise<"published" | "existing"> {
        await this.verifyRootIdentity();
        const temporaryPath = this.privateFile(taskTemporaryFileName(taskHash));
        let temporaryExists = false;
        let failure: unknown;
        try {
            await this.writeTemporaryFile(temporaryPath, content);
            temporaryExists = true;
            if (hooks.afterTemporaryWrite) {
                await this.inject({
                    point: hooks.afterTemporaryWrite,
                    operation: hooks.operation,
                    taskId: hooks.taskId,
                    kind: hooks.kind,
                    reference: hooks.reference,
                });
            }
            await this.inject({ point: hooks.beforeLink, operation: hooks.operation, taskId: hooks.taskId, kind: hooks.kind, reference: hooks.reference });
            await this.verifyRootIdentity();
            await hooks.preLink?.();
            try {
                await fs.link(temporaryPath, destination);
            } catch (error) {
                if (errorCode(error) === "EEXIST") return "existing";
                throw error;
            }
            await this.inject({ point: hooks.afterLinkBeforeSync, operation: hooks.operation, taskId: hooks.taskId, kind: hooks.kind, reference: hooks.reference });
            await this.syncDirectory(this.privateRoot, "link");
            await this.verifyRootIdentity();
            await this.inject({ point: hooks.afterLink, operation: hooks.operation, taskId: hooks.taskId, kind: hooks.kind, reference: hooks.reference });
            return "published";
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            if (temporaryExists) await this.cleanupTemporaryFile(temporaryPath, failure);
        }
    }

    private async publishDataRootImmutable(destination: string, content: Buffer, hooks: PublishHooks): Promise<"published" | "existing"> {
        await this.verifyDataRootIdentity();
        const temporaryPath = path.join(this.dataRoot, `.record-scheduler-spool-root.${randomUUID()}.tmp`);
        let temporaryExists = false;
        let failure: unknown;
        try {
            await this.writeTemporaryDataRootFile(temporaryPath, content);
            temporaryExists = true;
            await this.inject({ point: hooks.beforeLink, operation: hooks.operation });
            await this.verifyDataRootIdentity();
            try {
                await fs.link(temporaryPath, destination);
            } catch (error) {
                if (errorCode(error) === "EEXIST") return "existing";
                throw error;
            }
            await this.inject({ point: hooks.afterLinkBeforeSync, operation: hooks.operation });
            await this.syncDirectory(this.dataRoot, "link");
            await this.verifyDataRootIdentity();
            await this.inject({ point: hooks.afterLink, operation: hooks.operation });
            return "published";
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            if (temporaryExists) await this.cleanupDataRootTemporaryFile(temporaryPath, failure);
        }
    }

    private async writeTemporaryFile(temporaryPath: string, content: Buffer): Promise<void> {
        await this.verifyRootIdentity();
        let created = false;
        try {
            const handle = await fs.open(temporaryPath, "wx");
            created = true;
            try {
                await handle.writeFile(content);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await this.syncDirectory(this.privateRoot, "create-temp");
            await this.verifyRootIdentity();
        } catch (error) {
            if (created) await this.cleanupTemporaryFile(temporaryPath, error);
            throw error;
        }
    }

    private async writeTemporaryDataRootFile(temporaryPath: string, content: Buffer): Promise<void> {
        await this.verifyDataRootIdentity();
        let created = false;
        try {
            const handle = await fs.open(temporaryPath, "wx");
            created = true;
            try {
                await handle.writeFile(content);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await this.syncDirectory(this.dataRoot, "create-temp");
            await this.verifyDataRootIdentity();
        } catch (error) {
            if (created) await this.cleanupDataRootTemporaryFile(temporaryPath, error);
            throw error;
        }
    }

    private async cleanupTemporaryFile(temporaryPath: string, priorFailure: unknown): Promise<void> {
        try {
            if (!await this.pathExists(temporaryPath)) return;
            await fs.unlink(temporaryPath);
            await this.syncDirectory(this.privateRoot, "unlink");
            await this.verifyRootIdentity();
        } catch (error) {
            if (!priorFailure) throw error;
        }
    }

    private async cleanupDataRootTemporaryFile(temporaryPath: string, priorFailure: unknown): Promise<void> {
        try {
            if (!await this.pathExists(temporaryPath)) return;
            await fs.unlink(temporaryPath);
            await this.syncDirectory(this.dataRoot, "unlink");
            await this.verifyDataRootIdentity();
        } catch (error) {
            if (!priorFailure) throw error;
        }
    }

    private async removeOwnedUnreturnedBlob(reference: ImmutableBlobReference): Promise<void> {
        const absolutePath = this.absoluteReferencePath(reference);
        if (!await this.pathExists(absolutePath)) return;
        await this.verifyBlob(reference);
        await fs.unlink(absolutePath);
        await this.syncDirectory(this.privateRoot, "unlink");
        await this.verifyRootIdentity();
    }

    private async unlinkTaskFileIfPresent(filePath: string, taskId: string, reference?: ImmutableBlobReference): Promise<boolean> {
        await this.verifyRootIdentity();
        const metadata = await this.optionalLstat(filePath);
        if (!metadata) return false;
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path", reference);
        await this.inject({ point: "before-cancel-unlink", operation: "cancel", taskId, reference });
        try {
            await fs.unlink(filePath);
        } catch (error) {
            if (errorCode(error) === "ENOENT") return false;
            throw error;
        }
        await this.syncDirectory(this.privateRoot, "unlink");
        await this.verifyRootIdentity();
        await this.inject({ point: "after-cancel-unlink", operation: "cancel", taskId, reference });
        return true;
    }

    private async verifyBlob(reference: ImmutableBlobReference): Promise<Buffer> {
        await this.verifyRootIdentity();
        const absolutePath = this.absoluteReferencePath(reference);
        const before = await this.requiredRegularFile(absolutePath, "missing_blob", reference);
        let content: Buffer;
        try {
            content = await fs.readFile(absolutePath);
        } catch (error) {
            if (errorCode(error) === "ENOENT") throw new RecordSchedulerSpoolRepairRequiredError("missing_blob", reference);
            throw error;
        }
        const after = await this.requiredRegularFile(absolutePath, "missing_blob", reference);
        await this.verifyRootIdentity();
        if (!sameFile(before, after) || content.byteLength !== reference.byteLength || hashBuffer(content) !== reference.hash) {
            throw new RecordSchedulerSpoolRepairRequiredError("corrupt_blob", reference);
        }
        return content;
    }

    private async scanTaskArtifacts(taskHash: string): Promise<{ blobs: FlatBlobEntry[]; temporaryFiles: string[] }> {
        await this.verifyRootIdentity();
        const entries = await fs.readdir(this.privateRoot, { withFileTypes: true });
        const blobs: FlatBlobEntry[] = [];
        const temporaryFiles: string[] = [];
        for (const entry of entries) {
            if (entry.name.startsWith(`b.${taskHash}.`)) {
                if (!entry.isFile() || entry.isSymbolicLink()) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path");
                const parsed = parseBlobFileName(entry.name, taskHash);
                if (!parsed) throw new RecordSchedulerSpoolRepairRequiredError("unexpected_task_artifact");
                blobs.push({ fileName: entry.name, absolutePath: this.privateFile(entry.name), ...parsed });
            } else if (entry.name.startsWith(`x.${taskHash}.`)) {
                if (!entry.isFile() || entry.isSymbolicLink()) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path");
                temporaryFiles.push(this.privateFile(entry.name));
            }
        }
        await this.verifyRootIdentity();
        return { blobs, temporaryFiles };
    }

    private async readTaskState(taskId: string): Promise<TaskStateRead> {
        const manifest = await this.readTaskManifest(taskId);
        const tombstone = await this.readTaskTombstoneIfPresent(taskId);
        if (manifest.value.state === "sealed") {
            if (!tombstone) throw new RecordSchedulerSpoolRepairRequiredError("missing_task_tombstone", manifest.value.tombstoneRef);
            if (!sameReference(manifest.value.tombstoneRef, tombstone.reference)) {
                throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_tombstone", tombstone.reference);
            }
            return { manifest, tombstone, phase: "sealed" };
        }
        return { manifest, tombstone, phase: tombstone ? "sealing" : "open" };
    }

    private async assertTaskOpen(taskId: string): Promise<void> {
        const state = await this.readTaskState(taskId);
        if (state.phase !== "open") throw new RecordSchedulerSpoolTaskSealedError(taskId);
    }

    private async readRootManifest(): Promise<FileRead<RootManifest>> {
        const file = await this.readStableJsonFile(this.rootManifestPath, "missing_root_manifest", "corrupt_root_manifest");
        if (!isRootManifest(file.value)) throw new RecordSchedulerSpoolRepairRequiredError("corrupt_root_manifest", file.reference);
        return file as FileRead<RootManifest>;
    }

    private async readTaskManifest(taskId: string): Promise<FileRead<TaskManifest>> {
        const taskHash = taskIdHash(taskId);
        const filePath = this.privateFile(taskManifestFileName(taskHash));
        const file = await this.readStableJsonFile(filePath, "missing_task_manifest", "corrupt_task_manifest");
        if (!isTaskManifest(file.value, taskId, taskHash)) {
            throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_manifest", file.reference);
        }
        return file as FileRead<TaskManifest>;
    }

    private async readTaskManifestIfPresent(taskId: string): Promise<FileRead<TaskManifest> | undefined> {
        const taskHash = taskIdHash(taskId);
        const filePath = this.privateFile(taskManifestFileName(taskHash));
        if (!await this.pathExists(filePath)) return undefined;
        return this.readTaskManifest(taskId);
    }

    private async readTaskTombstone(taskId: string): Promise<FileRead<TaskTombstone>> {
        const tombstone = await this.readTaskTombstoneIfPresent(taskId);
        if (!tombstone) throw new RecordSchedulerSpoolRepairRequiredError("missing_task_tombstone");
        return tombstone;
    }

    private async readTaskTombstoneIfPresent(taskId: string): Promise<FileRead<TaskTombstone> | undefined> {
        const taskHash = taskIdHash(taskId);
        const filePath = this.privateFile(taskTombstoneFileName(taskHash));
        if (!await this.pathExists(filePath)) return undefined;
        const file = await this.readStableJsonFile(filePath, "missing_task_tombstone", "corrupt_task_tombstone");
        if (!isTaskTombstone(file.value, taskId, taskHash)) {
            throw new RecordSchedulerSpoolRepairRequiredError("corrupt_task_tombstone", file.reference);
        }
        return file as FileRead<TaskTombstone>;
    }

    private async readStableJsonFile(
        filePath: string,
        missingReason: RecordSchedulerSpoolRepairReason,
        corruptReason: RecordSchedulerSpoolRepairReason,
    ): Promise<FileRead<unknown>> {
        await this.verifyContainingRoot(filePath);
        const before = await this.requiredRegularFile(filePath, missingReason);
        let bytes: Buffer;
        let value: unknown;
        try {
            bytes = await fs.readFile(filePath);
            value = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
            if (errorCode(error) === "ENOENT") throw new RecordSchedulerSpoolRepairRequiredError(missingReason);
            throw new RecordSchedulerSpoolRepairRequiredError(corruptReason);
        }
        const after = await this.requiredRegularFile(filePath, missingReason);
        await this.verifyContainingRoot(filePath);
        if (!sameFile(before, after)) throw new RecordSchedulerSpoolRepairRequiredError(corruptReason);
        return {
            value,
            bytes,
            reference: filePath === this.rootManifestPath
                ? this.referenceForDataRootFile(path.basename(filePath), bytes)
                : this.referenceForPrivateFile(path.basename(filePath), bytes),
        };
    }

    private createBlobReference(taskId: string, kind: RecordSchedulerSpoolKind, content: Buffer): ImmutableBlobReference {
        const taskHash = taskIdHash(taskId);
        const hash = hashBuffer(content);
        const fileName = blobFileName(taskHash, kind, hash, content.byteLength);
        return this.referenceForPrivateFile(fileName, content);
    }

    private validateBlobReference(taskId: string, kind: RecordSchedulerSpoolKind, reference: ImmutableBlobReference): void {
        if (!isImmutableReference(reference) || !SHA256_PATTERN.test(reference.hash)) {
            throw new RecordSchedulerSpoolRepairRequiredError("invalid_reference", reference);
        }
        const fileName = blobFileName(taskIdHash(taskId), kind, reference.hash, reference.byteLength);
        if (reference.path !== privateRelativePath(fileName)) {
            throw new RecordSchedulerSpoolRepairRequiredError("invalid_reference", reference);
        }
    }

    private releaseProofMatches(
        proof: RecordSchedulerSpoolReleaseProof,
        taskId: string,
        blob: FlatBlobEntry,
        cancellationProof: RecordSchedulerTaskCancellationProof,
    ): boolean {
        return isReleaseProof(proof)
            && proof.taskId === taskId
            && proof.kind === blob.kind
            && sameReference(proof.reference, blob.reference)
            && proof.ledgerRevision === cancellationProof.ledgerRevision
            && proof.ledgerHash === cancellationProof.ledgerHash
            && proof.cancellationEvidenceId === cancellationProof.cancellationEvidenceId
            && proof.releaseEvidenceId === calculateRecordSchedulerSpoolReleaseEvidenceId({
                dataRoot: this.dataRoot,
                taskId: proof.taskId,
                kind: proof.kind,
                reference: proof.reference,
                ledgerRevision: proof.ledgerRevision,
                ledgerHash: proof.ledgerHash,
                cancellationEvidenceId: proof.cancellationEvidenceId,
                verifiedAt: proof.verifiedAt,
            });
    }

    private async verifyCancellationAuthority(proof: RecordSchedulerTaskCancellationProof): Promise<void> {
        if (!this.proofVerifier) throw new RecordSchedulerSpoolDiscardDeniedError("Cancellation requires an authoritative asynchronous proof verifier");
        let accepted = false;
        try {
            accepted = await this.proofVerifier.verifyTaskCancellation(deepFreeze(structuredClone(proof)));
        } catch {
            throw new RecordSchedulerSpoolDiscardDeniedError("Authoritative task cancellation proof verification failed");
        }
        if (!accepted) throw new RecordSchedulerSpoolDiscardDeniedError("Authoritative task cancellation proof was rejected");
    }

    private async verifyReleaseAuthority(proof: RecordSchedulerSpoolReleaseProof): Promise<boolean> {
        if (!this.proofVerifier) return false;
        try {
            return await this.proofVerifier.verifyBlobRelease(deepFreeze(structuredClone(proof)));
        } catch {
            return false;
        }
    }

    private assertCancellationProofShape(proof: RecordSchedulerTaskCancellationProof, taskId: string): void {
        if (!isCancellationProof(proof)
            || proof.taskId !== taskId
            || proof.cancellationEvidenceId !== calculateRecordSchedulerSpoolCancellationEvidenceId({
                dataRoot: this.dataRoot,
                taskId: proof.taskId,
                ledgerRevision: proof.ledgerRevision,
                ledgerHash: proof.ledgerHash,
            })) {
            throw new RecordSchedulerSpoolDiscardDeniedError("Task cancellation proof does not match the requested task");
        }
    }

    private async requireRoot(): Promise<void> {
        if (!this.dataRootIdentity || !this.privateRootIdentity) {
            throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
        }
        await this.verifyRootIdentity();
    }

    private async verifyContainingRoot(filePath: string): Promise<void> {
        if (filePath === this.rootManifestPath) await this.verifyDataRootIdentity();
        else await this.verifyRootIdentity();
    }

    private async verifyDataRootIdentity(): Promise<void> {
        if (!this.dataRootIdentity) throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
        const current = await this.readDirectoryIdentity(this.dataRoot, "missing_private_root");
        if (!sameIdentity(this.dataRootIdentity, current)) throw new RecordSchedulerSpoolRepairRequiredError("private_root_replaced");
    }

    private async verifyRootIdentity(): Promise<void> {
        if (!this.privateRootIdentity || !this.dataRootIdentity) throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
        await this.verifyDataRootIdentity();
        if (!await this.pathExists(this.rootManifestPath)) throw new RecordSchedulerSpoolRepairRequiredError("missing_root_manifest");
        const rootManifest = await this.readRootManifest();
        const expectedRootManifest = Buffer.from(JSON.stringify(rootManifestValue()), "utf8");
        if (!sameReference(rootManifest.reference, this.referenceForDataRootFile(ROOT_MANIFEST_FILE_NAME, expectedRootManifest))) {
            throw new RecordSchedulerSpoolRepairRequiredError("corrupt_root_manifest", rootManifest.reference);
        }
        const current = await this.readDirectoryIdentity(this.privateRoot, "missing_private_root");
        if (!sameIdentity(this.privateRootIdentity, current)) throw new RecordSchedulerSpoolRepairRequiredError("private_root_replaced");
        this.assertNestedRealPath(this.dataRootIdentity.realPath, current.realPath);
    }

    private async readDirectoryIdentity(directoryPath: string, missingReason: RecordSchedulerSpoolRepairReason): Promise<RootIdentity> {
        let metadata;
        try {
            metadata = await fs.lstat(directoryPath);
        } catch (error) {
            if (errorCode(error) === "ENOENT") throw new RecordSchedulerSpoolRepairRequiredError(missingReason);
            throw error;
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path");
        const realPath = await fs.realpath(directoryPath);
        return { dev: metadata.dev, ino: metadata.ino, realPath: normalizePath(realPath) };
    }

    private assertNestedRealPath(parentPath: string, childPath: string): void {
        const relative = path.relative(parentPath, childPath);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path");
        }
    }

    private async syncDirectory(
        directoryPath: string,
        mutation: "mkdir" | "link" | "rename" | "unlink" | "create-temp",
    ): Promise<void> {
        try {
            if (this.directoryDurability) {
                await this.directoryDurability.sync(directoryPath, mutation);
                return;
            }
            if (process.platform === "win32") return;
            const handle = await fs.open(directoryPath, fsConstants.O_RDONLY);
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            throw new RecordSchedulerSpoolDurabilityError(mutation, directoryPath, errorCode(error));
        }
    }

    private async requiredRegularFile(
        filePath: string,
        missingReason: RecordSchedulerSpoolRepairReason,
        reference?: ImmutableBlobReference,
    ) {
        const metadata = await this.optionalLstat(filePath);
        if (!metadata) throw new RecordSchedulerSpoolRepairRequiredError(missingReason, reference);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path", reference);
        return metadata;
    }

    private async optionalLstat(filePath: string) {
        try {
            return await fs.lstat(filePath);
        } catch (error) {
            if (errorCode(error) === "ENOENT") return undefined;
            throw error;
        }
    }

    private async pathExists(filePath: string): Promise<boolean> {
        return Boolean(await this.optionalLstat(filePath));
    }

    private async hasTaskArtifacts(taskHash: string): Promise<boolean> {
        const entries = await fs.readdir(this.privateRoot);
        return entries.some(entry => entry === taskTombstoneFileName(taskHash)
            || entry.startsWith(`b.${taskHash}.`)
            || entry.startsWith(`x.${taskHash}.`));
    }

    private absoluteReferencePath(reference: ImmutableBlobReference): string {
        if (!isImmutableReference(reference) || !reference.path.startsWith(`${PRIVATE_ROOT_NAME}/`) || reference.path.includes("\\")) {
            throw new RecordSchedulerSpoolRepairRequiredError("invalid_reference", reference);
        }
        const fileName = reference.path.slice(PRIVATE_ROOT_NAME.length + 1);
        if (!isSafeFlatFileName(fileName)) throw new RecordSchedulerSpoolRepairRequiredError("invalid_reference", reference);
        return this.privateFile(fileName);
    }

    private privateFile(fileName: string): string {
        if (!isSafeFlatFileName(fileName)) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path");
        const resolved = path.join(this.privateRoot, fileName);
        if (path.dirname(resolved) !== this.privateRoot) throw new RecordSchedulerSpoolRepairRequiredError("unsafe_spool_path");
        return resolved;
    }

    private referenceForPrivateFile(fileName: string, content: Uint8Array): ImmutableBlobReference {
        return { path: privateRelativePath(fileName), hash: hashBuffer(content), byteLength: content.byteLength };
    }

    private referenceForDataRootFile(fileName: string, content: Uint8Array): ImmutableBlobReference {
        return { path: fileName, hash: hashBuffer(content), byteLength: content.byteLength };
    }

    private assertTaskId(taskId: string): void {
        if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 512) {
            throw new RecordSchedulerSpoolRepairRequiredError("invalid_reference");
        }
    }

    private assertKind(kind: RecordSchedulerSpoolKind): void {
        if (kind !== "source" && kind !== "output") throw new RecordSchedulerSpoolRepairRequiredError("invalid_reference");
    }

    private async inject(event: RecordSchedulerSpoolFaultEvent): Promise<void> {
        await this.faultInjector?.(deepFreeze({ ...event }));
    }
}

export function createRecordSchedulerSpool(options: RecordSchedulerSpoolOptions): RecordSchedulerSpool {
    return new RecordSchedulerSpool(options);
}

function rootManifestValue(): RootManifest {
    return { schemaVersion: 2, kind: "record-scheduler-spool-root", privateRootName: PRIVATE_ROOT_NAME };
}

function taskIdHash(taskId: string): string {
    return hashBuffer(Buffer.from(taskId, "utf8"));
}

function taskManifestFileName(taskHash: string): string {
    return `m.${taskHash}.json`;
}

function taskTombstoneFileName(taskHash: string): string {
    return `t.${taskHash}.json`;
}

function taskTemporaryFileName(taskHash: string): string {
    return `x.${taskHash}.${randomUUID()}.tmp`;
}

function blobFileName(taskHash: string, kind: RecordSchedulerSpoolKind, hash: string, byteLength: number): string {
    return `b.${taskHash}.${kind === "source" ? "s" : "o"}.${hash}.${byteLength}.blob`;
}

function privateRelativePath(fileName: string): string {
    return path.posix.join(PRIVATE_ROOT_NAME, fileName);
}

function parseBlobFileName(fileName: string, expectedTaskHash: string): Pick<FlatBlobEntry, "kind" | "reference"> | undefined {
    const match = BLOB_FILE_PATTERN.exec(fileName);
    if (!match || match[1] !== expectedTaskHash) return undefined;
    const byteLength = Number(match[4]);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;
    return {
        kind: match[2] === "s" ? "source" : "output",
        reference: { path: privateRelativePath(fileName), hash: match[3], byteLength },
    };
}

function cloneCancellationProof(proof: RecordSchedulerTaskCancellationProof): RecordSchedulerTaskCancellationProof {
    return structuredClone(proof);
}

function cloneReleaseProof(proof: RecordSchedulerSpoolReleaseProof): RecordSchedulerSpoolReleaseProof {
    return structuredClone(proof);
}

function isRootManifest(value: unknown): value is RootManifest {
    return isPlainObject(value)
        && value.schemaVersion === 2
        && value.kind === "record-scheduler-spool-root"
        && value.privateRootName === PRIVATE_ROOT_NAME;
}

function isTaskManifest(value: unknown, taskId: string, taskHash: string): value is TaskManifest {
    if (!isPlainObject(value)
        || value.schemaVersion !== 2
        || value.kind !== "record-scheduler-spool-task"
        || value.taskId !== taskId
        || value.taskHash !== taskHash) return false;
    if (value.state === "open") return value.generation === 1;
    return value.state === "sealed"
        && value.generation === 2
        && typeof value.previousManifestHash === "string"
        && SHA256_PATTERN.test(value.previousManifestHash)
        && isImmutableReference(value.tombstoneRef);
}

function isTaskTombstone(value: unknown, taskId: string, taskHash: string): value is TaskTombstone {
    return isPlainObject(value)
        && value.schemaVersion === 2
        && value.kind === "record-scheduler-spool-task-tombstone"
        && value.taskId === taskId
        && value.taskHash === taskHash
        && isCancellationProof(value.cancellationProof)
        && value.cancellationProof.taskId === taskId;
}

function isCancellationProof(value: unknown): value is RecordSchedulerTaskCancellationProof {
    return isPlainObject(value)
        && isNonEmptyString(value.taskId)
        && Number.isSafeInteger(value.ledgerRevision)
        && Number(value.ledgerRevision) > 0
        && typeof value.ledgerHash === "string"
        && SHA256_PATTERN.test(value.ledgerHash)
        && typeof value.cancellationEvidenceId === "string"
        && SHA256_PATTERN.test(value.cancellationEvidenceId)
        && isTimestamp(value.verifiedAt);
}

function isReleaseProof(value: unknown): value is RecordSchedulerSpoolReleaseProof {
    return isPlainObject(value)
        && isNonEmptyString(value.taskId)
        && (value.kind === "source" || value.kind === "output")
        && isImmutableReference(value.reference)
        && Number.isSafeInteger(value.ledgerRevision)
        && Number(value.ledgerRevision) > 0
        && typeof value.ledgerHash === "string"
        && SHA256_PATTERN.test(value.ledgerHash)
        && typeof value.cancellationEvidenceId === "string"
        && SHA256_PATTERN.test(value.cancellationEvidenceId)
        && typeof value.releaseEvidenceId === "string"
        && SHA256_PATTERN.test(value.releaseEvidenceId)
        && isTimestamp(value.verifiedAt);
}

function sameCancellationProof(left: RecordSchedulerTaskCancellationProof, right: RecordSchedulerTaskCancellationProof): boolean {
    return left.taskId === right.taskId
        && left.ledgerRevision === right.ledgerRevision
        && left.ledgerHash === right.ledgerHash
        && left.cancellationEvidenceId === right.cancellationEvidenceId
        && left.verifiedAt === right.verifiedAt;
}

function toBuffer(content: string | Uint8Array): Buffer {
    return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function hashBuffer(content: Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
}

function rootNamespace(dataRoot: string): string {
    return path.resolve(dataRoot).replace(/\\/gu, "/").toLowerCase();
}

function stableJson(value: unknown): string {
    return JSON.stringify(value, (_, nested) => {
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
        return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    });
}

function isAbsolutePath(candidate: string): boolean {
    return typeof candidate === "string" && (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate));
}

function isImmutableReference(value: unknown): value is ImmutableBlobReference {
    return isPlainObject(value)
        && typeof value.path === "string"
        && typeof value.hash === "string"
        && SHA256_PATTERN.test(value.hash)
        && Number.isSafeInteger(value.byteLength)
        && Number(value.byteLength) >= 0;
}

function sameReference(left: ImmutableBlobReference, right: ImmutableBlobReference): boolean {
    return left.path === right.path && left.hash === right.hash && left.byteLength === right.byteLength;
}

function referenceKey(reference: ImmutableBlobReference): string {
    return `${reference.path}\u0000${reference.hash}\u0000${reference.byteLength}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSafeFlatFileName(fileName: string): boolean {
    return fileName.length > 0
        && fileName !== "."
        && fileName !== ".."
        && !fileName.includes("/")
        && !fileName.includes("\\")
        && !path.isAbsolute(fileName);
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
}

function sameFile(left: { dev: number; ino: number; size: number; mtimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number }): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameIdentity(left: RootIdentity, right: RootIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.realPath === right.realPath;
}

function normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    return Object.freeze(value);
}

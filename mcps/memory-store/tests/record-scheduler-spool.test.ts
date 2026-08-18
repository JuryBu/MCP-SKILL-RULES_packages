import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
    RecordSchedulerSpoolOptions,
    RecordSchedulerSpoolReleaseProof,
    RecordSchedulerTaskCancellationProof,
} from "../src/record-scheduler-spool.ts";

const spool = await import("../src/record-scheduler-spool.ts");

const PRIVATE_ROOT_NAME = ".record-scheduler-spool-v2";
const LEDGER_REVISION = 17;
const VERIFIED_AT = "2026-07-13T12:00:00.000Z";

interface VerificationCalls {
    cancellations: string[];
    releases: string[];
}

interface BlobReference {
    path: string;
    hash: string;
    byteLength: number;
}

async function withTempRoot(run: (dataRoot: string) => Promise<void>): Promise<void> {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "record-scheduler-spool-"));
    try {
        await run(dataRoot);
    } finally {
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
}

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function ledgerHash(taskId: string): string {
    return sha256(`ledger:${taskId}`);
}

function cancellationProof(dataRoot: string, taskId: string) {
    const proof = {
        taskId,
        ledgerRevision: LEDGER_REVISION,
        ledgerHash: ledgerHash(taskId),
        verifiedAt: VERIFIED_AT,
    };
    return {
        ...proof,
        cancellationEvidenceId: spool.calculateRecordSchedulerSpoolCancellationEvidenceId({ dataRoot, ...proof }),
    };
}

function releaseProof(
    dataRoot: string,
    taskId: string,
    kind: "source" | "output",
    reference: { path: string; hash: string; byteLength: number },
) {
    const cancellation = cancellationProof(dataRoot, taskId);
    const proof = {
        taskId,
        kind,
        reference: { ...reference },
        ...cancellation,
    };
    return {
        ...proof,
        releaseEvidenceId: spool.calculateRecordSchedulerSpoolReleaseEvidenceId({ dataRoot, ...proof }),
    };
}

function authoritativeVerifier(dataRoot: string, calls?: VerificationCalls) {
    return {
        async verifyTaskCancellation(proof: RecordSchedulerTaskCancellationProof) {
            assert.equal(Object.isFrozen(proof), true);
            calls?.cancellations.push(proof.cancellationEvidenceId);
            return proof.ledgerRevision === LEDGER_REVISION
                && proof.ledgerHash === ledgerHash(proof.taskId)
                && proof.cancellationEvidenceId === spool.calculateRecordSchedulerSpoolCancellationEvidenceId({
                    dataRoot,
                    taskId: proof.taskId,
                    ledgerRevision: proof.ledgerRevision,
                    ledgerHash: proof.ledgerHash,
                });
        },
        async verifyBlobRelease(proof: RecordSchedulerSpoolReleaseProof) {
            assert.equal(Object.isFrozen(proof), true);
            assert.equal(Object.isFrozen(proof.reference), true);
            calls?.releases.push(proof.releaseEvidenceId);
            return proof.ledgerRevision === LEDGER_REVISION
                && proof.ledgerHash === ledgerHash(proof.taskId)
                && proof.cancellationEvidenceId === spool.calculateRecordSchedulerSpoolCancellationEvidenceId({
                    dataRoot,
                    taskId: proof.taskId,
                    ledgerRevision: proof.ledgerRevision,
                    ledgerHash: proof.ledgerHash,
                })
                && proof.releaseEvidenceId === spool.calculateRecordSchedulerSpoolReleaseEvidenceId({
                    dataRoot,
                    taskId: proof.taskId,
                    kind: proof.kind,
                    reference: proof.reference,
                    ledgerRevision: proof.ledgerRevision,
                    ledgerHash: proof.ledgerHash,
                    cancellationEvidenceId: proof.cancellationEvidenceId,
                    verifiedAt: proof.verifiedAt,
                });
        },
    };
}

function simulatedDirectoryDurability(syncs?: string[]) {
    return {
        async sync(directoryPath: string, mutation: "mkdir" | "link" | "rename" | "unlink" | "create-temp") {
            syncs?.push(`${mutation}:${path.basename(directoryPath)}`);
        },
    };
}

async function createInitializedStore(
    dataRoot: string,
    taskId: string,
    options: Partial<RecordSchedulerSpoolOptions> = {},
) {
    const store = spool.createRecordSchedulerSpool({
        dataRoot,
        proofVerifier: authoritativeVerifier(dataRoot),
        directoryDurability: simulatedDirectoryDurability(),
        ...options,
    });
    await store.initializeRoot({ mode: "create" });
    await store.initializeTask({ taskId, mode: "create" });
    return store;
}

function expectedReference(taskId: string, kind: "source" | "output", content: string) {
    const bytes = Buffer.from(content, "utf8");
    const taskHash = sha256(taskId);
    const contentHash = sha256(bytes);
    const fileName = `b.${taskHash}.${kind === "source" ? "s" : "o"}.${contentHash}.${bytes.byteLength}.blob`;
    return { path: `${PRIVATE_ROOT_NAME}/${fileName}`, hash: contentHash, byteLength: bytes.byteLength };
}

async function runTest(name: string, run: () => Promise<void>): Promise<void> {
    await run();
    console.log(`ok - ${name}`);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function runHardExitChild(environment: Record<string, string>, expectedCode: number): Promise<void> {
    const moduleUrl = pathToFileURL(path.resolve("src/record-scheduler-spool.ts")).href;
    const childSource = `
const spool = await import(process.env.SPOOL_MODULE_URL);
const input = JSON.parse(process.env.SPOOL_CHILD_INPUT);
const store = spool.createRecordSchedulerSpool({
  dataRoot: process.env.SPOOL_DATA_ROOT,
  directoryDurability: { sync: async () => {} },
  proofVerifier: {
    verifyTaskCancellation: async () => true,
    verifyBlobRelease: async () => true,
  },
  faultInjector(event) {
    if (event.point === process.env.SPOOL_FAULT_POINT) process.exit(Number(process.env.SPOOL_EXIT_CODE));
  },
});
await store.initializeRoot({ mode: "open" });
await store.initializeTask({ taskId: input.taskId, mode: "open" });
if (input.operation === "write") {
  await store.writeImmutable({ taskId: input.taskId, kind: input.kind, content: input.content });
} else {
  await store.cancelTask({ taskId: input.taskId, cancellationProof: input.cancellationProof, releaseProofs: input.releaseProofs });
}
`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            ...environment,
            SPOOL_MODULE_URL: moduleUrl,
            SPOOL_EXIT_CODE: String(expectedCode),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    assert.equal(code, expectedCode, stderr);
}

await runTest("flat content addressing and immutable readback", async () => {
    await withTempRoot(async dataRoot => {
        const syncs: string[] = [];
        const taskId = "task-flat-a";
        const store = await createInitializedStore(dataRoot, taskId, {
            directoryDurability: simulatedDirectoryDurability(syncs),
        });
        await store.initializeTask({ taskId: "task-flat-b", mode: "create" });
        const first = await store.writeImmutable({ taskId, kind: "source", content: "frozen source round" });
        const second = await store.writeImmutable({ taskId, kind: "source", content: "frozen source round" });
        const otherTask = await store.writeImmutable({ taskId: "task-flat-b", kind: "source", content: "frozen source round" });

        assert.equal(first.disposition, "published");
        assert.equal(second.disposition, "existing");
        assert.deepEqual(second.reference, first.reference);
        assert.equal(otherTask.reference.hash, first.reference.hash);
        assert.notEqual(otherTask.reference.path, first.reference.path);
        assert.match(first.reference.path, /^\.record-scheduler-spool-v2\/b\.[a-f0-9]{64}\.[so]\.[a-f0-9]{64}\.[0-9]+\.blob$/);
        assert.equal(first.reference.path.split("/").length, 2);
        assert.equal((await store.readImmutable({ taskId, kind: "source", reference: first.reference })).toString("utf8"), "frozen source round");
        await assert.rejects(
            () => store.readImmutable({ taskId: "task-flat-b", kind: "source", reference: first.reference }),
            (error: unknown) => error instanceof spool.RecordSchedulerSpoolRepairRequiredError && error.reason === "invalid_reference",
        );
        const privateEntries = await fs.readdir(path.join(dataRoot, PRIVATE_ROOT_NAME), { withFileTypes: true });
        assert.equal(privateEntries.every(entry => entry.isFile()), true);
        assert.equal(syncs.some(entry => entry.startsWith("mkdir:")), true);
        assert.equal(syncs.some(entry => entry.startsWith("link:")), true);
        assert.equal(syncs.some(entry => entry.startsWith("unlink:")), true);
    });
});

await runTest("content corruption is RepairRequired", async () => {
    await withTempRoot(async dataRoot => {
        const taskId = "task-corrupt";
        const store = await createInitializedStore(dataRoot, taskId);
        const written = await store.writeImmutable({ taskId, kind: "output", content: "model result" });
        const blobPath = path.join(dataRoot, ...written.reference.path.split("/"));
        await fs.writeFile(blobPath, "forged result", "utf8");
        await assert.rejects(
            () => store.readImmutable({ taskId, kind: "output", reference: written.reference }),
            (error: unknown) => error instanceof spool.RecordSchedulerSpoolRepairRequiredError && error.reason === "corrupt_blob",
        );
    });
});

await runTest("Windows uses process-crash durability without directory fsync", async () => {
    await withTempRoot(async dataRoot => {
        const store = spool.createRecordSchedulerSpool({ dataRoot });
        const initialized = await store.initializeRoot({ mode: "create" });
        if (process.platform === "win32") {
            assert.deepEqual(initialized.durability, {
                processCrashAndHotRestart: "supported",
                directoryEntrySync: "windows_unavailable",
                suddenPowerLossDirectoryEntriesGuaranteed: false,
            });
        } else {
            assert.equal(initialized.durability.directoryEntrySync, "posix_fsync");
            assert.equal(initialized.durability.suddenPowerLossDirectoryEntriesGuaranteed, true);
        }
        await fs.access(path.join(dataRoot, ".record-scheduler-spool-v2.root.json"));
    });

    await withTempRoot(async dataRoot => {
        const adapterError = Object.assign(new Error("directory sync failed"), { code: "EIO" });
        const store = spool.createRecordSchedulerSpool({
            dataRoot,
            directoryDurability: { sync: async () => { throw adapterError; } },
        });
        await assert.rejects(
            () => store.initializeRoot({ mode: "create" }),
            (error: unknown) => error instanceof spool.RecordSchedulerSpoolDurabilityError
                && error.durability === "unconfirmed"
                && error.mutation === "mkdir"
                && error.causeCode === "EIO",
        );
    });
});

await runTest("empty task cancellation seals every future hash and is idempotent", async () => {
    await withTempRoot(async dataRoot => {
        const taskId = "task-empty-cancel";
        const store = await createInitializedStore(dataRoot, taskId);
        const first = await store.cancelTask({ taskId, cancellationProof: cancellationProof(dataRoot, taskId), releaseProofs: [] });
        const repeated = await store.cancelTask({ taskId, cancellationProof: cancellationProof(dataRoot, taskId), releaseProofs: [] });
        assert.equal(first.disposition, "sealed");
        assert.equal(first.cleanupComplete, true);
        assert.equal(first.spoolVisible, false);
        assert.equal(repeated.disposition, "already_sealed");
        await assert.rejects(
            () => store.writeImmutable({ taskId, kind: "source", content: "late source hash" }),
            error => error instanceof spool.RecordSchedulerSpoolTaskSealedError,
        );
        await assert.rejects(
            () => store.writeImmutable({ taskId, kind: "output", content: "different late output hash" }),
            error => error instanceof spool.RecordSchedulerSpoolTaskSealedError,
        );
        const entries = await fs.readdir(path.join(dataRoot, PRIVATE_ROOT_NAME));
        assert.equal(entries.some(entry => entry.startsWith(`b.${sha256(taskId)}.`)), false);
    });
});

await runTest("task cancellation clears all exact-proof blobs", async () => {
    await withTempRoot(async dataRoot => {
        const syncs: string[] = [];
        const taskId = "task-clear-all";
        const calls: VerificationCalls = { cancellations: [], releases: [] };
        const store = await createInitializedStore(dataRoot, taskId, {
            proofVerifier: authoritativeVerifier(dataRoot, calls),
            directoryDurability: simulatedDirectoryDurability(syncs),
        });
        const source = await store.writeImmutable({ taskId, kind: "source", content: "source payload" });
        const output = await store.writeImmutable({ taskId, kind: "output", content: "output payload" });
        const cancelled = await store.cancelTask({
            taskId,
            cancellationProof: cancellationProof(dataRoot, taskId),
            releaseProofs: [
                releaseProof(dataRoot, taskId, "source", source.reference),
                releaseProof(dataRoot, taskId, "output", output.reference),
            ],
        });
        assert.equal(cancelled.removed.length, 2);
        assert.equal(cancelled.retained.length, 0);
        assert.equal(cancelled.cleanupComplete, true);
        assert.equal(cancelled.spoolVisible, false);
        assert.deepEqual(calls.cancellations, [cancellationProof(dataRoot, taskId).cancellationEvidenceId]);
        assert.equal(calls.releases.length, 2);
        assert.equal(syncs.some(entry => entry.startsWith("rename:")), true);
    });
});

await runTest("proof verifier blocks cross-object reuse and missing verifier blocks cancellation", async () => {
    await withTempRoot(async dataRoot => {
        const taskId = "task-cross-proof";
        const store = await createInitializedStore(dataRoot, taskId);
        const first = await store.writeImmutable({ taskId, kind: "source", content: "object-a" });
        const second = await store.writeImmutable({ taskId, kind: "output", content: "object-b" });
        const crossObject = {
            ...releaseProof(dataRoot, taskId, "source", first.reference),
            kind: "output" as const,
            reference: { ...second.reference },
        };
        const partial = await store.cancelTask({
            taskId,
            cancellationProof: cancellationProof(dataRoot, taskId),
            releaseProofs: [releaseProof(dataRoot, taskId, "source", first.reference), crossObject],
        });
        assert.equal(partial.removed.length, 1);
        assert.equal(partial.retained.length, 1);
        assert.equal(partial.retained[0].reason, "mismatched_release_proof");
        assert.deepEqual(partial.retained[0].reference, second.reference);
        const completed = await store.cancelTask({
            taskId,
            cancellationProof: cancellationProof(dataRoot, taskId),
            releaseProofs: [releaseProof(dataRoot, taskId, "output", second.reference)],
        });
        assert.equal(completed.cleanupComplete, true);
    });

    await withTempRoot(async dataRoot => {
        const taskId = "task-no-verifier";
        const store = spool.createRecordSchedulerSpool({
            dataRoot,
            directoryDurability: simulatedDirectoryDurability(),
        });
        await store.initializeRoot({ mode: "create" });
        await store.initializeTask({ taskId, mode: "create" });
        const written = await store.writeImmutable({ taskId, kind: "output", content: "must remain" });
        await assert.rejects(
            () => store.cancelTask({
                taskId,
                cancellationProof: cancellationProof(dataRoot, taskId),
                releaseProofs: [releaseProof(dataRoot, taskId, "output", written.reference)],
            }),
            error => error instanceof spool.RecordSchedulerSpoolDiscardDeniedError,
        );
        assert.equal((await store.readImmutable({ taskId, kind: "output", reference: written.reference })).toString("utf8"), "must remain");
    });
});

await runTest("root-bound cancellation and release evidence cannot cross-delete same task/blob", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "record-scheduler-spool-root-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "record-scheduler-spool-root-b-"));
    try {
        const taskId = "task-cross-root-proof";
        const storeA = await createInitializedStore(rootA, taskId);
        const storeB = await createInitializedStore(rootB, taskId);
        await storeA.writeImmutable({ taskId, kind: "source", content: "same task/blob payload" });
        const blobB = await storeB.writeImmutable({ taskId, kind: "source", content: "same task/blob payload" });

        await assert.rejects(
            () => storeB.cancelTask({
                taskId,
                cancellationProof: cancellationProof(rootA, taskId),
                releaseProofs: [releaseProof(rootA, taskId, "source", blobB.reference)],
            }),
            error => error instanceof spool.RecordSchedulerSpoolDiscardDeniedError,
        );
        assert.equal((await storeB.readImmutable({ taskId, kind: "source", reference: blobB.reference })).toString("utf8"), "same task/blob payload");

        const tamperedRelease = {
            ...releaseProof(rootB, taskId, "source", blobB.reference),
            releaseEvidenceId: "f".repeat(64),
        };
        const retained = await storeB.cancelTask({
            taskId,
            cancellationProof: cancellationProof(rootB, taskId),
            releaseProofs: [tamperedRelease],
        });
        assert.equal(retained.removed.length, 0);
        assert.equal(retained.retained.length, 1);
        assert.equal(retained.retained[0]?.reason, "mismatched_release_proof");

        const cleaned = await storeB.cancelTask({
            taskId,
            cancellationProof: cancellationProof(rootB, taskId),
            releaseProofs: [releaseProof(rootB, taskId, "source", blobB.reference)],
        });
        assert.equal(cleaned.cleanupComplete, true);
        assert.equal(cleaned.removed.length, 1);
    } finally {
        await fs.rm(rootA, { recursive: true, force: true });
        await fs.rm(rootB, { recursive: true, force: true });
    }
});

await runTest("manifest tombstone and private-root loss never recreate state", async () => {
    await withTempRoot(async dataRoot => {
        const taskId = "task-manifest-loss";
        const store = await createInitializedStore(dataRoot, taskId);
        const privateRoot = path.join(dataRoot, PRIVATE_ROOT_NAME);
        const manifestName = (await fs.readdir(privateRoot)).find(entry => entry.startsWith(`m.${sha256(taskId)}.`));
        assert.ok(manifestName);
        await fs.unlink(path.join(privateRoot, manifestName));
        await assert.rejects(
            () => store.writeImmutable({ taskId, kind: "source", content: "must not resurrect" }),
            (error: unknown) => error instanceof spool.RecordSchedulerSpoolRepairRequiredError && error.reason === "missing_task_manifest",
        );
        assert.equal((await fs.readdir(privateRoot)).some(entry => entry.startsWith(`m.${sha256(taskId)}.`)), false);
    });

    await withTempRoot(async dataRoot => {
        const taskId = "task-tombstone-loss";
        const store = await createInitializedStore(dataRoot, taskId);
        await store.cancelTask({ taskId, cancellationProof: cancellationProof(dataRoot, taskId), releaseProofs: [] });
        const privateRoot = path.join(dataRoot, PRIVATE_ROOT_NAME);
        const tombstoneName = (await fs.readdir(privateRoot)).find(entry => entry.startsWith(`t.${sha256(taskId)}.`));
        assert.ok(tombstoneName);
        await fs.unlink(path.join(privateRoot, tombstoneName));
        await assert.rejects(
            () => store.initializeTask({ taskId, mode: "open" }),
            (error: unknown) => error instanceof spool.RecordSchedulerSpoolRepairRequiredError && error.reason === "missing_task_tombstone",
        );
        assert.equal((await fs.readdir(privateRoot)).some(entry => entry.startsWith(`t.${sha256(taskId)}.`)), false);
    });

    await withTempRoot(async dataRoot => {
        const taskId = "task-root-loss";
        const store = await createInitializedStore(dataRoot, taskId);
        const privateRoot = path.join(dataRoot, PRIVATE_ROOT_NAME);
        const movedRoot = `${privateRoot}.missing`;
        await fs.rename(privateRoot, movedRoot);
        try {
            await assert.rejects(
                () => store.writeImmutable({ taskId, kind: "output", content: "must stay absent" }),
                (error: unknown) => error instanceof spool.RecordSchedulerSpoolRepairRequiredError && error.reason === "missing_private_root",
            );
            await assert.rejects(() => fs.access(privateRoot));
        } finally {
            await fs.rename(movedRoot, privateRoot);
        }
    });
});

await runTest("late-write race and concurrent link cancellation leave no visible blob", async () => {
    await withTempRoot(async dataRoot => {
        const taskId = "task-late-write";
        const reached = deferred();
        const resume = deferred();
        let lateReference: BlobReference | undefined;
        let pause = true;
        const store = await createInitializedStore(dataRoot, taskId, {
            faultInjector: async event => {
                if (pause && event.point === "before-blob-link") {
                    pause = false;
                    lateReference = event.reference;
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const write = store.writeImmutable({ taskId, kind: "output", content: "late output" });
        await reached.promise;
        const capturedLateReference = lateReference;
        assert.ok(capturedLateReference);
        const cancelled = await store.cancelTask({
            taskId,
            cancellationProof: cancellationProof(dataRoot, taskId),
            releaseProofs: [releaseProof(dataRoot, taskId, "output", capturedLateReference)],
        });
        resume.resolve();
        await assert.rejects(() => write, error => error instanceof spool.RecordSchedulerSpoolTaskSealedError);
        assert.equal(cancelled.cleanupComplete, true);
        await assert.rejects(() => fs.access(path.join(dataRoot, ...capturedLateReference.path.split("/"))));
    });

    await withTempRoot(async dataRoot => {
        const taskId = "task-link-cancel";
        const reached = deferred();
        const resume = deferred();
        let linkedReference: BlobReference | undefined;
        let pause = true;
        const store = await createInitializedStore(dataRoot, taskId, {
            faultInjector: async event => {
                if (pause && event.point === "after-blob-link") {
                    pause = false;
                    linkedReference = event.reference;
                    reached.resolve();
                    await resume.promise;
                }
            },
        });
        const write = store.writeImmutable({ taskId, kind: "source", content: "linked before cancel" });
        await reached.promise;
        const capturedLinkedReference = linkedReference;
        assert.ok(capturedLinkedReference);
        const cancelled = await store.cancelTask({
            taskId,
            cancellationProof: cancellationProof(dataRoot, taskId),
            releaseProofs: [releaseProof(dataRoot, taskId, "source", capturedLinkedReference)],
        });
        resume.resolve();
        await assert.rejects(() => write, error => error instanceof spool.RecordSchedulerSpoolTaskSealedError);
        assert.equal(cancelled.cleanupComplete, true);
        await assert.rejects(() => fs.access(path.join(dataRoot, ...capturedLinkedReference.path.split("/"))));
    });
});

await runTest("junction swap before publish is rejected without writing outside root", async () => {
    await withTempRoot(async dataRoot => {
        const taskId = "task-junction-swap";
        const privateRoot = path.join(dataRoot, PRIVATE_ROOT_NAME);
        const savedRoot = `${privateRoot}.saved`;
        const outsideRoot = path.join(dataRoot, "outside-target");
        let swapped = false;
        const store = await createInitializedStore(dataRoot, taskId, {
            faultInjector: async event => {
                if (!swapped && event.point === "before-blob-link") {
                    swapped = true;
                    await fs.rename(privateRoot, savedRoot);
                    await fs.mkdir(outsideRoot);
                    await fs.symlink(outsideRoot, privateRoot, process.platform === "win32" ? "junction" : "dir");
                }
            },
        });
        try {
            await assert.rejects(
                () => store.writeImmutable({ taskId, kind: "output", content: "must not escape" }),
                (error: unknown) => error instanceof spool.RecordSchedulerSpoolRepairRequiredError
                    && (error.reason === "unsafe_spool_path" || error.reason === "private_root_replaced"),
            );
            assert.deepEqual(await fs.readdir(outsideRoot), []);
        } finally {
            if (swapped) {
                await fs.unlink(privateRoot);
                await fs.rename(savedRoot, privateRoot);
            }
        }
    });
});

await runTest("multiple child hard-exit boundaries recover from task tombstone", async () => {
    await withTempRoot(async dataRoot => {
        const writeTask = "task-child-write-crash";
        const parent = await createInitializedStore(dataRoot, writeTask);
        const writeContent = "child linked output";
        const writeReference = expectedReference(writeTask, "output", writeContent);
        await runHardExitChild({
            SPOOL_DATA_ROOT: dataRoot,
            SPOOL_FAULT_POINT: "after-blob-link-before-directory-sync",
            SPOOL_CHILD_INPUT: JSON.stringify({ operation: "write", taskId: writeTask, kind: "output", content: writeContent }),
        }, 71);

        const recoveredWriteTask = spool.createRecordSchedulerSpool({
            dataRoot,
            directoryDurability: simulatedDirectoryDurability(),
            proofVerifier: authoritativeVerifier(dataRoot),
        });
        await recoveredWriteTask.initializeRoot({ mode: "open" });
        await recoveredWriteTask.initializeTask({ taskId: writeTask, mode: "open" });
        const writeCleanup = await recoveredWriteTask.cancelTask({
            taskId: writeTask,
            cancellationProof: cancellationProof(dataRoot, writeTask),
            releaseProofs: [releaseProof(dataRoot, writeTask, "output", writeReference)],
        });
        assert.equal(writeCleanup.cleanupComplete, true);
        assert.equal(writeCleanup.removed.length, 1);
        assert.equal(writeCleanup.removedTemporaryFiles >= 1, true);

        const cancelTask = "task-child-cancel-crash";
        await parent.initializeTask({ taskId: cancelTask, mode: "create" });
        const output = await parent.writeImmutable({ taskId: cancelTask, kind: "output", content: "cancel crash output" });
        const childCancelInput = {
            operation: "cancel",
            taskId: cancelTask,
            cancellationProof: cancellationProof(dataRoot, cancelTask),
            releaseProofs: [releaseProof(dataRoot, cancelTask, "output", output.reference)],
        };
        await runHardExitChild({
            SPOOL_DATA_ROOT: dataRoot,
            SPOOL_FAULT_POINT: "after-task-tombstone-link-before-directory-sync",
            SPOOL_CHILD_INPUT: JSON.stringify(childCancelInput),
        }, 72);

        const recoveredCancelTask = spool.createRecordSchedulerSpool({
            dataRoot,
            directoryDurability: simulatedDirectoryDurability(),
            proofVerifier: authoritativeVerifier(dataRoot),
        });
        await recoveredCancelTask.initializeRoot({ mode: "open" });
        await recoveredCancelTask.initializeTask({ taskId: cancelTask, mode: "open" });
        const cancelCleanup = await recoveredCancelTask.cancelTask({
            taskId: cancelTask,
            cancellationProof: cancellationProof(dataRoot, cancelTask),
            releaseProofs: [releaseProof(dataRoot, cancelTask, "output", output.reference)],
        });
        assert.equal(cancelCleanup.cleanupComplete, true);
        assert.equal(cancelCleanup.removed.length, 1);
    });
});

console.log(`record-scheduler-spool adversarial tests passed on ${process.platform} ${process.version}`);

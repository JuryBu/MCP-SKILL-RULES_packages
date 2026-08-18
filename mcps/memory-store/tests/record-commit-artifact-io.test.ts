import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
    RecordCommitArtifactIdentity,
    RecordCommitArtifactTarget,
} from "../src/record-store.ts";
import type { RecordCommitReaderIndexEntry } from "../src/record-update-coordination.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-commit-artifact-io-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const {
    calculateRecordCommitArtifactJsonHash,
    getRecordCommitArtifactRelativePath,
    readRecordCommitBodyArtifact,
    readRecordCommitMainIndexArtifact,
    restoreRecordCommitBodyIfOwned,
    restoreRecordCommitMainIndexIfOwned,
    validateRecordCommitArtifactTarget,
    withRecordCommitArtifactLock,
    writeRecord,
    writeRecordCommitBodyConditionally,
    writeRecordCommitMainIndexConditionally,
} = await import("../src/record-store.ts");
const {
    readRecordCommitReaderIndexArtifact,
    rebuildRecordCommitReaderIndexFromBody,
    writeRecordCommitReaderIndexConditionally,
} = await import("../src/record-update-coordination.ts");

function bodyHash(body: string): string {
    return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

function identity(
    conversationId: string,
    recordId: string,
    commitId: string,
    coveredRevision: string,
    body: string,
    recordCommitEpoch: number,
): RecordCommitArtifactIdentity {
    return { conversationId, recordId, commitId, coveredRevision, bodyHash: bodyHash(body), recordCommitEpoch };
}

function target(
    kind: RecordCommitArtifactTarget["kind"],
    conversationId: string,
    recordId: string,
): RecordCommitArtifactTarget {
    return {
        kind,
        conversationId,
        recordId,
        relativePath: getRecordCommitArtifactRelativePath(kind, conversationId),
    };
}

function mainEntry(value: RecordCommitArtifactIdentity) {
    return {
        commitId: value.commitId,
        coveredRevision: value.coveredRevision,
        conversationId: value.conversationId,
        recordId: value.recordId,
    };
}

function readerEntry(value: RecordCommitArtifactIdentity): RecordCommitReaderIndexEntry {
    return {
        commitId: value.commitId,
        bodyHash: value.bodyHash,
        coveredRevision: value.coveredRevision,
        conversationId: value.conversationId,
        recordId: value.recordId,
    };
}

const authorize = async () => true;

async function failNextAtomicRename(destinationSuffix: string, operation: () => Promise<void>): Promise<void> {
    const promises = fs.promises as unknown as {
        rename: (from: string, to: string) => Promise<void>;
    };
    const originalRename = promises.rename;
    let injected = false;
    promises.rename = async (from, to) => {
        if (!injected && to.endsWith(destinationSuffix)) {
            injected = true;
            throw Object.assign(new Error(`injected rename failure: ${destinationSuffix}`), { code: "EIO" });
        }
        return originalRename(from, to);
    };
    try {
        await operation();
        assert.ok(injected, `应在 ${destinationSuffix} 的原子 rename 注入故障`);
    } finally {
        promises.rename = originalRename;
    }
}

async function failNextUnlink(destinationSuffix: string, operation: () => Promise<void>): Promise<void> {
    const promises = fs.promises as unknown as {
        unlink: (filePath: string) => Promise<void>;
    };
    const originalUnlink = promises.unlink;
    let injected = false;
    promises.unlink = async filePath => {
        if (!injected && filePath.endsWith(destinationSuffix)) {
            injected = true;
            throw Object.assign(new Error(`injected unlink failure: ${destinationSuffix}`), { code: "EIO" });
        }
        return originalUnlink(filePath);
    };
    try {
        await operation();
        assert.ok(injected, `应在 ${destinationSuffix} 的 unlink 注入故障`);
    } finally {
        promises.unlink = originalUnlink;
    }
}

async function runLockFixture(hash: string, mode = "crash"): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/record-commit-lock-crash.mjs", hash, mode], {
            cwd: process.cwd(),
            env: { ...process.env, MEMORY_STORE_DATA_ROOT: dataRoot },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", code => resolve({ code, stdout, stderr }));
    });
}

function recordCommitLockPath(hash: string): string {
    return path.join(dataRoot, "workspaces", hash, "records", "_record_commit_artifacts.lock");
}

function currentProcessStartedAtMs(): number {
    return Math.round(Date.now() - process.uptime() * 1_000);
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("等待测试同步条件超时");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function publishTrio(
    hash: string,
    currentIdentity: RecordCommitArtifactIdentity,
    body: string,
    expected: {
        body: Awaited<ReturnType<typeof readRecordCommitBodyArtifact>>;
        main: Awaited<ReturnType<typeof readRecordCommitMainIndexArtifact>>;
        reader: Awaited<ReturnType<typeof readRecordCommitReaderIndexArtifact>>;
    },
) {
    const bodyTarget = target("record_body", currentIdentity.conversationId, currentIdentity.recordId);
    const mainTarget = target("main_index", currentIdentity.conversationId, currentIdentity.recordId);
    const readerTarget = target("reader_index", currentIdentity.conversationId, currentIdentity.recordId);
    const bodyResult = await writeRecordCommitBodyConditionally({
        hash,
        target: bodyTarget,
        identity: currentIdentity,
        body,
        expected: expected.body,
        validateOwnership: authorize,
    });
    const mainResult = await writeRecordCommitMainIndexConditionally({
        hash,
        target: mainTarget,
        identity: currentIdentity,
        entry: mainEntry(currentIdentity),
        expected: expected.main,
        validateOwnership: authorize,
        recordMeta: { title: currentIdentity.commitId },
    });
    const readerResult = await writeRecordCommitReaderIndexConditionally({
        hash,
        target: readerTarget,
        identity: currentIdentity,
        index: readerEntry(currentIdentity),
        expected: expected.reader,
        validateOwnership: authorize,
    });
    return { bodyResult, mainResult, readerResult, bodyTarget, mainTarget, readerTarget };
}

try {
    const hash = "stage8-artifact-io";
    const conversationId = "conversation-normal";
    const recordId = "record-normal";
    const body = "# Stage 8\n\n## Phase 1\n\n正文";
    const first = identity(conversationId, recordId, "commit-a", "revision-a", body, 1);
    const bodyTarget = target("record_body", conversationId, recordId);
    const mainTarget = target("main_index", conversationId, recordId);
    const readerTarget = target("reader_index", conversationId, recordId);
    const before = {
        body: await readRecordCommitBodyArtifact(hash, bodyTarget),
        main: await readRecordCommitMainIndexArtifact(hash, mainTarget),
        reader: await readRecordCommitReaderIndexArtifact(hash, readerTarget),
    };

    const published = await publishTrio(hash, first, body, before);
    assert.deepEqual(
        [published.bodyResult.kind, published.mainResult.kind, published.readerResult.kind],
        ["applied", "applied", "applied"],
        "正文、主索引、Reader Index 必须可以逐步条件写入",
    );
    const bodyAfter = await readRecordCommitBodyArtifact(hash, bodyTarget);
    const mainAfter = await readRecordCommitMainIndexArtifact(hash, mainTarget);
    const readerAfter = await readRecordCommitReaderIndexArtifact(hash, readerTarget);
    assert.equal(bodyAfter.identity?.commitId, "commit-a");
    assert.equal(bodyAfter.hash, first.bodyHash);
    assert.deepEqual(mainAfter.value, mainEntry(first));
    assert.equal(mainAfter.identity?.bodyHash, first.bodyHash);
    assert.deepEqual(readerAfter.value, readerEntry(first));
    assert.equal(readerAfter.identity?.bodyHash, first.bodyHash);

    const repeated = await publishTrio(hash, first, body, before);
    assert.deepEqual(
        [repeated.bodyResult.kind, repeated.mainResult.kind, repeated.readerResult.kind],
        ["already_applied", "already_applied", "already_applied"],
        "每一步重复执行必须幂等并回读当前 artifact",
    );

    const crashedLockHash = "record-commit-lock-crashed-owner";
    const crashedChild = await runLockFixture(crashedLockHash);
    assert.equal(crashedChild.code, 73, `子进程应在持锁回调内硬退出，stderr: ${crashedChild.stderr}`);
    assert.match(crashedChild.stdout, /locked/u, "子进程必须先成功取得 artifact 锁");
    const takeoverStartedAt = Date.now();
    await withRecordCommitArtifactLock(crashedLockHash, async () => undefined);
    assert.ok(Date.now() - takeoverStartedAt < 5_000, "已死亡 owner 的有效锁 metadata 应在远低于 30 秒时限内回收");

    const reusedPidLockHash = "record-commit-lock-reused-pid";
    const reusedPidStartedAt = Date.now();
    const reusedPidChild = await runLockFixture(reusedPidLockHash, "reused-pid");
    assert.equal(reusedPidChild.code, 0, `伪造旧实例的当前存活 PID 锁应被接管，stderr: ${reusedPidChild.stderr}`);
    assert.match(reusedPidChild.stdout, /taken/u, "启动时间不匹配时必须识别为 PID 复用并接管锁");
    assert.ok(Date.now() - reusedPidStartedAt < 5_000, "PID 复用恢复不能等到 30 秒 acquire 超时");

    const liveOwnerLockHash = "record-commit-lock-live-owner";
    const liveOwnerStartedAt = Date.now();
    const liveOwnerChild = await runLockFixture(liveOwnerLockHash, "matching-owner");
    assert.equal(liveOwnerChild.code, 0, `当前真实 owner 的锁应保持不可接管，stderr: ${liveOwnerChild.stderr}`);
    assert.match(liveOwnerChild.stdout, /blocked/u, "同一 PID 且启动时间匹配时不能隔离锁");
    assert.doesNotMatch(liveOwnerChild.stdout, /taken/u, "当前真实 owner 绝不能被按短 TTL 误抢");
    assert.ok(Date.now() - liveOwnerStartedAt < 5_000, "真实 owner 用例应由 fixture 快速收束，而非等待 acquire 超时");

    const doubleReadLockHash = "record-commit-lock-double-read-token-change";
    const doubleReadLockPath = recordCommitLockPath(doubleReadLockHash);
    await fs.promises.mkdir(path.dirname(doubleReadLockPath), { recursive: true });
    await fs.promises.writeFile(doubleReadLockPath, JSON.stringify({
        token: "double-read-observed-token",
        ownerPid: 999_999_999,
        createdAtMs: Date.now() - 60_000,
    }), "utf8");
    const promises = fs.promises as unknown as {
        readFile: (filePath: fs.PathLike | number, options?: unknown) => Promise<string | Buffer>;
    };
    const originalReadFile = promises.readFile;
    let lockReadCount = 0;
    let doubleReadAcquired = false;
    promises.readFile = async (filePath, options) => {
        if (String(filePath) === doubleReadLockPath && ++lockReadCount === 2) {
            await fs.promises.writeFile(doubleReadLockPath, JSON.stringify({
                token: "double-read-replacement-token",
                ownerPid: process.pid,
                createdAtMs: Date.now(),
                ownerStartedAtMs: currentProcessStartedAtMs(),
            }), "utf8");
        }
        return originalReadFile(filePath, options);
    };
    const doubleReadWaiter = withRecordCommitArtifactLock(doubleReadLockHash, async () => {
        doubleReadAcquired = true;
    });
    try {
        await waitUntil(() => lockReadCount >= 2);
        promises.readFile = originalReadFile;
        const replacement = JSON.parse(await fs.promises.readFile(doubleReadLockPath, "utf8")) as { token?: string };
        assert.equal(replacement.token, "double-read-replacement-token", "双读期间 token 变化后不得删除或隔离替换锁");
        assert.equal(doubleReadAcquired, false, "替换为存活 owner 的锁后当前 waiter 不能直接取得锁");
    } finally {
        promises.readFile = originalReadFile;
        await fs.promises.rm(doubleReadLockPath, { force: true });
    }
    await doubleReadWaiter;
    assert.equal(doubleReadAcquired, true, "测试清理锁后 waiter 应能正常结束");

    const intentOnlyConversationId = "conversation-intent-write-failure";
    const intentOnlyRecordId = "record-intent-write-failure";
    const intentOnlyOldBody = "# intent old";
    const intentOnlyOldIdentity = identity(intentOnlyConversationId, intentOnlyRecordId, "commit-intent-old", "revision-intent-old", intentOnlyOldBody, 1);
    const intentOnlyNewBody = "# intent new";
    const intentOnlyNewIdentity = identity(intentOnlyConversationId, intentOnlyRecordId, "commit-intent-new", "revision-intent-new", intentOnlyNewBody, 2);
    const intentOnlyTarget = target("record_body", intentOnlyConversationId, intentOnlyRecordId);
    const intentOnlyEmpty = await readRecordCommitBodyArtifact(hash, intentOnlyTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: intentOnlyTarget,
        identity: intentOnlyOldIdentity,
        body: intentOnlyOldBody,
        expected: intentOnlyEmpty,
        validateOwnership: authorize,
    });
    const intentOnlyBefore = await readRecordCommitBodyArtifact(hash, intentOnlyTarget);
    await assert.rejects(
        failNextAtomicRename(`${intentOnlyConversationId}.record_commit_body.intent.json`, async () => {
            await writeRecordCommitBodyConditionally({
                hash,
                target: intentOnlyTarget,
                identity: intentOnlyNewIdentity,
                body: intentOnlyNewBody,
                expected: intentOnlyBefore,
                validateOwnership: authorize,
            });
        }),
        /injected rename failure/u,
        "intent 自身未持久化时不得开始 identity/body 发布",
    );
    assert.equal((await readRecordCommitBodyArtifact(hash, intentOnlyTarget)).body, intentOnlyOldBody);

    const identityFailureConversationId = "conversation-identity-write-failure";
    const identityFailureRecordId = "record-identity-write-failure";
    const identityFailureOldBody = "# identity old";
    const identityFailureOldIdentity = identity(identityFailureConversationId, identityFailureRecordId, "commit-identity-old", "revision-identity-old", identityFailureOldBody, 1);
    const identityFailureNewBody = "# identity new";
    const identityFailureNewIdentity = identity(identityFailureConversationId, identityFailureRecordId, "commit-identity-new", "revision-identity-new", identityFailureNewBody, 2);
    const identityFailureTarget = target("record_body", identityFailureConversationId, identityFailureRecordId);
    const identityFailureEmpty = await readRecordCommitBodyArtifact(hash, identityFailureTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: identityFailureTarget,
        identity: identityFailureOldIdentity,
        body: identityFailureOldBody,
        expected: identityFailureEmpty,
        validateOwnership: authorize,
    });
    const identityFailureBefore = await readRecordCommitBodyArtifact(hash, identityFailureTarget);
    await assert.rejects(
        failNextAtomicRename(`${identityFailureConversationId}.record_commit_body.json`, async () => {
            await writeRecordCommitBodyConditionally({
                hash,
                target: identityFailureTarget,
                identity: identityFailureNewIdentity,
                body: identityFailureNewBody,
                expected: identityFailureBefore,
                validateOwnership: authorize,
            });
        }),
        /injected rename failure/u,
        "identity 失败时不得暴露新正文",
    );
    const identityFailureVisible = await readRecordCommitBodyArtifact(hash, identityFailureTarget);
    assert.equal(identityFailureVisible.body, identityFailureOldBody, "identity 持久化失败前必须继续读取旧正文");
    assert.equal(identityFailureVisible.identity?.commitId, identityFailureOldIdentity.commitId);
    assert.equal((await writeRecordCommitBodyConditionally({
        hash,
        target: identityFailureTarget,
        identity: identityFailureNewIdentity,
        body: identityFailureNewBody,
        expected: identityFailureBefore,
        validateOwnership: authorize,
    })).kind, "applied", "同条件重试应接管自己的 durable intent 并完成 identity→body 发布");

    const bodyFailureConversationId = "conversation-body-write-failure";
    const bodyFailureRecordId = "record-body-write-failure";
    const bodyFailureOldBody = "# body old";
    const bodyFailureOldIdentity = identity(bodyFailureConversationId, bodyFailureRecordId, "commit-body-old", "revision-body-old", bodyFailureOldBody, 1);
    const bodyFailureNewBody = "# body new";
    const bodyFailureNewIdentity = identity(bodyFailureConversationId, bodyFailureRecordId, "commit-body-new", "revision-body-new", bodyFailureNewBody, 2);
    const bodyFailureOtherIdentity = identity(bodyFailureConversationId, bodyFailureRecordId, "commit-body-other", "revision-body-other", "# other", 3);
    const bodyFailureTarget = target("record_body", bodyFailureConversationId, bodyFailureRecordId);
    const bodyFailureEmpty = await readRecordCommitBodyArtifact(hash, bodyFailureTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: bodyFailureTarget,
        identity: bodyFailureOldIdentity,
        body: bodyFailureOldBody,
        expected: bodyFailureEmpty,
        validateOwnership: authorize,
    });
    const bodyFailureBefore = await readRecordCommitBodyArtifact(hash, bodyFailureTarget);
    await assert.rejects(
        failNextAtomicRename(`${bodyFailureConversationId}.md`, async () => {
            await writeRecordCommitBodyConditionally({
                hash,
                target: bodyFailureTarget,
                identity: bodyFailureNewIdentity,
                body: bodyFailureNewBody,
                expected: bodyFailureBefore,
                validateOwnership: authorize,
            });
        }),
        /injected rename failure/u,
        "identity 已写但正文失败时必须保留恢复 intent",
    );
    const bodyFailureVisible = await readRecordCommitBodyArtifact(hash, bodyFailureTarget);
    assert.equal(bodyFailureVisible.body, bodyFailureOldBody, "identity 已写、body 未写时仍必须读取旧正文");
    assert.equal(bodyFailureVisible.identity?.commitId, bodyFailureOldIdentity.commitId);
    assert.equal((await writeRecordCommitBodyConditionally({
        hash,
        target: bodyFailureTarget,
        identity: bodyFailureOtherIdentity,
        body: "# other",
        expected: bodyFailureBefore,
        validateOwnership: async () => false,
    })).kind, "ownership_changed", "普通未授权的别的 commit 不得接管遗留 intent");
    assert.equal((await writeRecordCommitBodyConditionally({
        hash,
        target: bodyFailureTarget,
        identity: bodyFailureNewIdentity,
        body: bodyFailureNewBody,
        expected: bodyFailureBefore,
        validateOwnership: authorize,
    })).kind, "applied", "body 中断后同条件重试必须自愈");
    const bodyFailureAfter = await readRecordCommitBodyArtifact(hash, bodyFailureTarget);
    assert.equal(bodyFailureAfter.body, bodyFailureNewBody);
    assert.equal(bodyFailureAfter.hash, bodyFailureNewIdentity.bodyHash);
    assert.equal(bodyFailureAfter.identity?.bodyHash, bodyFailureAfter.hash, "正文完成后 identity/bodyHash 必须一致");

    const successorConversationId = "conversation-successor-compensation";
    const successorRecordId = "record-successor-compensation";
    const successorBeforeBody = "# successor before";
    const successorBeforeIdentity = identity(successorConversationId, successorRecordId, "commit-successor-before", "revision-before", successorBeforeBody, 1);
    const successorABody = "# successor A";
    const successorAIdentity = identity(successorConversationId, successorRecordId, "commit-successor-a", "revision-a", successorABody, 2);
    const successorBBody = "# successor B";
    const successorBIdentity = identity(successorConversationId, successorRecordId, "commit-successor-b", "revision-b", successorBBody, 3);
    const successorTarget = target("record_body", successorConversationId, successorRecordId);
    const successorEmpty = await readRecordCommitBodyArtifact(hash, successorTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: successorTarget,
        identity: successorBeforeIdentity,
        body: successorBeforeBody,
        expected: successorEmpty,
        validateOwnership: authorize,
    });
    const successorBefore = await readRecordCommitBodyArtifact(hash, successorTarget);
    await assert.rejects(
        failNextAtomicRename(`${successorConversationId}.md`, async () => {
            await writeRecordCommitBodyConditionally({
                hash,
                target: successorTarget,
                identity: successorAIdentity,
                body: successorABody,
                expected: successorBefore,
                validateOwnership: authorize,
            });
        }),
        /injected rename failure/u,
        "A 在 body 发布前失败后必须留下可由 successor 补偿的 intent",
    );
    let successorAuthorityCalls = 0;
    const successorPhases: string[] = [];
    const successorResult = await writeRecordCommitBodyConditionally({
        hash,
        target: successorTarget,
        identity: successorBIdentity,
        body: successorBBody,
        expected: successorBefore,
        withCommitAuthority: async operation => {
            successorAuthorityCalls += 1;
            return operation();
        },
        validateOwnership: async input => {
            successorPhases.push(input.phase);
            return true;
        },
    });
    assert.equal(successorResult.kind, "applied", "已授权 successor 必须先补偿 A intent，再成功发布 B");
    assert.equal(successorAuthorityCalls, 1, "successor 补偿与发布必须处于同一个 commit authority scope");
    assert.deepEqual(successorPhases, ["before_write", "after_write"]);
    assert.equal((await readRecordCommitBodyArtifact(hash, successorTarget)).identity?.commitId, successorBIdentity.commitId);
    assert.equal((await writeRecordCommitBodyConditionally({
        hash,
        target: successorTarget,
        identity: successorAIdentity,
        body: successorABody,
        expected: successorBefore,
        validateOwnership: async () => false,
    })).kind, "ownership_changed", "失去 registry ownership 的 A 后续不得覆盖 B");
    assert.equal((await readRecordCommitBodyArtifact(hash, successorTarget)).body, successorBBody);

    const nonrecoverableConversationId = "conversation-successor-nonrecoverable";
    const nonrecoverableRecordId = "record-successor-nonrecoverable";
    const nonrecoverableOldBody = "# nonrecoverable old";
    const nonrecoverableOldIdentity = identity(nonrecoverableConversationId, nonrecoverableRecordId, "commit-nonrecoverable-old", "revision-old", nonrecoverableOldBody, 1);
    const nonrecoverableABody = "# nonrecoverable A";
    const nonrecoverableAIdentity = identity(nonrecoverableConversationId, nonrecoverableRecordId, "commit-nonrecoverable-a", "revision-a", nonrecoverableABody, 2);
    const nonrecoverableBBody = "# nonrecoverable B";
    const nonrecoverableBIdentity = identity(nonrecoverableConversationId, nonrecoverableRecordId, "commit-nonrecoverable-b", "revision-b", nonrecoverableBBody, 3);
    const nonrecoverableTarget = target("record_body", nonrecoverableConversationId, nonrecoverableRecordId);
    const nonrecoverableEmpty = await readRecordCommitBodyArtifact(hash, nonrecoverableTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: nonrecoverableTarget,
        identity: nonrecoverableOldIdentity,
        body: nonrecoverableOldBody,
        expected: nonrecoverableEmpty,
        validateOwnership: authorize,
    });
    const nonrecoverableBefore = await readRecordCommitBodyArtifact(hash, nonrecoverableTarget);
    await assert.rejects(
        failNextAtomicRename(`${nonrecoverableConversationId}.md`, async () => {
            await writeRecordCommitBodyConditionally({
                hash,
                target: nonrecoverableTarget,
                identity: nonrecoverableAIdentity,
                body: nonrecoverableABody,
                expected: nonrecoverableBefore,
                validateOwnership: authorize,
            });
        }),
        /injected rename failure/u,
    );
    fs.writeFileSync(path.join(dataRoot, "workspaces", hash, "records", `${nonrecoverableConversationId}.md`), "# tampered after A intent", "utf8");
    await assert.rejects(
        writeRecordCommitBodyConditionally({
            hash,
            target: nonrecoverableTarget,
            identity: nonrecoverableBIdentity,
            body: nonrecoverableBBody,
            expected: nonrecoverableBefore,
            validateOwnership: authorize,
        }),
        /RepairRequired/u,
        "successor 只能补偿仍为 intent.before body 的状态，body 被篡改后必须 fail closed",
    );

    const corruptionConversationId = "conversation-identity-corruption";
    const corruptionRecordId = "record-identity-corruption";
    const corruptionBody = "# intact body with corrupted identity";
    const corruptionIdentity = identity(corruptionConversationId, corruptionRecordId, "commit-corruption", "revision-corruption", corruptionBody, 1);
    const corruptionTarget = target("record_body", corruptionConversationId, corruptionRecordId);
    const recordsDir = path.join(dataRoot, "workspaces", hash, "records");
    fs.writeFileSync(path.join(recordsDir, `${corruptionConversationId}.md`), corruptionBody, "utf8");
    fs.writeFileSync(
        path.join(recordsDir, `${corruptionConversationId}.record_commit_body.json`),
        JSON.stringify({ ...corruptionIdentity, bodyHash: bodyHash("# different body") }),
        "utf8",
    );
    await assert.rejects(
        readRecordCommitBodyArtifact(hash, corruptionTarget),
        /RepairRequired/u,
        "无 intent 的 identity.bodyHash 与实际正文不一致时不得返回合法 owner image",
    );
    const legacyConversationId = "conversation-legacy-no-identity";
    const legacyTarget = target("record_body", legacyConversationId, "record-legacy-no-identity");
    fs.writeFileSync(path.join(recordsDir, `${legacyConversationId}.md`), "# legacy body", "utf8");
    const legacyImage = await readRecordCommitBodyArtifact(hash, legacyTarget);
    assert.equal(legacyImage.body, "# legacy body", "无 identity 的 legacy 正文仍应可读");
    assert.equal(legacyImage.identity, null);

    const directWriteConversationId = "conversation-direct-write-invalidates-identity";
    const directWriteTarget = target("record_body", directWriteConversationId, directWriteConversationId);
    const committedDirectBody = "# committed before direct write";
    const directWriteIdentity = identity(
        directWriteConversationId,
        directWriteConversationId,
        "commit-before-direct-write",
        "revision-before-direct-write",
        committedDirectBody,
        1,
    );
    const directWritePublished = await publishTrio(hash, directWriteIdentity, committedDirectBody, {
        body: await readRecordCommitBodyArtifact(hash, directWriteTarget),
        main: await readRecordCommitMainIndexArtifact(hash, target("main_index", directWriteConversationId, directWriteConversationId)),
        reader: await readRecordCommitReaderIndexArtifact(hash, target("reader_index", directWriteConversationId, directWriteConversationId)),
    });
    assert.deepEqual(
        [directWritePublished.bodyResult.kind, directWritePublished.mainResult.kind, directWritePublished.readerResult.kind],
        ["applied", "applied", "applied"],
        "直接写入前必须由 scheduler commit 占有正文、主索引与 Reader Index 三件套",
    );
    await writeRecord(hash, directWriteConversationId, "# manual direct write", {
        title: "manual direct write",
        totalRounds: 1,
        totalSteps: 1,
        lastUpdatedRound: 1,
        phases: 1,
    });
    const [directWriteImage, directWriteMain, directWriteReader] = await Promise.all([
        readRecordCommitBodyArtifact(hash, directWriteTarget),
        readRecordCommitMainIndexArtifact(hash, directWritePublished.mainTarget),
        readRecordCommitReaderIndexArtifact(hash, directWritePublished.readerTarget),
    ]);
    assert.equal(directWriteImage.body, "# manual direct write");
    assert.equal(directWriteImage.identity, null, "legacy direct writes must invalidate stale commit identity before replacing the body");
    assert.equal(directWriteMain.identity, null, "直接写入后主索引必须重建为 ownerless legacy entry");
    assert.equal(directWriteMain.ownerCommitId, null);
    assert.equal(directWriteMain.value?.conversationId, directWriteConversationId);
    assert.equal(directWriteReader.value, null, "直接写入必须删除旧 Reader Index");
    assert.equal(directWriteReader.identity, null);
    assert.equal(directWriteReader.storageValue, null, "旧 Reader Index sidecar 不得残留");

    const deleteConversationId = "conversation-delete-retry";
    const deleteRecordId = "record-delete-retry";
    const deleteBody = "# delete retry";
    const deleteIdentity = identity(deleteConversationId, deleteRecordId, "commit-delete", "revision-delete", deleteBody, 1);
    const deleteTarget = target("record_body", deleteConversationId, deleteRecordId);
    const deleteBefore = await readRecordCommitBodyArtifact(hash, deleteTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: deleteTarget,
        identity: deleteIdentity,
        body: deleteBody,
        expected: deleteBefore,
        validateOwnership: authorize,
    });
    await assert.rejects(
        failNextUnlink(`${deleteConversationId}.md`, async () => {
            await restoreRecordCommitBodyIfOwned({
                hash,
                target: deleteTarget,
                identity: deleteIdentity,
                expectedBodyHash: deleteIdentity.bodyHash,
                before: deleteBefore,
                validateOwnership: authorize,
            });
        }),
        /injected unlink failure/u,
        "删除正文在 identity→body 边界中断时必须保留恢复 intent",
    );
    assert.equal((await readRecordCommitBodyArtifact(hash, deleteTarget)).body, deleteBody, "删除中断后仍必须读取旧正文");
    assert.equal((await restoreRecordCommitBodyIfOwned({
        hash,
        target: deleteTarget,
        identity: deleteIdentity,
        expectedBodyHash: deleteIdentity.bodyHash,
        before: deleteBefore,
        validateOwnership: authorize,
    })).kind, "applied", "删除中断后同条件重试必须完成");
    assert.equal((await readRecordCommitBodyArtifact(hash, deleteTarget)).body, null);

    const deleteSuccessorConversationId = "conversation-delete-successor";
    const deleteSuccessorRecordId = "record-delete-successor";
    const deleteSuccessorOldBody = "# delete successor old";
    const deleteSuccessorOldIdentity = identity(deleteSuccessorConversationId, deleteSuccessorRecordId, "commit-delete-successor-old", "revision-old", deleteSuccessorOldBody, 1);
    const deleteSuccessorNewBody = "# delete successor B";
    const deleteSuccessorNewIdentity = identity(deleteSuccessorConversationId, deleteSuccessorRecordId, "commit-delete-successor-b", "revision-b", deleteSuccessorNewBody, 2);
    const deleteSuccessorTarget = target("record_body", deleteSuccessorConversationId, deleteSuccessorRecordId);
    const deleteSuccessorBefore = await readRecordCommitBodyArtifact(hash, deleteSuccessorTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: deleteSuccessorTarget,
        identity: deleteSuccessorOldIdentity,
        body: deleteSuccessorOldBody,
        expected: deleteSuccessorBefore,
        validateOwnership: authorize,
    });
    const deleteSuccessorCurrent = await readRecordCommitBodyArtifact(hash, deleteSuccessorTarget);
    await assert.rejects(
        failNextUnlink(`${deleteSuccessorConversationId}.md`, async () => {
            await restoreRecordCommitBodyIfOwned({
                hash,
                target: deleteSuccessorTarget,
                identity: deleteSuccessorOldIdentity,
                expectedBodyHash: deleteSuccessorOldIdentity.bodyHash,
                before: deleteSuccessorBefore,
                validateOwnership: authorize,
            });
        }),
        /injected unlink failure/u,
        "删除 intent 必须能在 identity 已删除、body 未删除时留下可补偿状态",
    );
    assert.equal((await writeRecordCommitBodyConditionally({
        hash,
        target: deleteSuccessorTarget,
        identity: deleteSuccessorNewIdentity,
        body: deleteSuccessorNewBody,
        expected: deleteSuccessorCurrent,
        validateOwnership: authorize,
    })).kind, "applied", "已授权 successor 必须能清理删除 intent 后继续发布");
    assert.equal((await restoreRecordCommitBodyIfOwned({
        hash,
        target: deleteSuccessorTarget,
        identity: deleteSuccessorOldIdentity,
        expectedBodyHash: deleteSuccessorOldIdentity.bodyHash,
        before: deleteSuccessorBefore,
        validateOwnership: async () => false,
    })).kind, "ownership_changed", "旧 delete owner 不得在 successor 发布后恢复 before-image");
    assert.equal((await readRecordCommitBodyArtifact(hash, deleteSuccessorTarget)).body, deleteSuccessorNewBody);

    const restoreConversationId = "conversation-restore-retry";
    const restoreRecordId = "record-restore-retry";
    const restoreOldBody = "# restore old";
    const restoreOldIdentity = identity(restoreConversationId, restoreRecordId, "commit-restore-old", "revision-restore-old", restoreOldBody, 1);
    const restoreNewBody = "# restore new";
    const restoreNewIdentity = identity(restoreConversationId, restoreRecordId, "commit-restore-new", "revision-restore-new", restoreNewBody, 2);
    const restoreTarget = target("record_body", restoreConversationId, restoreRecordId);
    const restoreEmpty = await readRecordCommitBodyArtifact(hash, restoreTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: restoreTarget,
        identity: restoreOldIdentity,
        body: restoreOldBody,
        expected: restoreEmpty,
        validateOwnership: authorize,
    });
    const restoreBefore = await readRecordCommitBodyArtifact(hash, restoreTarget);
    await writeRecordCommitBodyConditionally({
        hash,
        target: restoreTarget,
        identity: restoreNewIdentity,
        body: restoreNewBody,
        expected: restoreBefore,
        validateOwnership: authorize,
    });
    await assert.rejects(
        failNextAtomicRename(`${restoreConversationId}.md`, async () => {
            await restoreRecordCommitBodyIfOwned({
                hash,
                target: restoreTarget,
                identity: restoreNewIdentity,
                expectedBodyHash: restoreNewIdentity.bodyHash,
                before: restoreBefore,
                validateOwnership: authorize,
            });
        }),
        /injected rename failure/u,
        "恢复正文在 identity→body 边界中断时必须保留恢复 intent",
    );
    assert.equal((await readRecordCommitBodyArtifact(hash, restoreTarget)).body, restoreNewBody, "恢复中断后仍必须读取恢复前正文");
    assert.equal((await restoreRecordCommitBodyIfOwned({
        hash,
        target: restoreTarget,
        identity: restoreNewIdentity,
        expectedBodyHash: restoreNewIdentity.bodyHash,
        before: restoreBefore,
        validateOwnership: authorize,
    })).kind, "applied", "恢复中断后同条件重试必须完成");
    const restoreAfter = await readRecordCommitBodyArtifact(hash, restoreTarget);
    assert.equal(restoreAfter.body, restoreOldBody);
    assert.equal(restoreAfter.identity?.bodyHash, restoreOldIdentity.bodyHash);

    const mismatchIdentity = identity(conversationId, recordId, "commit-mismatch", "revision-mismatch", "# stale", 1);
    const mismatch = await writeRecordCommitBodyConditionally({
        hash,
        target: bodyTarget,
        identity: mismatchIdentity,
        body: "# stale",
        expected: before.body,
        validateOwnership: authorize,
    });
    assert.equal(mismatch.kind, "expected_mismatch", "before-image 不匹配时不得覆盖已有正文");
    assert.equal((await readRecordCommitBodyArtifact(hash, bodyTarget)).identity?.commitId, "commit-a");

    const flipConversationId = "conversation-ownership-flip";
    const flipRecordId = "record-ownership-flip";
    const flipBody = "# ownership flip";
    const flipIdentity = identity(flipConversationId, flipRecordId, "commit-flip", "revision-flip", flipBody, 1);
    const flipTarget = target("record_body", flipConversationId, flipRecordId);
    const flipBefore = await readRecordCommitBodyArtifact(hash, flipTarget);
    const phases: string[] = [];
    const flip = await writeRecordCommitBodyConditionally({
        hash,
        target: flipTarget,
        identity: flipIdentity,
        body: flipBody,
        expected: flipBefore,
        validateOwnership: async input => {
            phases.push(input.phase);
            return input.phase === "before_write";
        },
    });
    assert.equal(flip.kind, "ownership_changed", "ownership 在写后翻转时必须拒绝阶段确认");
    assert.deepEqual(phases, ["before_write", "after_write"], "条件写必须在真实锁内写前和写后都复核 ownership");
    assert.equal((await readRecordCommitBodyArtifact(hash, flipTarget)).identity?.commitId, "commit-flip");

    const inconsistentConversationId = "conversation-reader-mismatch";
    const inconsistentRecordId = "record-reader-mismatch";
    const inconsistentBody = "# actual body";
    const inconsistentIdentity = identity(inconsistentConversationId, inconsistentRecordId, "commit-reader", "revision-reader", inconsistentBody, 1);
    const inconsistentBodyTarget = target("record_body", inconsistentConversationId, inconsistentRecordId);
    const inconsistentMainTarget = target("main_index", inconsistentConversationId, inconsistentRecordId);
    const inconsistentReaderTarget = target("reader_index", inconsistentConversationId, inconsistentRecordId);
    const inconsistentBefore = {
        body: await readRecordCommitBodyArtifact(hash, inconsistentBodyTarget),
        main: await readRecordCommitMainIndexArtifact(hash, inconsistentMainTarget),
        reader: await readRecordCommitReaderIndexArtifact(hash, inconsistentReaderTarget),
    };
    await publishTrio(hash, inconsistentIdentity, inconsistentBody, inconsistentBefore);
    const invalidReaderIdentity = { ...inconsistentIdentity, bodyHash: bodyHash("# another body") };
    await assert.rejects(
        writeRecordCommitReaderIndexConditionally({
            hash,
            target: inconsistentReaderTarget,
            identity: invalidReaderIdentity,
            index: readerEntry(invalidReaderIdentity),
            expected: await readRecordCommitReaderIndexArtifact(hash, inconsistentReaderTarget),
            validateOwnership: authorize,
        }),
        /正文 identity\/bodyHash 不匹配/u,
        "Reader Index 绝不能绑定与当前正文不同的 bodyHash",
    );

    const invalidPath = { ...bodyTarget, relativePath: "../outside.md" };
    assert.equal(validateRecordCommitArtifactTarget(hash, invalidPath, "record_body"), false, "越出 Record 根的 target 必须被拒绝");
    await assert.rejects(
        writeRecordCommitBodyConditionally({
            hash,
            target: invalidPath,
            identity: first,
            body,
            expected: before.body,
            validateOwnership: authorize,
        }),
        /规范 Record 根/u,
    );

    const cleanupConversationId = "conversation-cleanup";
    const cleanupRecordId = "record-cleanup";
    const cleanupBodyA = "# old commit";
    const cleanupA = identity(cleanupConversationId, cleanupRecordId, "commit-cleanup-a", "revision-a", cleanupBodyA, 1);
    const cleanupBodyTarget = target("record_body", cleanupConversationId, cleanupRecordId);
    const cleanupMainTarget = target("main_index", cleanupConversationId, cleanupRecordId);
    const cleanupReaderTarget = target("reader_index", cleanupConversationId, cleanupRecordId);
    const cleanupBefore = {
        body: await readRecordCommitBodyArtifact(hash, cleanupBodyTarget),
        main: await readRecordCommitMainIndexArtifact(hash, cleanupMainTarget),
        reader: await readRecordCommitReaderIndexArtifact(hash, cleanupReaderTarget),
    };
    await publishTrio(hash, cleanupA, cleanupBodyA, cleanupBefore);
    const cleanupAAfter = {
        body: await readRecordCommitBodyArtifact(hash, cleanupBodyTarget),
        main: await readRecordCommitMainIndexArtifact(hash, cleanupMainTarget),
        reader: await readRecordCommitReaderIndexArtifact(hash, cleanupReaderTarget),
    };
    const cleanupBodyB = "# newer commit";
    const cleanupB = identity(cleanupConversationId, cleanupRecordId, "commit-cleanup-b", "revision-b", cleanupBodyB, 2);
    await publishTrio(hash, cleanupB, cleanupBodyB, cleanupAAfter);
    const oldBodyCleanup = await restoreRecordCommitBodyIfOwned({
        hash,
        target: cleanupBodyTarget,
        identity: cleanupA,
        expectedBodyHash: cleanupA.bodyHash,
        before: cleanupBefore.body,
        validateOwnership: authorize,
    });
    const oldMainCleanup = await restoreRecordCommitMainIndexIfOwned({
        hash,
        target: cleanupMainTarget,
        identity: cleanupA,
        expectedEntryHash: calculateRecordCommitArtifactJsonHash(mainEntry(cleanupA)),
        before: cleanupBefore.main,
        validateOwnership: authorize,
    });
    const oldReaderCleanup = await rebuildRecordCommitReaderIndexFromBody({
        hash,
        identity: cleanupA,
        bodyTarget: cleanupBodyTarget,
        mainIndexTarget: cleanupMainTarget,
        readerIndexTarget: cleanupReaderTarget,
        expectedBody: cleanupBefore.body,
        expectedMainIndex: cleanupBefore.main,
        expectedReaderIndex: cleanupBefore.reader,
        validateOwnership: authorize,
    });
    assert.deepEqual(
        [oldBodyCleanup.kind, oldMainCleanup.kind, oldReaderCleanup.kind],
        ["ownership_changed", "ownership_changed", "ownership_changed"],
        "旧 commit cleanup 不得覆盖更高 epoch 的新三件套",
    );
    assert.equal((await readRecordCommitBodyArtifact(hash, cleanupBodyTarget)).identity?.commitId, cleanupB.commitId);
    assert.equal((await readRecordCommitMainIndexArtifact(hash, cleanupMainTarget)).identity?.commitId, cleanupB.commitId);
    assert.equal((await readRecordCommitReaderIndexArtifact(hash, cleanupReaderTarget)).identity?.commitId, cleanupB.commitId);

    const restoredConversationId = "conversation-cleanup-success";
    const restoredRecordId = "record-cleanup-success";
    const restoredBody = "# restore me";
    const restoredIdentity = identity(restoredConversationId, restoredRecordId, "commit-cleanup-success", "revision-success", restoredBody, 1);
    const restoredBodyTarget = target("record_body", restoredConversationId, restoredRecordId);
    const restoredMainTarget = target("main_index", restoredConversationId, restoredRecordId);
    const restoredReaderTarget = target("reader_index", restoredConversationId, restoredRecordId);
    const restoredBefore = {
        body: await readRecordCommitBodyArtifact(hash, restoredBodyTarget),
        main: await readRecordCommitMainIndexArtifact(hash, restoredMainTarget),
        reader: await readRecordCommitReaderIndexArtifact(hash, restoredReaderTarget),
    };
    await publishTrio(hash, restoredIdentity, restoredBody, restoredBefore);
    const restoredBodyAfter = await readRecordCommitBodyArtifact(hash, restoredBodyTarget);
    const restoredMainAfter = await readRecordCommitMainIndexArtifact(hash, restoredMainTarget);
    const restoredReaderAfter = await readRecordCommitReaderIndexArtifact(hash, restoredReaderTarget);
    assert.equal((await restoreRecordCommitBodyIfOwned({
        hash,
        target: restoredBodyTarget,
        identity: restoredIdentity,
        expectedBodyHash: restoredIdentity.bodyHash,
        before: restoredBefore.body,
        validateOwnership: authorize,
    })).kind, "applied");
    assert.equal((await restoreRecordCommitMainIndexIfOwned({
        hash,
        target: restoredMainTarget,
        identity: restoredIdentity,
        expectedEntryHash: restoredMainAfter.hash!,
        before: restoredBefore.main,
        validateOwnership: authorize,
    })).kind, "applied");
    assert.equal((await rebuildRecordCommitReaderIndexFromBody({
        hash,
        identity: restoredIdentity,
        bodyTarget: restoredBodyTarget,
        mainIndexTarget: restoredMainTarget,
        readerIndexTarget: restoredReaderTarget,
        expectedBody: restoredBefore.body,
        expectedMainIndex: restoredBefore.main,
        expectedReaderIndex: restoredBefore.reader,
        validateOwnership: authorize,
    })).kind, "applied");
    assert.equal(restoredBodyAfter.ownerCommitId, restoredIdentity.commitId);
    assert.equal(restoredReaderAfter.ownerCommitId, restoredIdentity.commitId);
    assert.equal((await readRecordCommitBodyArtifact(hash, restoredBodyTarget)).body, null, "cleanup 应在仍属旧 commit 时恢复正文 before-image");
    assert.equal((await readRecordCommitMainIndexArtifact(hash, restoredMainTarget)).value, null, "cleanup 应在仍属旧 commit 时删除新增主索引条目");
    assert.equal((await readRecordCommitReaderIndexArtifact(hash, restoredReaderTarget)).value, null, "cleanup 应基于恢复后的空正文删除 Reader Index");

    console.log("✅ record-commit-artifact-io 通过：三件套条件 IO、幂等、ownership 双检、epoch cleanup、Reader/bodyHash、路径约束正常");
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}

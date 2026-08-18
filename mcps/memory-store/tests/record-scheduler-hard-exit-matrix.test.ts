import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workerPath = path.resolve("tests/fixtures/record-scheduler-hard-exit-worker.mjs");
const fakeProviderPath = path.resolve("tests/fixtures/record-scheduler-hard-exit-fake-provider.mjs");
const productionPumpPath = path.resolve("src/record-scheduler-production-pump.ts");
const productionCommitPath = path.resolve("src/record-commit-protocol.ts");
const workerTimeoutMs = 30_000;
const gracefulStopMs = 2_000;
const forcedStopMs = 5_000;

const schedulerProductionCases = [
    { name: "claim-persisted", phase: "grant-persisted", exitCode: 201, initialPostCount: 0, finalPostCount: 1, state: "DispatchIntentPersisted", dispatchPhase: null, leaseKind: "active", outputBound: false, recovery: "pre-rpc" },
    { name: "attempt-bound", phase: "attempt-bound", exitCode: 202, initialPostCount: 0, finalPostCount: 1, state: "Dispatched", dispatchPhase: "attempt-bound", leaseKind: "active", outputBound: false, recovery: "pre-rpc" },
    { name: "before-invoke", phase: "before-invoke", exitCode: 203, initialPostCount: 0, finalPostCount: 1, state: "Dispatched", dispatchPhase: "invoking", leaseKind: "active", outputBound: false, recovery: "unknown-retry" },
    { name: "provider-result-received", phase: "provider-result-received", exitCode: 204, initialPostCount: 1, finalPostCount: 2, state: "Dispatched", dispatchPhase: "invoking", leaseKind: "absent", outputBound: false, recovery: "unknown-retry" },
    { name: "output-spool-persisted", phase: "output-spool-persisted", exitCode: 205, initialPostCount: 1, finalPostCount: 2, state: "Dispatched", dispatchPhase: "invoking", leaseKind: "absent", outputBound: false, recovery: "unknown-retry" },
    { name: "known-success", phase: "known-success", exitCode: 206, initialPostCount: 1, finalPostCount: 1, state: "KnownSuccess", dispatchPhase: "invoking", leaseKind: "absent", outputBound: true, recovery: "known-success" },
    { name: "uncertain-provider-outcome", phase: "unknown-outcome", exitCode: 207, initialPostCount: 1, finalPostCount: 2, state: "UnknownOutcome", dispatchPhase: "invoking", leaseKind: "uncertain", outputBound: false, recovery: "unknown-retry", providerBehavior: "drop-first" },
] as const;

const commitStages = ["BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified"] as const;
const commitPersistencePoints = ["before_intent_persist", "after_intent_persist", "before_stage_confirm", "after_stage_confirm"] as const;
const adapterCommitPoints = ["before_write", "after_write"] as const;
const commitPredecessors = ["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten"] as const;

type WorkerResult = {
    code: number | null;
    stdout: string;
    stderr: string;
};

type ManagedProcess = {
    child: ChildProcess;
    dataRoot: string;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    error: Promise<Error>;
    isClosed: () => boolean;
};

type AdapterCommitRecoverySummary = {
    commit: { stage: string; coveredRevision: string };
    body: { ownerCommitId: string | null; content: string | null };
    mainIndex: { commitId: string; coveredRevision: string; conversationId: string; recordId: string } | null;
    readerIndex: { commitId: string; bodyHash: string; coveredRevision: string; conversationId: string; recordId: string } | null;
    syntheticReceipt: { receiptCount: number; idempotencyKeys: string[] };
    outputDisposition?: "published" | "existing";
};

type DurableAttempt = {
    attemptId: string;
    provider: string;
    managedByProductionPump: boolean;
    state: string;
    dispatchPhase: string | null;
    outcome: string | null;
    errorClass: string | null;
    providerEvidence: string | null;
    idempotencyKey: string | null;
    unknownOutcomeAt: string | null;
    outputRef: { path: string; hash: string; byteLength: number } | null;
    output: {
        kind: "current" | "missing" | "corrupt";
        computedHash?: string;
        byteLength?: number;
        providerResultText?: string | null;
        error?: string;
    } | null;
    providerLease: { kind: "active" | "absent" | "uncertain" | "corrupt"; detail?: string } | null;
    fence: { schedulerEpoch: number; recordCommitEpoch: number; fencingToken: number } | null;
};

type DurableCommit = {
    commitId: string;
    state: string;
    protocol: {
        revision: number;
        stage: string;
        intentTarget: string | null;
        confirmedStages: string[];
        bodyHash: string;
    } | null;
    publishedBody: { ownerCommitId: string | null; content: string | null } | null;
};

type DurableProductionState = {
    taskId: string;
    ledgerRevision: number;
    task: { state: string; repairState: string };
    admission: { kind: string; resumePayloadPresent: boolean; descriptorPresent: boolean };
    attempts: DurableAttempt[];
    commits: DurableCommit[];
};

type ProductionRecoverySummary = {
    execution: {
        providerResultText: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        callbackExecuted: boolean;
    };
    durable: DurableProductionState;
};

type FakeProviderPost = {
    sequence: number;
    attemptId: string;
    idempotencyKey: string;
    requestIdentity: string;
    requestBodyHash: string;
    response: { text: string; chainUsed: string; modelUsed: string } | null;
    responseText: string | null;
    outcome: "responded" | "connection-dropped";
};

type FakeProviderLog = {
    posts: FakeProviderPost[];
    duplicateRequests: Array<{ attemptId: string; idempotencyKey: string }>;
    keyConflicts: Array<{ attemptId: string; idempotencyKey: string; existingAttemptId: string }>;
};

const activeProcesses = new Set<ManagedProcess>();

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<{ settled: true; value: T } | { settled: false }> {
    return await Promise.race([
        promise.then(value => ({ settled: true as const, value })),
        delay(milliseconds).then(() => ({ settled: false as const })),
    ]);
}

function manageProcess(child: ChildProcess, dataRoot: string): ManagedProcess {
    let closed = false;
    let resolveClosed!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let resolveError!: (error: Error) => void;
    const managed: ManagedProcess = {
        child,
        dataRoot,
        closed: new Promise(resolve => { resolveClosed = resolve; }),
        error: new Promise(resolve => { resolveError = resolve; }),
        isClosed: () => closed,
    };
    activeProcesses.add(managed);
    child.once("close", (code, signal) => {
        if (closed) return;
        closed = true;
        activeProcesses.delete(managed);
        resolveClosed({ code, signal });
    });
    child.once("error", error => {
        resolveError(error);
        if (child.pid === undefined && !closed) {
            closed = true;
            activeProcesses.delete(managed);
            resolveClosed({ code: null, signal: null });
        }
    });
    return managed;
}

async function terminateManagedProcess(managed: ManagedProcess): Promise<void> {
    if (managed.isClosed()) {
        await managed.closed;
        return;
    }
    try {
        managed.child.kill("SIGTERM");
    } catch {
    }
    const graceful = await settlesWithin(managed.closed, gracefulStopMs);
    if (graceful.settled) return;
    try {
        managed.child.kill("SIGKILL");
    } catch {
    }
    const forced = await settlesWithin(managed.closed, forcedStopMs);
    if (!forced.settled) throw new Error(`child pid=${managed.child.pid ?? "unspawned"} did not close after SIGKILL`);
}

async function terminateDataRootProcesses(dataRoot: string): Promise<void> {
    const children = [...activeProcesses].filter(managed => managed.dataRoot === dataRoot);
    await Promise.all(children.map(terminateManagedProcess));
}

async function runWorker(action: string, dataRoot: string, config: Record<string, unknown> = {}): Promise<WorkerResult> {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, action, dataRoot, JSON.stringify(config)], {
        cwd: process.cwd(),
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: dataRoot },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const managed = manageProcess(child, dataRoot);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    const workerContext = `action=${action}; config=${JSON.stringify(config)}`;
    const outcome = await Promise.race([
        managed.closed.then(value => ({ kind: "closed" as const, value })),
        managed.error.then(error => ({ kind: "error" as const, error })),
        delay(workerTimeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "error") {
        await terminateManagedProcess(managed);
        throw new Error(`worker process error; ${workerContext}; ${outcome.error.message}`);
    }
    if (outcome.kind === "timeout") {
        await terminateManagedProcess(managed);
        throw new Error(`worker timed out after ${workerTimeoutMs}ms; ${workerContext}\nstdout=${stdout}\nstderr=${stderr}`);
    }
    return { code: outcome.value.code, stdout, stderr };
}

function parseJsonWorker<T>(result: WorkerResult, label: string): T {
    assert.equal(result.code, 0, `${label} child should exit normally: ${result.stderr}`);
    return JSON.parse(result.stdout.trim()) as T;
}

function readFakeProviderLog(dataRoot: string): FakeProviderLog {
    const logPath = path.join(dataRoot, "record-scheduler-hard-exit-provider-posts.json");
    if (!fs.existsSync(logPath)) return { posts: [], duplicateRequests: [], keyConflicts: [] };
    return JSON.parse(fs.readFileSync(logPath, "utf8")) as FakeProviderLog;
}

async function startFakeProvider(dataRoot: string): Promise<{ url: string; stop: () => Promise<void> }> {
    const child = spawn(process.execPath, [fakeProviderPath, dataRoot], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    const managed = manageProcess(child, dataRoot);
    let stdout = "";
    let stderr = "";
    let resolveReady!: (url: string) => void;
    const ready = new Promise<string>(resolve => { resolveReady = resolve; });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => {
        stdout += String(chunk);
        for (const line of stdout.split(/\r?\n/u)) {
            try {
                const message = JSON.parse(line) as { type?: string; url?: string };
                if (message.type === "ready" && typeof message.url === "string") resolveReady(message.url);
            } catch {
            }
        }
    });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    try {
        const outcome = await Promise.race([
            ready.then(url => ({ kind: "ready" as const, url })),
            managed.error.then(error => ({ kind: "error" as const, error })),
            managed.closed.then(value => ({ kind: "closed" as const, value })),
            delay(workerTimeoutMs).then(() => ({ kind: "timeout" as const })),
        ]);
        if (outcome.kind !== "ready") {
            const detail = outcome.kind === "error"
                ? outcome.error.message
                : outcome.kind === "closed"
                    ? `code=${outcome.value.code}; signal=${outcome.value.signal}`
                    : `timeout=${workerTimeoutMs}ms`;
            throw new Error(`fake provider did not become ready: ${detail}\nstdout=${stdout}\nstderr=${stderr}`);
        }
        let stopOperation: Promise<void> | null = null;
        return {
            url: outcome.url,
            stop: async () => {
                stopOperation ||= terminateManagedProcess(managed);
                await stopOperation;
            },
        };
    } catch (error) {
        await terminateManagedProcess(managed);
        throw error;
    }
}

async function withTempDataRoot(run: (dataRoot: string) => Promise<void>): Promise<void> {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-scheduler-hard-exit-"));
    try {
        await run(dataRoot);
    } finally {
        await terminateDataRootProcesses(dataRoot);
        if (process.env.RECORD_SCHEDULER_HARD_EXIT_KEEP_TEMP === "1") {
            console.error(`record scheduler hard-exit temp preserved: ${dataRoot}`);
        } else {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    }
}

function assertAdapterVerifiedRecovery(summary: AdapterCommitRecoverySummary): void {
    assert.deepEqual(summary.commit, { stage: "Verified", coveredRevision: "revision-1" });
    assert.equal(summary.body.ownerCommitId, "commit-hard-exit-matrix");
    assert.match(summary.body.content || "", /immutable output spool/u);
    assert.deepEqual(summary.mainIndex, {
        commitId: "commit-hard-exit-matrix",
        coveredRevision: "revision-1",
        conversationId: "conversation-hard-exit-matrix",
        recordId: "conversation-hard-exit-matrix",
    });
    assert.equal(summary.readerIndex?.commitId, "commit-hard-exit-matrix");
    assert.equal(summary.readerIndex?.coveredRevision, "revision-1");
    assert.equal(summary.syntheticReceipt.receiptCount, 1, "adapter 子矩阵只验证一份持久 synthetic receipt，不将其称作网络 POST");
    assert.deepEqual(summary.syntheticReceipt.idempotencyKeys, ["record-attempt:task-hard-exit-matrix-attempt:record-commit-epoch:1"]);
}

function requireProductionHardExitHooks(): void {
    const pumpText = fs.readFileSync(productionPumpPath, "utf8");
    const missingPumpPhases = schedulerProductionCases
        .map(current => current.phase)
        .filter(phase => !pumpText.includes(`\"${phase}\"`));
    assert.deepEqual(missingPumpPhases, [], `生产 scheduler hard-exit 所需 onPhase hook 缺失: ${missingPumpPhases.join(", ")}`);
    const commitText = fs.readFileSync(productionCommitPath, "utf8");
    assert.match(commitText, /onPersistenceFaultPoint/u, "生产 finalizeLocalRecord 缺少真实 protocol persistence hook");
    for (const point of commitPersistencePoints) {
        assert.ok(commitText.includes(`\"${point}\"`), `生产 commit protocol 缺少 ${point}，矩阵不得降级为空写 hook`);
    }
}

function assertProviderLog(log: FakeProviderLog): void {
    assert.deepEqual(log.duplicateRequests, [], `同一 attempt/idempotency key 不得形成第二次网络请求: ${JSON.stringify(log.duplicateRequests)}`);
    assert.deepEqual(log.keyConflicts, [], `idempotency key 不得跨 Attempt 复用: ${JSON.stringify(log.keyConflicts)}`);
    const pairs = log.posts.map(post => `${post.attemptId}\u0000${post.idempotencyKey}`);
    assert.equal(new Set(pairs).size, pairs.length, "持久 HTTP provider 日志中同一 attempt/key 最多一条 POST");
}

function providerAttempts(state: DurableProductionState): DurableAttempt[] {
    return state.attempts.filter(attempt => attempt.managedByProductionPump && attempt.provider === "grok");
}

function assertKnownSuccessEvidence(state: DurableProductionState, providerLog: FakeProviderLog, attemptId?: string): DurableAttempt {
    const attempt = attemptId
        ? state.attempts.find(candidate => candidate.attemptId === attemptId)
        : providerAttempts(state).findLast(candidate => candidate.state === "KnownSuccess");
    assert.ok(attempt, `缺少持久 KnownSuccess Attempt: ${JSON.stringify(state.attempts)}`);
    assert.equal(attempt.state, "KnownSuccess");
    assert.ok(attempt.outputRef, "KnownSuccess Attempt 必须带持久 outputRef");
    assert.equal(attempt.output?.kind, "current", "outputRef 必须能从 immutable spool 回读");
    assert.equal(attempt.output?.computedHash, attempt.outputRef?.hash, "spool 实际 hash 必须等于 Attempt outputRef.hash");
    assert.equal(attempt.output?.byteLength, attempt.outputRef?.byteLength, "spool 实际长度必须等于 Attempt outputRef.byteLength");
    const post = providerLog.posts.find(candidate => candidate.attemptId === attempt.attemptId);
    assert.ok(post?.response, `HTTP provider 日志缺少 Attempt ${attempt.attemptId} 的响应`);
    assert.equal(attempt.output?.providerResultText, post.response.text, "spool 回放文本必须精确等于 HTTP 响应 text");
    assert.equal(JSON.parse(post.responseText || "null")?.text, post.response.text, "持久 HTTP response body 必须能精确回读 text");
    return attempt;
}

function assertSchedulerCrashState(
    state: DurableProductionState,
    current: typeof schedulerProductionCases[number],
    providerLog: FakeProviderLog,
): DurableAttempt {
    assert.ok(Number.isSafeInteger(state.ledgerRevision) && state.ledgerRevision > 0, `${current.name} 必须读到真实 scheduler ledger revision`);
    assert.equal(state.admission.kind, "current", `${current.name} admission capsule 必须可读`);
    assert.equal(state.admission.resumePayloadPresent, true, `${current.name} 必须持久化 resume payload`);
    assert.equal(state.admission.descriptorPresent, true, `${current.name} 必须持久化 execution descriptor`);
    assert.equal(state.task.repairState, "None", `${current.name} crash 前不得提前 RepairRequired`);
    const attempt = providerAttempts(state).at(-1);
    assert.ok(attempt, `${current.name} crash 前必须存在 production-pump Attempt`);
    assert.equal(attempt.state, current.state, `${current.name} crash 前 Attempt state 不正确`);
    assert.equal(attempt.dispatchPhase, current.dispatchPhase, `${current.name} crash 前 dispatchPhase 不正确`);
    assert.equal(attempt.providerLease?.kind, current.leaseKind, `${current.name} crash 前 provider-control lease 状态不正确`);
    assert.equal(attempt.outputRef !== null, current.outputBound, `${current.name} crash 前 outputRef binding 不正确`);
    if (current.outputBound) assertKnownSuccessEvidence(state, providerLog, attempt.attemptId);
    return attempt;
}

function assertControlledRetry(before: DurableAttempt, after: DurableProductionState, mode: "pre-rpc" | "unknown-retry"): void {
    const attempts = providerAttempts(after);
    const original = attempts.find(attempt => attempt.attemptId === before.attemptId);
    assert.ok(original, "恢复后必须保留原 Attempt 的持久证据");
    if (mode === "pre-rpc" && before.state === "DispatchIntentPersisted") {
        assert.equal(original.state, "KnownSuccess", `RPC 前崩溃应继续原 Attempt，而不是创建第二个 provider identity: ${JSON.stringify(attempts)}`);
        assert.equal(original.unknownOutcomeAt, null, "可证明 RPC 前崩溃不得误记 UnknownOutcome");
        assert.equal(attempts.length, 1, `RPC 前恢复不得创建多余 provider Attempt: ${JSON.stringify(attempts)}`);
        return;
    }
    const successor = attempts.find(attempt => attempt.attemptId !== before.attemptId && attempt.state === "KnownSuccess");
    assert.ok(successor, `恢复后的受控调用必须创建新 Attempt 并 KnownSuccess: ${JSON.stringify(attempts)}`);
    assert.notEqual(successor.idempotencyKey, original.idempotencyKey, "新 Attempt 必须使用新 idempotencyKey");
    if (mode === "pre-rpc") {
        assert.equal(original.state, "KnownFailure", `已绑定但未 RPC 的旧 Attempt 必须保留为已知失败证据: ${JSON.stringify(original)}`);
        assert.equal(original.errorClass, "Persistence");
        assert.equal(original.unknownOutcomeAt, null, "可证明 RPC 前崩溃不得误记 UnknownOutcome");
        return;
    }
    assert.ok(original.unknownOutcomeAt, "无法证明未调用的旧 Attempt 必须先持久化 UnknownOutcome 时间证据");
    assert.ok(original.state === "UnknownOutcome" || original.state === "Discarded", `旧 Attempt 不得被改写成成功: ${original.state}`);
    assert.notEqual(successor.fence?.fencingToken, original.fence?.fencingToken, "UnknownOutcome 后的新 Attempt 必须推进 fencing token");
}

function assertCommitCrashState(
    state: DurableProductionState,
    stage: typeof commitStages[number],
    point: typeof commitPersistencePoints[number],
): DurableCommit {
    const ordinal = commitStages.indexOf(stage);
    const predecessor = commitPredecessors[ordinal];
    const predecessorRevision = 1 + ordinal * 2;
    const commit = state.commits.at(-1);
    assert.ok(commit?.protocol, `${stage}/${point} crash 前必须有真实 protocol ledger`);
    if (point === "before_intent_persist") {
        assert.equal(commit.protocol.revision, predecessorRevision);
        assert.equal(commit.protocol.stage, predecessor);
        assert.equal(commit.protocol.intentTarget, null);
    } else if (point === "after_intent_persist" || point === "before_stage_confirm") {
        assert.equal(commit.protocol.revision, predecessorRevision + 1);
        assert.equal(commit.protocol.stage, predecessor);
        assert.equal(commit.protocol.intentTarget, stage);
    } else {
        assert.equal(commit.protocol.revision, predecessorRevision + 2);
        assert.equal(commit.protocol.stage, stage);
        assert.equal(commit.protocol.intentTarget, null);
    }
    return commit;
}

function assertCommitDependsOnProviderReplay(state: DurableProductionState, providerLog: FakeProviderLog): void {
    const providerAttempt = assertKnownSuccessEvidence(state, providerLog);
    const commit = state.commits.at(-1);
    assert.ok(commit?.protocol, "Verified commit 必须保留 protocol ledger");
    assert.equal(commit.protocol.stage, "Verified");
    const localAttempt = state.attempts.find(attempt => attempt.provider === "local" && attempt.outputRef?.hash === commit.protocol?.bodyHash);
    assert.ok(localAttempt?.outputRef, "commit bodyHash 必须绑定 production finalizeLocalRecord 的本地 outputRef");
    assert.equal(localAttempt.output?.computedHash, commit.protocol.bodyHash, "commit bodyHash 必须等于本地 spool 实际 hash");
    const content = commit.publishedBody?.content;
    assert.equal(typeof content, "string", "Verified commit 必须能回读正文");
    assert.ok(content.includes(providerAttempt.output?.providerResultText || "<missing-provider-text>"), "commit 正文必须包含从 provider output spool 回放的 HTTP response text");
    assert.ok(content.includes(`provider-output-ref:${providerAttempt.outputRef.hash}:${providerAttempt.outputRef.byteLength}`), "commit 正文必须绑定 provider outputRef hash/length");
}

async function testProductionSchedulerHardExitMatrix(): Promise<void> {
    requireProductionHardExitHooks();
    for (const current of schedulerProductionCases) {
        await withTempDataRoot(async dataRoot => {
            const provider = await startFakeProvider(dataRoot);
            try {
                const crashed = await runWorker("crash-production-scheduler", dataRoot, {
                    providerUrl: provider.url,
                    requestIdentity: `scheduler-${current.name}`,
                    providerBehavior: current.providerBehavior,
                    crash: { phase: current.phase, exitCode: current.exitCode },
                });
                assert.equal(crashed.code, current.exitCode, `${current.name} 必须由 child1 process.exit(${current.exitCode}) 中断: ${crashed.stderr}`);
                const beforeLog = readFakeProviderLog(dataRoot);
                assertProviderLog(beforeLog);
                assert.equal(beforeLog.posts.length, current.initialPostCount, `${current.name} crash 前 HTTP POST 数不正确`);
                const before = parseJsonWorker<DurableProductionState>(
                    await runWorker("inspect-production-state", dataRoot),
                    `${current.name} pre-recovery inspection`,
                );
                const crashedAttempt = assertSchedulerCrashState(before, current, beforeLog);
                const recovered = parseJsonWorker<ProductionRecoverySummary>(
                    await runWorker("recover-production", dataRoot, { providerUrl: provider.url }),
                    `${current.name} recovery`,
                );
                assert.equal(
                    recovered.execution.errorCode,
                    null,
                    `${current.name} recovery failed: ${recovered.execution.errorMessage}; durable=${JSON.stringify(recovered.durable)}`,
                );
                const providerLog = readFakeProviderLog(dataRoot);
                assertProviderLog(providerLog);
                assert.equal(providerLog.posts.length, current.finalPostCount, `${current.name} 恢复后的 HTTP POST 数不正确`);
                if (current.recovery === "known-success") {
                    const replayed = assertKnownSuccessEvidence(recovered.durable, providerLog, crashedAttempt.attemptId);
                    assert.equal(providerAttempts(recovered.durable).length, providerAttempts(before).length, `${current.name} 不得创建新的 provider Attempt`);
                    assert.equal(recovered.execution.providerResultText, replayed.output?.providerResultText, `${current.name} recovery 必须返回 spool 中的 HTTP response text`);
                } else {
                    assertControlledRetry(crashedAttempt, recovered.durable, current.recovery);
                    const successful = assertKnownSuccessEvidence(recovered.durable, providerLog);
                    assert.equal(recovered.execution.providerResultText, successful.output?.providerResultText, `${current.name} recovery result 必须来自新 Attempt 的持久 output`);
                }
            } finally {
                await provider.stop();
            }
        });
    }
    console.log("ok - production scheduler hard exits prove ledger, provider-control, HTTP, and spool recovery evidence");
}

async function testProductionCommitPersistenceMatrix(): Promise<void> {
    let exitCode = 240;
    for (const stage of commitStages) {
        for (const point of commitPersistencePoints) {
            await withTempDataRoot(async dataRoot => {
                const provider = await startFakeProvider(dataRoot);
                try {
                    const crashCode = exitCode;
                    exitCode += 1;
                    const crashed = await runWorker("crash-production-commit", dataRoot, {
                        providerUrl: provider.url,
                        requestIdentity: `commit-${stage}-${point}`,
                        crash: { stage, persistencePoint: point, exitCode: crashCode },
                    });
                    assert.equal(crashed.code, crashCode, `${stage}/${point} 必须在 production session finalizeLocalRecord 中硬退出: ${crashed.stderr}`);
                    const beforeLog = readFakeProviderLog(dataRoot);
                    assertProviderLog(beforeLog);
                    assert.equal(beforeLog.posts.length, 1, `${stage}/${point} commit 前必须只有一次 HTTP POST`);
                    const before = parseJsonWorker<DurableProductionState>(
                        await runWorker("inspect-production-state", dataRoot),
                        `${stage}/${point} pre-recovery inspection`,
                    );
                    assertCommitCrashState(before, stage, point);
                    assertKnownSuccessEvidence(before, beforeLog);
                    const recovered = parseJsonWorker<ProductionRecoverySummary>(
                        await runWorker("recover-production", dataRoot, { providerUrl: provider.url }),
                        `${stage}/${point} recovery`,
                    );
                    assert.equal(
                        recovered.execution.errorCode,
                        null,
                        `${stage}/${point} recovery failed: ${recovered.execution.errorMessage}; durable=${JSON.stringify(recovered.durable)}`,
                    );
                    const providerLog = readFakeProviderLog(dataRoot);
                    assertProviderLog(providerLog);
                    assert.equal(providerLog.posts.length, 1, `${stage}/${point} commit 恢复不得再次 POST provider`);
                    assertCommitDependsOnProviderReplay(recovered.durable, providerLog);
                } finally {
                    await provider.stop();
                }
            });
        }
    }
    console.log("ok - production finalizeLocalRecord survives exact intent-persist/stage-confirm hard exits");
}

async function testProductionRecoveryRepairMatrix(): Promise<void> {
    const cases = ["descriptor-missing", "descriptor-tampered", "identity", "source-hash", "provider-control"] as const;
    for (const tamper of cases) {
        await withTempDataRoot(async dataRoot => {
            const provider = await startFakeProvider(dataRoot);
            try {
                const exitCode = 300 + cases.indexOf(tamper);
                const crashed = await runWorker("crash-production-scheduler", dataRoot, {
                    providerUrl: provider.url,
                    requestIdentity: `repair-${tamper}`,
                    crash: { phase: "attempt-bound", exitCode },
                });
                assert.equal(crashed.code, exitCode, `${tamper} fixture must first leave a persisted pre-RPC Attempt`);
                const tampered = await runWorker("tamper-production-state", dataRoot, { tamper });
                assert.equal(tampered.code, 0, `${tamper} durable tamper child failed: ${tampered.stderr}`);
                const repaired = parseJsonWorker<ProductionRecoverySummary>(
                    await runWorker("recover-production", dataRoot, { providerUrl: provider.url }),
                    `${tamper} repair recovery`,
                );
                const providerLog = readFakeProviderLog(dataRoot);
                assert.equal(
                    repaired.durable.task.repairState,
                    "Required",
                    `${tamper} must become RepairRequired rather than resend provider work; execution=${JSON.stringify(repaired.execution)}; durable=${JSON.stringify(repaired.durable)}; providerLog=${JSON.stringify(providerLog)}`,
                );
                assert.ok(repaired.execution.errorCode || repaired.execution.errorMessage, `${tamper} 必须留下明确 fail-closed 错误证据`);
                assert.equal(providerLog.posts.length, 0, `${tamper} corruption must fail closed before HTTP POST`);
                if (tamper === "provider-control") {
                    assert.ok(providerAttempts(repaired.durable).some(attempt => attempt.providerLease?.kind === "corrupt"), "provider-control 损坏必须经真实 recovery API 读为 corrupt");
                }
                if (tamper === "descriptor-missing" || tamper === "descriptor-tampered") {
                    assert.equal(repaired.execution.callbackExecuted, false, `${tamper} 必须在执行 callback/provider 前 fail closed`);
                }
            } finally {
                await provider.stop();
            }
        });
    }
    console.log("ok - descriptor, identity, source hash, and provider-control corruption fail closed");
}

async function testOutputSpoolAdapterHardExitMatrix(): Promise<void> {
    const cases = [
        { point: "before-blob-link", exitCode: 81, expectedDisposition: "published" },
        { point: "after-blob-link", exitCode: 82, expectedDisposition: "existing" },
    ] as const;
    for (const current of cases) {
        await withTempDataRoot(async dataRoot => {
            const crashed = await runWorker("crash-output-spool", dataRoot, { outputFault: current });
            assert.equal(crashed.code, current.exitCode, `${current.point} 应由子进程 process.exit(${current.exitCode}) 中断: ${crashed.stderr}`);
            const recovered = parseJsonWorker<AdapterCommitRecoverySummary>(await runWorker("recover-output-spool", dataRoot), "adapter output-spool recovery");
            assertAdapterVerifiedRecovery(recovered);
            assert.equal(recovered.outputDisposition, current.expectedDisposition, `${current.point} 后 output spool 的磁盘可用性不符合预期`);
            assertAdapterVerifiedRecovery(parseJsonWorker<AdapterCommitRecoverySummary>(await runWorker("recover-commit", dataRoot), "adapter commit retry"));
        });
    }
    console.log("ok - adapter-only output spool matrix remains disk-idempotent without claiming HTTP evidence");
}

async function testCommitProtocolAdapterEffectMatrix(): Promise<void> {
    let exitCode = 100;
    for (const stage of commitStages) {
        for (const point of adapterCommitPoints) {
            await withTempDataRoot(async dataRoot => {
                const crashCode = exitCode;
                exitCode += 1;
                const crashed = await runWorker("crash-commit", dataRoot, { commitFault: { stage, point, exitCode: crashCode } });
                assert.equal(crashed.code, crashCode, `${stage}/${point} 应由独立子进程硬退出: ${crashed.stderr}`);
                assertAdapterVerifiedRecovery(parseJsonWorker<AdapterCommitRecoverySummary>(await runWorker("recover-commit", dataRoot), "adapter effect recovery"));
                assertAdapterVerifiedRecovery(parseJsonWorker<AdapterCommitRecoverySummary>(await runWorker("recover-commit", dataRoot), "adapter effect retry"));
            });
        }
    }
    console.log("ok - adapter-only commit effect hooks survive before_write/after_write hard exits");
}

async function testHigherEpochBlocksOldAdapterRecovery(): Promise<void> {
    await withTempDataRoot(async dataRoot => {
        const crashed = await runWorker("crash-commit", dataRoot, {
            commitFault: { stage: "BodyPublished", point: "after_write", exitCode: 191 },
        });
        assert.equal(crashed.code, 191, `旧 owner 应在 BodyPublished 写后硬退出: ${crashed.stderr}`);
        const takeover = await runWorker("verify-higher-epoch", dataRoot);
        assert.equal(takeover.code, 0, `新进程高 epoch 接管验证失败: ${takeover.stderr}`);
        const summary = JSON.parse(takeover.stdout.trim()) as {
            oldRecovery: string;
            higherEpoch: number;
            bodyOwner: string | null;
            mainOwner: string | null;
            readerOwner: string | null;
            syntheticReceiptCount: number;
        };
        assert.equal(summary.oldRecovery, "audited_stale");
        assert.ok(summary.higherEpoch > 1);
        assert.equal(summary.bodyOwner, "commit-hard-exit-matrix-higher-epoch");
        assert.equal(summary.mainOwner, "commit-hard-exit-matrix-higher-epoch");
        assert.equal(summary.readerOwner, "commit-hard-exit-matrix-higher-epoch");
        assert.equal(summary.syntheticReceiptCount, 1);
    });
    console.log("ok - adapter recovery cannot overwrite higher commit epoch artifacts");
}

const selectedSuite = process.env.RECORD_SCHEDULER_HARD_EXIT_SUITE?.trim();
const availableSuites = ["scheduler", "commit-persistence", "recovery-repair", "output-spool", "adapter-effects", "higher-epoch"] as const;
if (selectedSuite && !(availableSuites as readonly string[]).includes(selectedSuite)) {
    throw new Error(`unknown RECORD_SCHEDULER_HARD_EXIT_SUITE: ${selectedSuite}`);
}
async function runSelectedSuite(name: string, execute: () => Promise<void>): Promise<void> {
    if (!selectedSuite || selectedSuite === name) await execute();
}

await runSelectedSuite("scheduler", testProductionSchedulerHardExitMatrix);
await runSelectedSuite("commit-persistence", testProductionCommitPersistenceMatrix);
await runSelectedSuite("recovery-repair", testProductionRecoveryRepairMatrix);
await runSelectedSuite("output-spool", testOutputSpoolAdapterHardExitMatrix);
await runSelectedSuite("adapter-effects", testCommitProtocolAdapterEffectMatrix);
await runSelectedSuite("higher-epoch", testHigherEpochBlocksOldAdapterRecovery);
console.log("record scheduler hard-exit matrix tests passed");

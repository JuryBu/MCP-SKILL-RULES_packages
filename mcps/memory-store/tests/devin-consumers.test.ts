import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DevinRawConversation } from "../src/devin-types.js";
import type { ConversationRound } from "../src/trajectory.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-devin-consumers-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const { scanDevinSourceEvidence, scanWindsurfConsumerSourceEvidence } = await import("../src/devin-source-evidence.js");
const { createProductionSourceReader } = await import("../src/record-production-source-readers.js");
const { createProductionRecordSchedulerSourceEvidenceAdapter } = await import("../src/record-scheduler-runtime.js");
const { runStageGuard, __testSetStageGuardConversationIdResolver, __testSetStageGuardConversationLoader, __testSetStageGuardCheckRunner } = await import("../src/tools/stage-guard.js");
const { readGuardState, listGuardStates, getGuardLocks, writeGuardState, insertLockMark } = await import("../src/guard-store.js");
const { waitForBackgroundTask, getBackgroundTask } = await import("../src/background-tasks.js");
const cache = await import("../src/conversation-source-cache.js");
const { projectConversationRoundForRecord } = await import("../src/conversation-record-projection.js");
const canonicalId = "synthetic-falcon";
const uuid = "11111111-2222-4333-8444-555555555555";
const sourcePath = path.join(fixtureRoot, "synthetic-sessions.db");
let assertions = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };

function fixture(partial = false): { raw: DevinRawConversation; rounds: ConversationRound[] } {
    return {
        raw: {
            summary: {
                id: canonicalId, canonicalId, sessionId: canonicalId, uuid, aliases: [canonicalId, uuid],
                title: "Synthetic Devin source", cwd: fixtureRoot, workspaceUris: [fixtureRoot],
                sourcePath, desktopPaths: [], sourceKind: "devin-cli", matchedMessageIds: 1,
                mainChainId: 2, partial: false, warnings: [],
            },
            nodes: [{ nodeId: 1, parentNodeId: null, createdAt: 1, message: { images: [{ base64_data: "PRIVATE_BASE64_SENTINEL" }] }, metadata: {} }],
            desktopMessages: [], compactions: [], fingerprint: { path: sourcePath, revision: "synthetic-revision-1" }, partial, warnings: [],
        },
        rounds: [{
            roundIndex: 1, startStep: 1, endStep: 2, userMessage: "Synthetic human request", mediaAttachments: [],
            userMessages: [{ text: "Synthetic human request", rawRole: "user", semanticRole: "user" }],
            aiResponses: [{ stepIndex: 2, response: "Synthetic assistant answer", thinking: "PRIVATE_THINKING_SENTINEL", toolCalls: [] }],
            toolCalls: [], taskBoundaries: [], codeActions: [],
            subagentSummaries: [{ threadId: "child-only", nickname: "fixture worker", summary: "SUBAGENT_NOT_HUMAN" }],
            semanticEvents: [{ semanticRole: "subagent", text: "SUBAGENT_NOT_HUMAN" }],
        }],
    };
}

let releaseCheck = () => {};
let backgroundTaskId: string | undefined;
try {
    const first = await scanDevinSourceEvidence(uuid, { readDevin: async () => fixture() });
    const second = await scanDevinSourceEvidence(canonicalId, { readDevin: async () => fixture() });
    check(first?.classification.state === "Present", "Devin must be readable without any LS");
    assert.deepEqual(first?.identity, second?.identity);
    check(first?.identity.conversationId === canonicalId && first.identity.source.kind === "database", "both aliases use a database canonical identity");
    check(first?.fullSourceRead?.content.truncated === false, "complete source receives full evidence");
    assert.doesNotMatch(JSON.stringify(first?.fullSourceRead), /PRIVATE_BASE64_SENTINEL|PRIVATE_THINKING_SENTINEL/);

    const partial = await scanDevinSourceEvidence(uuid, { readDevin: async () => fixture(true) });
    check(partial?.classification.state === "Unresolved" && !partial.fullSourceRead, "partial source must not yield commit evidence");
    const incompleteSummary = fixture();
    incompleteSummary.raw.summary.partial = true;
    check((await scanDevinSourceEvidence(uuid, { readDevin: async () => incompleteSummary }))?.classification.state === "Unresolved", "partial identity discovery is not complete evidence");
    const compacted = fixture();
    compacted.raw.compactions = [{ nodeId: 2, summarizedFrom: 1, summary: "synthetic compact", restored: false }];
    check(!(await scanDevinSourceEvidence(uuid, { readDevin: async () => compacted }))?.fullSourceRead, "unrestored history cannot become full Record source");
    const noRevision = fixture();
    delete noRevision.raw.fingerprint.revision;
    check((await scanDevinSourceEvidence(uuid, { readDevin: async () => noRevision }))?.classification.state === "Unresolved", "revision is required");
    check((await scanDevinSourceEvidence("unrelated-id", { readDevin: async () => fixture() }))?.classification.state === "Unresolved", "identity mismatch must not leak another source");

    let legacyCalls = 0;
    const unavailable = await scanWindsurfConsumerSourceEvidence(uuid, {
        readDevin: async () => { throw new Error("synthetic database unavailable"); },
        transport: async () => { legacyCalls += 1; throw new Error("must not call LS"); },
    });
    check(unavailable.classification.state === "Unresolved" && legacyCalls === 0, "unknown Devin source must not fall through to LS absence");
    const legacyId = "99999999-2222-4333-8444-555555555555";
    const legacy = await scanWindsurfConsumerSourceEvidence(legacyId, {
        readDevin: async () => null,
        transport: async (method, payload) => {
            legacyCalls += 1;
            if (method === "GetAllCascadeTrajectories") return { trajectorySummaries: { [legacyId]: { summary: "Legacy fixture", stepCount: 2, lastModifiedTime: "2026-09-15T00:00:00.000Z" } } };
            if (method === "GetCascadeTrajectorySteps") return { steps: Number(payload?.stepOffset) === 0 ? [
                { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "legacy user" } },
                { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "legacy answer" } },
            ] : [] };
            throw new Error(`unexpected legacy method ${method}`);
        },
    });
    check(legacy.classification.state === "Present" && legacyCalls > 0, "legacy SourceEvidence classification remains available");

    let readerFixture = fixture();
    const production = createProductionSourceReader({ devinReader: async () => readerFixture });
    const request = { host: "windsurf" as const, conversationId: uuid, workspaceId: "fixture-workspace", workspacePath: fixtureRoot };
    const full = await production.scan(request);
    check(full.fullSourceRead.status === "complete" && full.classification.state === "Present", "Devin source enters the real Record source pipeline");
    check(full.sourceSnapshot?.fullSourceRead.identity.conversationId === canonicalId, "Record source snapshot uses canonical ID");
    const payloadText = Buffer.from(full.fullSourceRead.payload!.bytes).toString("utf8");
    assert.doesNotMatch(payloadText, /PRIVATE_BASE64_SENTINEL|PRIVATE_THINKING_SENTINEL|SUBAGENT_NOT_HUMAN/);
    assert.match(payloadText, /Synthetic human request/);
    assert.match(payloadText, /Synthetic assistant answer/);
    assert.match(payloadText, /"semanticRole":"user"/);
    readerFixture = fixture(true);
    const rejected = await production.scan(request);
    check(rejected.fullSourceRead.status === "unresolved" && !rejected.sourceSnapshot && !rejected.qualifiedAbsence, "partial Record source is neither committable nor Lost");
    readerFixture = fixture();
    readerFixture.rounds[0].aiResponses[0].response = "Different bytes at unchanged revision";
    const drift = await production.scan(request);
    check(drift.fullSourceRead.status === "unresolved" && drift.fullSourceRead.issues.some(issue => issue.code === "revision_drift"), "same revision with changed content remains rejected");

    cache.setConversationSourceCacheDataRootForTests(fixtureRoot);
    const key = { source: "windsurf", conversationId: canonicalId };
    const cachedFixture = fixture();
    const publish = (partial: boolean) => cache.readOrBuild({
        key, fingerprint: cachedFixture.raw.fingerprint, refresh: true,
        build: () => ({ snapshot: { conversationId: canonicalId, windsurfData: { partial } }, rounds: cachedFixture.rounds }),
        projectRecordRound: projectConversationRoundForRecord,
    });
    const published = await publish(false);
    const cachedReader = createProductionSourceReader({ devinReader: async () => { throw new Error("verified cache must not re-read source"); } });
    const cachedRequest = {
        ...request, conversationId: canonicalId,
        cacheGeneration: { key, generation: published.generation, fingerprint: cachedFixture.raw.fingerprint },
    };
    const cachedResult = await cachedReader.scan(cachedRequest);
    check(cachedResult.fullSourceRead.status === "complete" && !cachedResult.enumeration.cacheBypassed, "verified WSF cache remains usable with no source IO");
    const badPublished = await publish(true);
    await assert.rejects(() => cachedReader.scan({ ...cachedRequest, cacheGeneration: { ...cachedRequest.cacheGeneration, generation: badPublished.generation } }), /partial/);
    await assert.rejects(() => cachedReader.scan({ ...cachedRequest, sourceSnapshot: { cacheState: "stale" } }), /stale/);

    let resolutions = 0;
    const { rememberDevinIdentity } = await import("../src/devin-identity.js");
    rememberDevinIdentity(fixture().raw.summary);
    const resolver = async (id: string | undefined) => {
        resolutions += 1;
        return id === uuid || id === canonicalId ? canonicalId : id || null;
    };
    __testSetStageGuardConversationIdResolver(resolver);
    let guardPartial = false;
    let loaderCalls = 0;
    __testSetStageGuardConversationLoader(async () => {
        loaderCalls += 1;
        return { chainUsed: "windsurf", conversationId: canonicalId, rounds: [], roundCount: 1, totalSteps: 2, windsurfData: { partial: guardPartial } } as any;
    });
    let checks = 0;
    const gate = new Promise<void>(resolve => { releaseCheck = resolve; });
    __testSetStageGuardCheckRunner(async () => {
        checks += 1;
        await gate;
        return { passed: false, summary: "synthetic consumer check", missingItems: [] } as any;
    });
    const taskFile = path.join(fixtureRoot, "Task.md");
    fs.writeFileSync(taskFile, "# Synthetic task\n- [ ] synthetic acceptance\n", "utf8");
    const guardParams = { chain: "auto" as const, dataChain: "windsurf" as const, modelChain: "codex" as const, stageId: "Devin consumer fixture" };
    const started = await runStageGuard({ ...guardParams, action: "start", conversationId: uuid, startRound: 1, taskFiles: [taskFile] });
    assert.match(JSON.stringify(started), /已激活/);
    check(loaderCalls === 0, "explicit start boundary must not load conversation body");
    const guard = readGuardState(canonicalId, guardParams.stageId)!;
    check(Boolean(guard) && !readGuardState(uuid, guardParams.stageId), "UUID start stores only the canonical Guard key");
    const status = await runStageGuard({ ...guardParams, action: "status", conversationId: canonicalId });
    assert.match(JSON.stringify(status), new RegExp(guard.guardId));
    const duplicate = await runStageGuard({ ...guardParams, action: "start", conversationId: canonicalId, startRound: 1, taskFiles: [taskFile] });
    assert.match(JSON.stringify(duplicate), /未覆盖/);
    check(listGuardStates(canonicalId).length === 1 && getGuardLocks(taskFile).length === 1, "aliases must not create duplicate guards or locks");
    guardPartial = true;
    const partialGuard = await runStageGuard({ ...guardParams, action: "check", conversationId: uuid });
    assert.match(JSON.stringify(partialGuard), /证据不可用、过期或不完整/);
    check(checks === 0 && readGuardState(canonicalId, guardParams.stageId)?.checkHistory.length === 0, "partial Guard cannot invoke model or record PASS/fail");
    guardPartial = false;
    const taskIdFrom = (response: unknown) => JSON.stringify(response).match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];
    const background = await runStageGuard({ ...guardParams, action: "check", conversationId: uuid, background: true });
    backgroundTaskId = taskIdFrom(background);
    assert.ok(backgroundTaskId);
    const sameBackground = await runStageGuard({ ...guardParams, action: "check", conversationId: canonicalId, background: true });
    check(taskIdFrom(sameBackground) === backgroundTaskId, "check aliases reuse the same background task ID");
    releaseCheck();
    await waitForBackgroundTask(backgroundTaskId, 2);
    const beforePolling = resolutions;
    const polled = await runStageGuard({ chain: "auto", action: "check", taskId: backgroundTaskId });
    assert.match(JSON.stringify(polled), /synthetic consumer check/);
    check(resolutions === beforePolling && checks === 1, "taskId polling never resolves again or starts another model job");
    __testSetStageGuardConversationIdResolver(async () => { throw new Error("identity database offline during cancellation"); });
    const cancelled = await runStageGuard({ chain: "auto", action: "cancel", taskId: backgroundTaskId });
    assert.match(JSON.stringify(cancelled), /已取消/);
    check(!readGuardState(canonicalId, guardParams.stageId) && getGuardLocks(taskFile).length === 0, "taskId cancellation restores stored WSF identity and clears only its guard");
    check(getBackgroundTask(backgroundTaskId)?.status === "done", "cancel after completion preserves terminal job state");
    __testSetStageGuardConversationIdResolver(resolver);
    const legacyGuard = { ...guard, conversationId: uuid, checkHistory: [] };
    writeGuardState(legacyGuard);
    insertLockMark(taskFile, legacyGuard);
    const legacyStatus = await runStageGuard({ ...guardParams, action: "status", conversationId: canonicalId });
    assert.match(JSON.stringify(legacyStatus), new RegExp(guard.guardId));
    const legacyDuplicate = await runStageGuard({ ...guardParams, action: "start", conversationId: canonicalId, startRound: 1, taskFiles: [taskFile] });
    assert.match(JSON.stringify(legacyDuplicate), /未覆盖/);
    const legacyCancel = await runStageGuard({ ...guardParams, action: "cancel", conversationId: canonicalId });
    assert.match(JSON.stringify(legacyCancel), /已取消/);
    check(!readGuardState(uuid, guardParams.stageId) && getGuardLocks(taskFile).length === 0, "pre-upgrade UUID guard remains manageable through the text alias without rewriting its identity");

    const scheduler = createProductionRecordSchedulerSourceEvidenceAdapter({
        resolveWindsurfId: async id => resolver(id),
        listWindsurfThreads: async () => [],
        scanWindsurf: (id, options) => scanWindsurfConsumerSourceEvidence(id, { ...options, readDevin: async () => fixture() }),
    });
    const discoveryRequest = {
        kind: "stale_check" as const, selector: "stale_only" as const, hosts: ["windsurf" as const], workspaceHash: "fixture-workspace", workspacePath: fixtureRoot,
        targets: [uuid, canonicalId].map(conversationId => ({ host: "windsurf" as const, conversationId, workspaceHash: "fixture-workspace", workspacePath: fixtureRoot })),
    };
    const discovery = await scheduler.buildDiscoveryInput(discoveryRequest);
    const input = "input" in discovery ? discovery.input : discovery;
    check(input.sourceEnumerations.length === 1, "scheduler merges explicit UUID/text targets");
    check(input.sourceEnumerations[0].evidence.identity.conversationId === canonicalId && input.sourceEnumerations[0].evidence.targetStatus === "present", "scheduler fallback handles Devin without LS");
    check(input.absenceObservations.length === 0, "Devin never emits synthetic absence observations");
    const partialMetadataScheduler = createProductionRecordSchedulerSourceEvidenceAdapter({
        resolveWindsurfId: async id => resolver(id),
        listWindsurfThreads: async () => [{
            id: canonicalId, cascadeId: canonicalId, title: "Synthetic metadata", summary: "Synthetic metadata", stepCount: 2,
            cwd: fixtureRoot, sourceKind: "devin-cli", sourcePath, partial: true,
        }],
        scanWindsurf: async () => { throw new Error("metadata discovery must not read source bodies"); },
    });
    const partialDiscovery = await partialMetadataScheduler.buildDiscoveryInput(discoveryRequest);
    const partialInput = "input" in partialDiscovery ? partialDiscovery.input : partialDiscovery;
    check(partialInput.sourceEnumerations[0].evidence.identity.source.kind === "database", "Devin metadata retains the actual database source identity");
    check(partialInput.sourceEnumerations[0].evidence.exactFetchResult === "unresolved" && !partialInput.sourceEnumerations[0].evidence.enumerationComplete, "partial metadata cannot assert complete presence");
    await assert.rejects(() => scheduler.buildDiscoveryInput({
        ...discoveryRequest,
        records: [uuid, canonicalId].map(conversationId => ({
            conversationId, host: "windsurf", title: "Alias collision", workspaceHash: "fixture-workspace", workspacePath: fixtureRoot,
            lastUpdatedAt: "2026-09-15T00:00:00.000Z", recordBodyHash: `sha256:${"1".repeat(64)}`,
        })),
    }), /multiple existing records/);
    console.log(`PASS devin-consumers: ${assertions} checks plus strict equality, payload exclusion, and rejection assertions`);
} finally {
    releaseCheck();
    if (backgroundTaskId) await waitForBackgroundTask(backgroundTaskId, 2);
    __testSetStageGuardConversationIdResolver();
    __testSetStageGuardConversationLoader();
    __testSetStageGuardCheckRunner();
    cache.resetConversationSourceCacheForTests();
    assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

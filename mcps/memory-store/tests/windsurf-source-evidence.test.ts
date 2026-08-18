import assert from "node:assert/strict";
import {
    normalizeWindsurfTrajectoryList,
    scanWindsurfSourceEvidence,
    windsurfStepsToConversationRounds,
    type WindsurfLsTransport,
} from "../src/windsurf-client.ts";

const fixedNow = () => new Date("2026-07-13T12:00:00.000Z");

function summary(overrides: Record<string, unknown> = {}) {
    return {
        summary: "WSF source evidence fixture",
        title_best_effort: "[subagent] evidence-reviewer",
        parentConversationId: "cascade-parent",
        subagent: { label: "evidence-reviewer", nickname: "Mochi" },
        isSubagent: true,
        stepCount: 2,
        lastModifiedTime: "2026-07-13T11:59:00.000Z",
        cwd: "C:\\repo",
        ...overrides,
    };
}

function conversationSteps(userText = "用户输入", assistantText = "助手回复") {
    return [
        { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: userText } },
        { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: assistantText } },
    ];
}

function transportFor(options: {
    listResponses: unknown[];
    steps?: unknown[];
    stepResponses?: unknown[];
    stepError?: Error;
    calls?: { list: number; steps: number };
}): WindsurfLsTransport {
    let listIndex = 0;
    let stepIndex = 0;
    const steps = options.steps || conversationSteps();
    return async (method, payload) => {
        if (method === "GetAllCascadeTrajectories") {
            options.calls && (options.calls.list += 1);
            const response = options.listResponses[Math.min(listIndex, options.listResponses.length - 1)];
            listIndex += 1;
            return response;
        }
        if (method === "GetCascadeTrajectorySteps") {
            options.calls && (options.calls.steps += 1);
            if (options.stepError) throw options.stepError;
            if (options.stepResponses) {
                const response = options.stepResponses[Math.min(stepIndex, options.stepResponses.length - 1)];
                stepIndex += 1;
                return response;
            }
            return Number(payload?.stepOffset) === 0 ? { steps } : { steps: [] };
        }
        throw new Error(`unexpected WSF method ${method}`);
    };
}

const baseList = { trajectorySummaries: { "cascade-evidence": summary() } };
const hostFields = normalizeWindsurfTrajectoryList(baseList)[0];
assert.equal(hostFields.parentConversationId, "cascade-parent");
assert.equal(hostFields.isChildThread, true);
assert.equal(hostFields.agentRole, "evidence-reviewer");
assert.equal(hostFields.agentNickname, "Mochi");
assert.equal(hostFields.titleBestEffort, "[subagent] evidence-reviewer");

const normalCalls = { list: 0, steps: 0 };
const normal = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({ listResponses: [baseList], calls: normalCalls }),
    workspaceId: "workspace-evidence",
    scanId: "scan-normal",
    now: fixedNow,
});
assert.equal(normal.classification.state, "Present");
assert.equal(normal.enumeration.enumerationComplete, true);
assert.equal(normal.enumeration.cacheBypassed, true);
assert.equal(normal.exactFetch.exactFetchResult, "present");
assert.ok(normal.fullSourceRead);
assert.ok(normal.sourceSnapshot);
assert.equal(normal.sourceSnapshot.fullSourceRead.enumerationComplete, true);
assert.equal(normal.sourceSnapshot.fullSourceRead.cacheBypassed, true);
assert.equal(normal.thread?.parentConversationId, "cascade-parent");
assert.equal(normal.thread?.titleBestEffort, "[subagent] evidence-reviewer");
assert.ok(normalCalls.list >= 2, "source evidence must enumerate before and after exact fetch");
assert.equal(normalCalls.steps, 2, "source evidence must fetch steps instead of reading the old conversation cache");

const emptyObjectTerminal = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({
        listResponses: [baseList],
        stepResponses: [{ steps: conversationSteps() }, {}],
    }),
    workspaceId: "workspace-evidence",
    scanId: "scan-empty-object-terminal",
    now: fixedNow,
});
assert.equal(emptyObjectTerminal.classification.state, "Present");
assert.equal(emptyObjectTerminal.exactFetch.exactFetchResult, "present");
assert.equal(emptyObjectTerminal.readResult?.partial, false);
assert.ok(emptyObjectTerminal.fullSourceRead);

const supportedStepFields = ["steps", "trajectorySteps", "cascadeTrajectorySteps"] as const;
for (const field of supportedStepFields) {
    const aliasPagination = await scanWindsurfSourceEvidence("cascade-evidence", {
        transport: transportFor({
            listResponses: [baseList],
            stepResponses: [{ [field]: conversationSteps() }, { [field]: [] }],
        }),
        workspaceId: "workspace-evidence",
        scanId: `scan-${field}-pagination`,
        now: fixedNow,
    });
    assert.equal(aliasPagination.classification.state, "Present", `${field} pagination should remain supported`);
    assert.equal(aliasPagination.exactFetch.exactFetchResult, "present", `${field} pagination should complete exact fetch`);
    assert.equal(aliasPagination.readResult?.steps.length, 2, `${field} pagination should retain all steps`);
}

for (const field of supportedStepFields) {
    const nonArrayField = await scanWindsurfSourceEvidence("cascade-evidence", {
        transport: transportFor({ listResponses: [baseList], stepResponses: [{ [field]: "bad" }] }),
        workspaceId: "workspace-evidence",
        scanId: `scan-${field}-non-array`,
        now: fixedNow,
    });
    assert.equal(nonArrayField.classification.state, "Unresolved", `${field} must fail closed when not an array`);
    assert.equal(nonArrayField.exactFetch.exactFetchResult, "unresolved", `${field} parse failure must leave exact fetch unresolved`);
    assert.ok(nonArrayField.exactFetch.errors.some(issue => issue.code === "parse_error"));
    assert.equal(nonArrayField.fullSourceRead, undefined);
}

const unknownTerminalObject = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({
        listResponses: [baseList],
        stepResponses: [{ steps: conversationSteps() }, { unexpected: true }],
    }),
    workspaceId: "workspace-evidence",
    scanId: "scan-unknown-terminal-object",
    now: fixedNow,
});
assert.equal(unknownTerminalObject.classification.state, "Unresolved");
assert.equal(unknownTerminalObject.exactFetch.exactFetchResult, "unresolved");
assert.ok(unknownTerminalObject.exactFetch.errors.some(issue => issue.code === "parse_error"));
assert.equal(unknownTerminalObject.fullSourceRead, undefined);

const stepCountMismatch = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({
        listResponses: [{ trajectorySummaries: { "cascade-evidence": summary({ stepCount: 3 }) } }],
        stepResponses: [{ steps: conversationSteps() }, {}],
    }),
    workspaceId: "workspace-evidence",
    scanId: "scan-step-count-mismatch",
    now: fixedNow,
});
assert.equal(stepCountMismatch.classification.state, "Unresolved");
assert.equal(stepCountMismatch.fullSourceRead, undefined);
assert.equal(stepCountMismatch.sourceSnapshot, undefined);

const fidelityRounds = windsurfStepsToConversationRounds([
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "", images: [{ mimeType: "image/png", base64Data: "aGk=" }] } },
    { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "  \n" } },
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "", images: [{}] } },
]);
assert.deepEqual(fidelityRounds.map(round => round.userMessage), ["", ""]);
assert.equal(fidelityRounds[0]?.attachments?.[0]?.dataUrl, "data:image/png;base64,aGk=", "Windsurf attachment-only input must retain source evidence");
assert.match(fidelityRounds[1]?.attachments?.[0]?.warning || "", /no base64Data/u, "incomplete Windsurf attachments must remain as warning descriptors");
assert.equal(fidelityRounds[0]?.aiResponses[0]?.response, "  \n", "whitespace assistant responses must stay physically observable");

const hostFieldChanges = [
    {
        name: "parentConversationId",
        field: "parentConversationId" as const,
        expected: "cascade-parent-changed",
        overrides: { parentConversationId: "cascade-parent-changed" },
    },
    {
        name: "title_best_effort",
        field: "titleBestEffort" as const,
        expected: "[subagent] evidence-reviewer-changed",
        overrides: { title_best_effort: "[subagent] evidence-reviewer-changed" },
    },
    {
        name: "agentRole",
        field: "agentRole" as const,
        expected: "evidence-role-changed",
        overrides: { subagent: { label: "evidence-role-changed", nickname: "Mochi" } },
    },
    {
        name: "agentNickname",
        field: "agentNickname" as const,
        expected: "Mochi-changed",
        overrides: { subagent: { label: "evidence-reviewer", nickname: "Mochi-changed" } },
    },
] as const;

for (const fieldChange of hostFieldChanges) {
    const changedList = { trajectorySummaries: { "cascade-evidence": summary(fieldChange.overrides) } };
    const changedCalls = { list: 0, steps: 0 };
    const changedEvidence = await scanWindsurfSourceEvidence("cascade-evidence", {
        transport: transportFor({ listResponses: [changedList], calls: changedCalls }),
        workspaceId: "workspace-evidence",
        scanId: `scan-${fieldChange.name}-changed`,
        now: fixedNow,
    });
    assert.equal(changedEvidence.classification.state, "Present", `${fieldChange.name} stable change should remain present`);
    assert.equal(changedEvidence.thread?.stepCount, normal.thread?.stepCount, `${fieldChange.name} fixture must keep stepCount unchanged`);
    assert.equal(changedEvidence.thread?.[fieldChange.field], fieldChange.expected, `${fieldChange.name} must survive normalization`);
    assert.equal(changedEvidence.enumeration.sourceRevision.contentCursor, normal.enumeration.sourceRevision.contentCursor, `${fieldChange.name} must not fake a content change`);
    assert.notEqual(changedEvidence.enumeration.sourceRevision.revision, normal.enumeration.sourceRevision.revision, `${fieldChange.name} must create a new revision`);
    assert.notEqual(changedEvidence.enumeration.evidenceHash, normal.enumeration.evidenceHash, `${fieldChange.name} must create new evidence`);
    assert.equal(changedEvidence.enumeration.cacheBypassed, true);
    assert.equal(changedEvidence.sourceSnapshot?.fullSourceRead.enumerationComplete, true);
    assert.equal(changedEvidence.sourceSnapshot?.fullSourceRead.cacheBypassed, true);
    assert.equal(changedCalls.list, 2, `${fieldChange.name} scan must perform both real list reads`);
    assert.equal(changedCalls.steps, 2, `${fieldChange.name} scan must perform a real exact fetch`);

    const driftCalls = { list: 0, steps: 0 };
    const driftEvidence = await scanWindsurfSourceEvidence("cascade-evidence", {
        transport: transportFor({ listResponses: [baseList, changedList], calls: driftCalls }),
        workspaceId: "workspace-evidence",
        scanId: `scan-${fieldChange.name}-drift`,
        now: fixedNow,
    });
    assert.equal(driftEvidence.classification.state, "Unresolved", `${fieldChange.name} in-scan change must be unresolved`);
    assert.ok(driftEvidence.enumeration.errors.some(issue => issue.code === "revision_drift"), `${fieldChange.name} in-scan change must report revision drift`);
    assert.equal(driftEvidence.enumeration.cacheBypassed, true);
    assert.equal(driftEvidence.sourceSnapshot, undefined);
    assert.equal(driftCalls.list, 2, `${fieldChange.name} drift check must bypass list cache`);
    assert.equal(driftCalls.steps, 2, `${fieldChange.name} drift check must bypass exact-fetch cache`);
}

const changedContent = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({ listResponses: [baseList], steps: conversationSteps("用户输入", "同 stepCount 的新内容") }),
    workspaceId: "workspace-evidence",
    scanId: "scan-changed-content",
    now: fixedNow,
});
assert.notEqual(changedContent.enumeration.sourceRevision.revision, normal.enumeration.sourceRevision.revision);
assert.notEqual(changedContent.enumeration.sourceRevision.contentCursor, normal.enumeration.sourceRevision.contentCursor);
assert.equal(changedContent.enumeration.cacheBypassed, true);

const partial = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({ listResponses: [{ trajectorySummaries: { "cascade-evidence": summary() }, partial: true }] }),
    workspaceId: "workspace-evidence",
    scanId: "scan-partial",
    now: fixedNow,
});
assert.equal(partial.classification.state, "Unresolved");
assert.equal(partial.enumeration.enumerationComplete, false);
assert.equal(partial.enumeration.pagination.truncated, true);
assert.ok(partial.enumeration.errors.some(issue => issue.code === "pagination_incomplete"));
assert.equal(partial.sourceSnapshot, undefined);

const truncatedExactTransport: WindsurfLsTransport = async (method, payload) => {
    if (method === "GetAllCascadeTrajectories") return baseList;
    if (method === "GetCascadeTrajectorySteps") {
        assert.equal(payload?.cascadeId, "cascade-evidence");
        return { steps: conversationSteps(), truncated: true };
    }
    throw new Error(`unexpected WSF method ${method}`);
};
const truncatedExact = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: truncatedExactTransport,
    workspaceId: "workspace-evidence",
    scanId: "scan-exact-truncated",
    now: fixedNow,
});
assert.equal(truncatedExact.classification.state, "Unresolved");
assert.equal(truncatedExact.exactFetch.exactFetchResult, "unresolved");
assert.equal(truncatedExact.readResult?.partial, true);
assert.ok(truncatedExact.exactFetch.errors.some(issue => issue.code === "pagination_incomplete"));
assert.equal(truncatedExact.fullSourceRead, undefined);
assert.equal(truncatedExact.sourceSnapshot, undefined);

const oversizedAttachmentEvidence = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({
        listResponses: [baseList],
        steps: [
            {
                type: "CORTEX_STEP_TYPE_USER_INPUT",
                userInput: { images: [{ base64Data: "A".repeat((8 * 1024 * 1024) + 1) }] },
            },
            { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "附件超过安全上限" } },
        ],
    }),
    workspaceId: "workspace-evidence",
    scanId: "scan-oversized-attachment",
    now: fixedNow,
});
assert.equal(oversizedAttachmentEvidence.classification.state, "Unresolved");
assert.equal(oversizedAttachmentEvidence.exactFetch.exactFetchResult, "unresolved");
assert.equal(oversizedAttachmentEvidence.enumeration.sourceRevision.contentCursor, null);
assert.ok(oversizedAttachmentEvidence.exactFetch.errors.some(issue => issue.code === "limit_reached"));
assert.equal(oversizedAttachmentEvidence.fullSourceRead, undefined);
assert.equal(oversizedAttachmentEvidence.sourceSnapshot, undefined);

const limited = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({ listResponses: [{ trajectorySummaries: { "cascade-evidence": summary() }, nextCursor: "page-2" }] }),
    workspaceId: "workspace-evidence",
    scanId: "scan-limit",
    maxPages: 1,
    now: fixedNow,
});
assert.equal(limited.classification.state, "Unresolved");
assert.equal(limited.enumeration.pagination.limit, 1);
assert.ok(limited.enumeration.errors.some(issue => issue.code === "limit_reached"));

const timeoutTransport: WindsurfLsTransport = async () => {
    throw new Error("WSF request timed out");
};
const timedOut = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: timeoutTransport,
    workspaceId: "workspace-evidence",
    scanId: "scan-timeout",
    now: fixedNow,
});
assert.equal(timedOut.exactFetchAttempted, false);
assert.ok(timedOut.enumeration.errors.some(issue => issue.code === "timeout"));

const exactError = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({ listResponses: [baseList], stepError: new Error("WSF LS exploded") }),
    workspaceId: "workspace-evidence",
    scanId: "scan-exact-error",
    now: fixedNow,
});
assert.equal(exactError.exactFetch.exactFetchResult, "unresolved");
assert.ok(exactError.exactFetch.errors.some(issue => issue.code === "exact_fetch_failed"));
assert.equal(exactError.sourceSnapshot, undefined);

const notFound = await scanWindsurfSourceEvidence("cascade-missing", {
    transport: transportFor({ listResponses: [{ trajectorySummaries: {} }], stepError: new Error("HTTP 404 cascade not found") }),
    workspaceId: "workspace-evidence",
    scanId: "scan-not-found",
    now: fixedNow,
});
assert.equal(notFound.exactFetch.exactFetchResult, "not_found");
assert.equal(notFound.classification.state, "Lost");
assert.ok(notFound.classification.lostObservation);

const revisionDrift = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({
        listResponses: [
            { trajectorySummaries: { "cascade-evidence": summary() } },
            { trajectorySummaries: { "cascade-evidence": summary({ lastModifiedTime: "2026-07-13T12:00:00.000Z" }) } },
        ],
    }),
    workspaceId: "workspace-evidence",
    scanId: "scan-revision-drift",
    now: fixedNow,
});
assert.equal(revisionDrift.classification.state, "Unresolved");
assert.ok(revisionDrift.enumeration.errors.some(issue => issue.code === "revision_drift"));
assert.equal(revisionDrift.sourceSnapshot, undefined);

const malformed = await scanWindsurfSourceEvidence("cascade-evidence", {
    transport: transportFor({ listResponses: [{ trajectorySummaries: "malformed" }] }),
    workspaceId: "workspace-evidence",
    scanId: "scan-malformed",
    now: fixedNow,
});
assert.equal(malformed.classification.state, "Unresolved");
assert.equal(malformed.exactFetchAttempted, false);
assert.ok(malformed.enumeration.errors.some(issue => issue.code === "parse_error"));

console.log("windsurf-source-evidence: pagination, cache, exact fetch, drift, host fields, and malformed payload fixtures passed");

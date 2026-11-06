import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { ListConversationCandidatesOptions, ConversationSourceAdapters, UnifiedConversationCandidate } from "../src/conversation-filter.js";
import type { DevinRawConversation, DevinReadOptions } from "../src/devin-types.js";
import type { ConversationRound } from "../src/trajectory.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-plan62-wsf-target-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_RECORD_AUTO_UPDATE = "false";
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(temporary, "absent.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(temporary, "absent-desktop");
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(temporary, "absent-jobs.json");
process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = path.join(temporary, "absent-pb");
process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = path.join(temporary, "absent-implicit");
const { listConversationCandidates } = await import("../src/conversation-filter.js");
const { discoverDevinChildCandidates } = await import("../src/devin-child-discovery.js");
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const workspace = "C:/plan62/workspace";
const marker = "Plan62 unique visible context marker";

function parent(id: string, title = id, cwd = workspace): UnifiedConversationCandidate {
    return { id, aliases: [id, `alias-${id}`], sourceKind: "devin-cli", dataChain: "windsurf", title,
        workspace: cwd, workspaces: [cwd], updatedAt: "2026-11-03T00:00:00Z", detail: "devin-cli" };
}

function rawParent(candidate: UnifiedConversationCandidate, agents = ["worker"]): DevinRawConversation {
    return { summary: { id: candidate.id, canonicalId: candidate.id, aliases: candidate.aliases || [candidate.id],
        title: candidate.title, cwd: candidate.workspace, workspaceUris: [candidate.workspace], sourcePath: "synthetic.db",
        desktopPaths: [], sourceKind: "devin-cli", matchedMessageIds: 1, partial: false, warnings: [] },
        nodes: [], desktopMessages: agents.map((agentId, position) => ({ position, kind: "subagent", payload: {
            agentId, title: `Agent ${agentId}`, task: `Inspect ${agentId}`, childMessages: [{ kind: "agent_message", content: marker }],
        } })), compactions: [], fingerprint: { revision: `fixture-${candidate.id}` }, partial: false, warnings: [] };
}

function round(text: string): ConversationRound {
    return { roundIndex: 1, startStep: 1, endStep: 1, userMessage: text,
        mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

function harness(parents: UnifiedConversationCandidate[], bodies: Record<string, string> = {}) {
    const events: string[] = [];
    const readBudgets: DevinReadOptions[] = [];
    const contextDeadlines: number[] = [];
    const discoveredOptions: ListConversationCandidatesOptions[] = [];
    const adapters = {
        localList: async (_source: string, _limit: number, options: ListConversationCandidatesOptions) => {
            events.push("list");
            discoveredOptions.push(options);
            return parents.map(candidate => ({ ...candidate }));
        },
        windsurf: { list: () => [], resolve: () => null,
            discoverChildren: async (candidates: UnifiedConversationCandidate[], options: ListConversationCandidatesOptions) => {
                events.push("children");
                return discoverDevinChildCandidates(candidates, { ...options, readRaw: async (id, budget) => {
                    events.push(`raw:${id}`);
                    readBudgets.push(budget);
                    const candidate = parents.find(item => item.id === id || item.aliases?.includes(id));
                    return candidate ? rawParent(candidate) : null;
                } });
            },
        },
    } as unknown as ConversationSourceAdapters;
    const options: ListConversationCandidatesOptions = { dataChains: ["windsurf"], source: "local", adapters,
        contextAdapters: { readRounds: async (candidate, budget) => {
            events.push(`probe:${candidate.id}`);
            contextDeadlines.push(budget.deadlineAt);
            return { rounds: [round(bodies[candidate.id] || "unrelated fixture text")] };
        } } };
    return { events, readBudgets, contextDeadlines, discoveredOptions, options };
}

test("explicit parent targets and exact ID query probe only that identity without child discovery", async () => {
    for (const selector of [{ conversationIds: ["target"] }, { query: "target" }, { query: "alias-target" }]) {
        const fixture = harness([parent("other"), parent("target", "Target title")], { target: marker });
        const result = await listConversationCandidates({ ...fixture.options, ...selector, contextProbe: marker, workspaces: [workspace] });
        assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
        assert.deepEqual(fixture.events, ["list", "probe:target"]);
        assert.equal(result.contextLocate?.resolution, "unique_in_scope");
        assert.equal(result.partial, false);
    }
});

test("caller conversationId never becomes an implicit target and unmatched query does not replace contextProbe", async () => {
    const fixture = harness([parent("caller"), parent("actual-target")], { "actual-target": marker });
    const options = { ...fixture.options, conversationId: "caller", query: "unmatched title hint", contextProbe: marker };
    const result = await listConversationCandidates(options);
    assert.deepEqual(result.candidates.map(item => item.id), ["actual-target"]);
    assert.equal(fixture.discoveredOptions[0]?.conversationIds, undefined);
    assert.equal(fixture.events.includes("children"), false);
    assert.equal(result.partial, true);
    assert.equal(result.contextLocate?.resolution, "single_match_in_partial_scan");
    assert.ok(result.statuses[0]?.warnings?.some(warning => warning.startsWith("devin_child_discovery_deferred")));
});

test("default workspace context lookup checks main conversations before any subtree", async () => {
    const fixture = harness(Array.from({ length: 8 }, (_, index) => parent(`parent-${index}`)), { "parent-7": marker });
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker, workspaces: [workspace], workspaceMode: "exact" });
    assert.deepEqual(result.candidates.map(item => item.id), ["parent-7"]);
    assert.equal(fixture.events.filter(event => event.startsWith("raw:")).length, 0);
    assert.equal(result.partial, true);
});

test("unknown context falls back to legal child discovery without rereading the main body", async () => {
    const fixture = harness([parent("target")], { "target--subagent-worker": marker });
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker, workspaces: [workspace] });
    assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
    assert.equal(result.candidates[0]?.matchedChildConversationId, "target--subagent-worker");
    assert.deepEqual(fixture.events, ["list", "probe:target", "children", "raw:target", "probe:target--subagent-worker"]);
    assert.equal(result.contextLocate?.scannedFiles, 2);
    assert.equal(result.contextLocate?.resolution, "unique_in_scope");
});

test("unknown child metadata query retains parent promotion", async () => {
    const fixture = harness([parent("target", "Parent title")]);
    const result = await listConversationCandidates({ ...fixture.options, query: "worker" });
    assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
    assert.equal(result.candidates[0]?.matchedChildConversationId, "target--subagent-worker");
    assert.deepEqual(fixture.events, ["list", "children", "raw:target"]);
});

test("a metadata hit stays fast and explicitly reports deferred child candidates", async () => {
    const fixture = harness([parent("target", "Parent title")]);
    const result = await listConversationCandidates({ ...fixture.options, query: "Parent title" });
    assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
    assert.deepEqual(fixture.events, ["list"]);
    assert.equal(result.partial, true);
});

test("explicit child ID reads only its parent and returns the requested child", async () => {
    const fixture = harness([parent("other"), parent("target")]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "all", conversationIds: ["alias-target--subagent-worker"] });
    assert.deepEqual(result.candidates.map(item => item.id), ["target--subagent-worker"]);
    assert.deepEqual(fixture.events, ["list", "children", "raw:target"]);
});

test("explicit main target in all mode does not enumerate children excluded by its target filter", async () => {
    const fixture = harness([parent("target"), parent("other")]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "all", conversationIds: ["target"] });
    assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
    assert.deepEqual(fixture.events, ["list"]);
    assert.equal(result.partial, false);
});

test("children parentQuery and workspace constrain discovery before parent reads", async () => {
    const fixture = harness([...Array.from({ length: 10 }, (_, index) => parent(`other-${index}`, "Other")),
        parent("target", "Selected"), parent("outside", "Selected", "C:/elsewhere")]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "children", parentQuery: "Selected",
        workspaces: [workspace], workspaceMode: "exact" });
    assert.deepEqual(result.candidates.map(item => item.id), ["target--subagent-worker"]);
    assert.deepEqual(fixture.events, ["list", "children", "raw:target"]);
});

test("ambiguous parentQuery remains partial without guessing or reading all parents", async () => {
    const fixture = harness([parent("first", "Same title"), parent("second", "Same title")]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "children", parentQuery: "Same title" });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(fixture.events, ["list"]);
    assert.equal(result.partial, true);
    assert.ok(result.statuses[0]?.warnings?.some(warning => warning.includes("2 个候选")));
});

test("expired list deadline does not start metadata or context reads", async () => {
    const fixture = harness([parent("target")], { target: marker });
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker, deadlineAt: Date.now() - 1 });
    assert.deepEqual(fixture.events, []);
    assert.equal(result.partial, true);
    assert.equal(result.statuses[0]?.status, "failed");
    assert.match(result.statuses[0]?.error || "", /deadline/u);
});

test("the same absolute deadline reaches metadata, fallback child reads and context budgets", async () => {
    const fixture = harness([parent("target")], { "target--subagent-worker": marker });
    const deadlineAt = Date.now() + 1500;
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker, deadlineAt, deadlineMs: 5000 });
    assert.equal(result.candidates.length, 1);
    assert.equal(fixture.discoveredOptions[0]?.deadlineAt, deadlineAt);
    assert.equal(fixture.readBudgets[0]?.deadlineMs, deadlineAt);
    assert.ok(fixture.contextDeadlines.every(deadline => deadline <= deadlineAt));
});

test("child discovery honours absolute expiry, zero relative budget and zero bytes", async () => {
    for (const budget of [{ deadlineAt: Date.now() - 1 }, { deadlineMs: 0 }, { maxBytes: 0 }]) {
        let reads = 0;
        const result = await discoverDevinChildCandidates([parent("target")], { ...budget, readRaw: async () => { reads++; return null; } });
        assert.equal(reads, 0, JSON.stringify(budget));
        assert.ok(result.warnings.includes("devin_child_read_budget"));
    }
});

test("AbortSignal and callback cancellation propagate and stop subsequent parent reads", async () => {
    for (const kind of ["signal", "callback"]) {
        const controller = new AbortController();
        let cancelled = false;
        let reads = 0;
        const result = await discoverDevinChildCandidates([parent("first"), parent("second")], {
            signal: controller.signal, isCancelled: () => cancelled,
            readRaw: async (id, options) => {
                reads++;
                assert.equal(options.signal, controller.signal);
                if (kind === "signal") controller.abort();
                else cancelled = true;
                assert.equal(options.isCancelled?.(), true);
                return rawParent(parent(id));
            },
        });
        assert.equal(reads, 1);
        assert.deepEqual(result.candidates, []);
        assert.ok(result.warnings.includes("devin_child_read_budget"));
    }
});

test("explicit child selection precedes the child-count budget", async () => {
    const candidate = parent("target");
    const result = await discoverDevinChildCandidates([candidate], {
        conversationIds: ["target--subagent-wanted"], candidateLimit: 1,
        readRaw: async () => rawParent(candidate, ["other", "wanted"]),
    });
    assert.deepEqual(result.candidates.map(item => item.id), ["target--subagent-wanted"]);
    assert.deepEqual(result.warnings, []);
});

test("parent scan limits and unresolved identities stay visible", async () => {
    const parents = Array.from({ length: 10 }, (_, index) => parent(`parent-${index}`));
    let reads = 0;
    const bounded = await discoverDevinChildCandidates(parents, { readRaw: async () => { reads++; return null; } });
    assert.equal(reads, 8);
    assert.ok(bounded.warnings.some(warning => warning.startsWith("devin_child_parent_budget")));
    const unresolved = await discoverDevinChildCandidates([parent("pending")], { readRaw: async () => {
        const raw = rawParent(parent("pending"));
        raw.summary.identityStatus = "pending";
        return raw;
    } });
    assert.equal(unresolved.candidates[0]?.sourcePartial, true);
    assert.ok(unresolved.warnings.some(warning => warning.includes("identity")));
});

test("verified CLI children replace stale Desktop-only warnings while unresolved Desktop children retain them", async () => {
    for (const sourceKind of ["devin-cli", "devin-desktop"] as const) {
        const candidate = { ...parent("target"), sourceKind: "devin-desktop", sourcePartial: true, discoveryWarnings: ["DEVIN_DESKTOP_ONLY_PARTIAL"] };
        const result = await discoverDevinChildCandidates([candidate], { readRaw: async () => {
            const raw = rawParent(candidate);
            raw.summary.sourceKind = sourceKind;
            raw.summary.partial = sourceKind === "devin-desktop";
            raw.summary.warnings = ["DEVIN_DESKTOP_ONLY_PARTIAL"];
            raw.warnings = ["DEVIN_DESKTOP_ONLY_PARTIAL"];
            return raw;
        } });
        assert.equal(result.candidates[0]?.sourcePartial, sourceKind === "devin-desktop");
        assert.equal(Boolean(result.candidates[0]?.discoveryWarnings?.length), sourceKind === "devin-desktop");
        assert.equal(result.warnings.includes("DEVIN_DESKTOP_ONLY_PARTIAL"), sourceKind === "devin-desktop");
    }
});

test("workspace exclusion prevents even an explicit parent from creating a synthetic out-of-scope read", async () => {
    const fixture = harness([parent("outside", "Outside", "C:/elsewhere")]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "children", parentConversationId: "outside",
        workspaces: [workspace], workspaceMode: "exact" });
    assert.deepEqual(fixture.events, ["list"]);
    assert.deepEqual(result.candidates, []);
});

test("explicit parent discovery still resolves a legacy PB candidate through the Devin source", async () => {
    const fixture = harness([{ ...parent("legacy-parent"), sourceKind: "cascade-pb" }]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "children", parentConversationId: "legacy-parent" });
    assert.deepEqual(result.candidates.map(item => item.id), ["legacy-parent--subagent-worker"]);
    assert.deepEqual(fixture.discoveredOptions[0]?.conversationIds, ["legacy-parent"]);
    assert.deepEqual(fixture.events, ["list", "children", "raw:legacy-parent"]);
});

test("exact child query constrains context to that child and promotes its parent", async () => {
    const fixture = harness([parent("other"), parent("target")], { "target--subagent-worker": marker });
    const result = await listConversationCandidates({ ...fixture.options, query: "target--subagent-worker", contextProbe: marker });
    assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
    assert.deepEqual(fixture.events, ["list", "children", "raw:target", "probe:target--subagent-worker"]);
});

test("mixed explicit main and child IDs never read the unrelated main subtree", async () => {
    const fixture = harness([parent("main"), parent("target")]);
    const result = await listConversationCandidates({ ...fixture.options, threadMode: "all", conversationIds: ["main", "target--subagent-worker"] });
    assert.deepEqual(result.candidates.map(item => item.id), ["main", "target--subagent-worker"]);
    assert.deepEqual(fixture.events, ["list", "children", "raw:target"]);
});

test("ambiguous exact aliases retain all matching identities", async () => {
    const fixture = harness([parent("first"), parent("second")].map(candidate => ({ ...candidate, aliases: ["shared-alias"] })),
        { first: marker, second: marker });
    const result = await listConversationCandidates({ ...fixture.options, query: "shared-alias", contextProbe: marker });
    assert.equal(result.candidates.length, 2);
    assert.equal(result.contextLocate?.resolution, "ambiguous");
    assert.equal(fixture.events.includes("children"), false);
});

test("fallback retains the remaining file budget and exposes unsearched children", async () => {
    const fixture = harness([parent("target")]);
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker, candidateLimit: 1 });
    assert.deepEqual(fixture.events, ["list", "probe:target"]);
    assert.equal(result.contextLocate?.resolution, "unverified");
    assert.equal(result.contextLocate?.status, "budget_exhausted");
    assert.equal(result.partial, true);
});

test("deadline expiry during a main probe prevents fallback parent reads", async () => {
    const fixture = harness([parent("target")]);
    fixture.options.contextAdapters = { readRounds: async () => {
        fixture.events.push("slow-probe");
        await new Promise(resolve => setTimeout(resolve, 35));
        return { rounds: [round("unrelated")] };
    } };
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker, deadlineAt: Date.now() + 20 });
    assert.deepEqual(fixture.events, ["list", "slow-probe"]);
    assert.equal(result.partial, true);
    assert.equal(result.contextLocate?.resolution, "unverified");
});

test("cancellation during a main probe reaches readers and skips child fallback", async () => {
    const fixture = harness([parent("target")]);
    const controller = new AbortController();
    fixture.options.contextAdapters = { readRounds: async (_candidate, budget) => {
        controller.abort();
        assert.equal(budget.isCancelled(), true);
        return { rounds: [round(marker)] };
    } };
    await assert.rejects(listConversationCandidates({ ...fixture.options, contextProbe: marker, signal: controller.signal }),
        error => error instanceof Error && error.name === "AbortError" && (error as Error & { code?: string }).code === "SOURCE_WORKER_CANCELLED");
    assert.deepEqual(fixture.events, ["list"]);
});

test("fallback preserves earlier read failures and partial identity", async () => {
    const fixture = harness([parent("target")]);
    fixture.options.contextAdapters = { readRounds: async candidate => {
        if (!candidate.isChildThread) throw new Error("synthetic main read failure");
        return { rounds: [round(marker)] };
    } };
    const result = await listConversationCandidates({ ...fixture.options, contextProbe: marker });
    assert.deepEqual(result.candidates.map(item => item.id), ["target"]);
    assert.equal(result.contextLocate?.candidateFailures?.length, 1);
    assert.equal(result.contextLocate?.resolution, "single_match_in_partial_scan");
});

test("default entry isolates serializable options once and waits for close on success, cancellation and deadline", async context => {
    const filename = process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH!;
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,working_directory TEXT,title TEXT,created_at INTEGER,last_activity_at INTEGER,main_chain_id INTEGER,workspace_dirs TEXT,hidden INTEGER,metadata TEXT);
        CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY,session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER,metadata TEXT);
        CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT);
        CREATE TABLE subagent_heads(session_id TEXT,agent_id TEXT,chain_node_id INTEGER,updated_at INTEGER);`);
    database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run("isolated-target", workspace, "Isolated target", 1700000000, 1700000000, 1, "[]", 0, "{}");
    database.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?,?)").run(1, "isolated-target", 1, null,
        JSON.stringify({ role: "user", content: marker, metadata: { is_user_input: true,
            extensions: { "chisel/client-message-id": "plan62-shared-message" } } }), 1700000000, "{}");
    database.close();
    fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT!);
    const uuid = "11111111-2222-3333-4444-555555555555";
    const desktopFilename = path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT!, `${uuid}.db`);
    const desktop = new DatabaseSync(desktopFilename);
    desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT)");
    desktop.prepare("INSERT INTO meta VALUES('info',?)").run(JSON.stringify({ cwd: workspace }));
    desktop.prepare("INSERT INTO messages VALUES(?,?,?)").run(1, "user_message", JSON.stringify({ content: [
        { content: { type: "text", text: marker }, _meta: { "cognition.ai/clientMessageId": "plan62-shared-message" } },
    ] }));
    desktop.close();
    const sourceBefore = fs.readFileSync(filename);
    const desktopBefore = fs.readFileSync(desktopFilename);
    const originalFork = childProcess.fork;
    let closes = 0;
    const observedFork = context.mock.method(childProcess, "fork", (...args: Parameters<typeof childProcess.fork>) => {
        const child = Reflect.apply(originalFork, childProcess, args);
        child.once("close", () => { closes++; });
        return child;
    });
    syncBuiltinESMExports();
    try {
        const coldMetadata = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", deadlineMs: 5000 });
        assert.deepEqual(new Set(coldMetadata.candidates.map(candidate => candidate.sourceKind)), new Set(["devin-cli", "devin-desktop"]));
        assert.equal(coldMetadata.partial, true, "a first cold lookup retains physical candidates until their alias is verified");
        assert.equal(observedFork.mock.callCount(), 1);
        assert.equal(closes, 1);
        const result = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", conversationIds: ["isolated-target"], contextProbe: marker,
            isCancelled: () => false, signal: new AbortController().signal, deadlineMs: 5000 });
        assert.deepEqual(result.candidates.map(item => item.id), ["isolated-target"]);
        assert.equal(result.candidates[0]?.uuid, uuid);
        assert.equal(observedFork.mock.callCount(), 2);
        assert.equal(closes, 2);
        assert.deepEqual(fs.readFileSync(filename), sourceBefore);
        assert.deepEqual(fs.readFileSync(desktopFilename), desktopBefore);
        const warmMetadata = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", deadlineMs: 5000 });
        assert.deepEqual(warmMetadata.candidates.map(candidate => candidate.sourceKind), ["devin-cli"]);
        assert.ok(warmMetadata.candidates[0]?.aliases?.includes(uuid), "a fresh worker retains the previously verified alias after rechecking unchanged sources");
        assert.equal(observedFork.mock.callCount(), 3);
        assert.equal(closes, 3);
        const expiredBeforeStart = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", deadlineAt: Date.now() - 1 });
        assert.equal(expiredBeforeStart.partial, true);
        assert.deepEqual(expiredBeforeStart.candidates, []);
        assert.equal(observedFork.mock.callCount(), 3);
        const controller = new AbortController();
        const pending = listConversationCandidates({ dataChains: ["windsurf"], source: "local", signal: controller.signal, deadlineMs: 5000 });
        const abortTimer = setTimeout(() => controller.abort(), 40);
        try {
            await assert.rejects(pending, error => (error as NodeJS.ErrnoException).code === "SOURCE_WORKER_CANCELLED");
        } finally { clearTimeout(abortTimer); }
        assert.equal(observedFork.mock.callCount(), 4);
        assert.equal(closes, 4);
        const expiredDuringRead = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", deadlineAt: Date.now() + 30, deadlineMs: 5000 });
        assert.equal(expiredDuringRead.partial, true);
        assert.equal(observedFork.mock.callCount(), 5);
        assert.equal(closes, 5);
        assert.deepEqual(fs.readFileSync(filename), sourceBefore);
        assert.deepEqual(fs.readFileSync(desktopFilename), desktopBefore);
        const writer = new DatabaseSync(desktopFilename);
        writer.prepare("UPDATE messages SET payload=? WHERE position=1").run(JSON.stringify({ content: [
            { content: { type: "text", text: marker }, _meta: { "cognition.ai/clientMessageId": "changed-unrelated-message" } },
        ] }));
        writer.close();
        assert.notDeepEqual(fs.readFileSync(desktopFilename), desktopBefore);
        const changedSource = fs.readFileSync(desktopFilename);
        const changedMetadata = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", deadlineMs: 5000 });
        assert.deepEqual(new Set(changedMetadata.candidates.map(candidate => candidate.sourceKind)), new Set(["devin-cli", "devin-desktop"]));
        assert.equal(changedMetadata.partial, true, "changed source identity evidence revokes the old alias association");
        assert.equal(changedMetadata.candidates.find(candidate => candidate.sourceKind === "devin-cli")?.aliases?.includes(uuid) || false, false);
        assert.equal(observedFork.mock.callCount(), 6);
        assert.equal(closes, 6);
        assert.deepEqual(fs.readFileSync(filename), sourceBefore);
        assert.deepEqual(fs.readFileSync(desktopFilename), changedSource);
    } finally {
        observedFork.mock.restore();
        syncBuiltinESMExports();
    }
});

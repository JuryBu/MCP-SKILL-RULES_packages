import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { listConversationCandidates, type ListConversationCandidatesResult, type UnifiedConversationCandidate } from "../src/conversation-filter.js";
import { locateConversationContext, type ConversationContextHit } from "../src/conversation-context-locate.js";

const marker = "a distinct owner statement for progressive candidate verification";
const candidate: UnifiedConversationCandidate = {
    id: "recent-conversation", dataChain: "windsurf", title: "Recent conversation", workspace: "example-workspace",
    updatedAt: "2026-01-02T00:00:00.000Z", detail: "synthetic fixture", contextProbe: [marker],
};
const hit: ConversationContextHit = {
    conversationId: candidate.id, dataChain: "windsurf", source: "message_body_hit", mode: "exact", roundIndex: 1,
    role: "user", snippet: marker, sourcePosition: { kind: "round", roundIndex: 1 }, freshness: "fresh",
};
const verified: ListConversationCandidatesResult = {
    candidates: [candidate], statuses: [{ dataChain: "windsurf", status: "ok", count: 2 }], partial: true,
    contextLocate: {
        status: "partial_found_scanning", scannedFiles: 1, totalFiles: 2, scannedBytes: 100, totalBytes: 100,
        hits: [hit], truncated: true, warnings: [], resolution: "single_match_in_partial_scan",
        matchedConversationCount: 1, matchIdentityScope: "listed_threads", scope: "provided_candidates",
    },
};

async function withWorker(mode: "partial" | "empty" | "fatal", run: (children: ChildProcess[]) => Promise<void>, onCheckpoint?: () => void): Promise<void> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-plan63-checkpoint-"));
    const file = path.join(directory, "worker.mjs");
    fs.writeFileSync(file, `process.once("message", () => {
        if (${JSON.stringify(mode)} !== "empty") {
            process.send({ type: "checkpoint-patch", patch: { type: "set", path: [], value: ${JSON.stringify(verified)} } });
            process.send({ type: "checkpoint-complete" });
        }
        if (${JSON.stringify(mode)} === "fatal") {
            process.send({ type: "error", name: "Error", code: "FIXTURE_CORRUPT_SOURCE", message: "synthetic source corruption" }, () => {
                process.exitCode = 1;
                process.disconnect();
            });
        } else {
            process.send({ type: "checkpoint-patch", patch: { type: "set", path: [], value: { candidates: [] } } });
            setInterval(() => {}, 100);
        }
    });`, "utf8");
    const originalFork = childProcess.fork;
    const children: ChildProcess[] = [];
    const stub = mock.method(childProcess, "fork", (...arguments_: Parameters<typeof childProcess.fork>) => {
        const child = originalFork(file, arguments_[1] as string[], arguments_[2]);
        children.push(child);
        child.on("message", (message: any) => {
            if (message.type === "checkpoint-complete") onCheckpoint?.();
        });
        return child;
    });
    syncBuiltinESMExports();
    try { await run(children); }
    finally {
        stub.mock.restore();
        syncBuiltinESMExports();
        for (const child of children) {
            if (child.exitCode !== null || child.signalCode !== null) continue;
            await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); });
        }
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test("a verified checkpoint survives a later worker deadline and an unfinished checkpoint", async () => {
    await withWorker("partial", async children => {
        const result = await listConversationCandidates({ dataChains: ["windsurf"], contextProbe: marker, deadlineMs: 1200 });
        assert.deepEqual(result.candidates.map(item => item.id), [candidate.id]);
        assert.equal(result.partial, true);
        assert.equal(result.contextLocate?.status, "partial_found_scanning");
        assert.equal(result.contextLocate?.resolution, "single_match_in_partial_scan");
        assert.equal(result.contextLocate?.scannedFiles, 1);
        assert.equal(result.contextLocate?.totalFiles, 2);
        assert.equal(children.length, 1);
        assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    });
});

test("a deadline without a verified checkpoint returns explicit incomplete coverage", async () => {
    await withWorker("empty", async children => {
        const result = await listConversationCandidates({ dataChains: ["codex", "claude-code", "antigravity", "dsh"], contextProbe: marker, deadlineMs: 1200 });
        assert.deepEqual(result.candidates, []);
        assert.equal(result.partial, true);
        assert.equal(result.contextLocate?.status, "budget_exhausted");
        assert.equal(result.contextLocate?.resolution, "unverified");
        assert.equal(result.contextLocate?.scannedFiles, 0);
        assert.equal(result.statuses.length, 4);
        assert.ok(result.statuses.every(status => status.partial && status.status === "failed"));
        assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    });
});

test("a deadline before admission returns incomplete coverage without spawning a worker", async () => {
    const result = await listConversationCandidates({ dataChains: ["windsurf"], contextProbe: marker, deadlineAt: Date.now() - 1 });
    assert.equal(result.partial, true);
    assert.equal(result.contextLocate?.status, "budget_exhausted");
    assert.equal(result.contextLocate?.scannedFiles, 0);
});

test("user cancellation after a verified checkpoint still cancels rather than returning success", async () => {
    const controller = new AbortController();
    await withWorker("partial", async children => {
        await assert.rejects(listConversationCandidates({ dataChains: ["windsurf"], contextProbe: marker, deadlineMs: 5000, signal: controller.signal }),
            (error: NodeJS.ErrnoException) => error.code === "SOURCE_WORKER_CANCELLED");
        assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    }, () => { setTimeout(() => controller.abort(), 20); });
});

test("a fatal source error is not converted to a successful partial result", async () => {
    await withWorker("fatal", async () => {
        await assert.rejects(listConversationCandidates({ dataChains: ["windsurf"], contextProbe: marker, deadlineMs: 5000 }),
            (error: NodeJS.ErrnoException) => error.code === "FIXTURE_CORRUPT_SOURCE");
    });
});

test("probes publish per-candidate evidence and bound a candidate below the whole scan budget", async () => {
    const checkpoints: number[] = [];
    const budgets: number[] = [];
    const result = await locateConversationContext([candidate, { ...candidate, id: "older-conversation" }], marker, {
        probe: true, deadlineMs: 12000,
        adapters: {
            readRounds: async () => ({ rounds: [] }),
            scanStream: async (current, query, budget) => {
                assert.equal(query, marker);
                budgets.push(budget.deadlineAt - Date.now());
                return { hits: current.id === candidate.id ? [hit] : [], scannedBytes: 100 };
            },
        },
        onCheckpoint: checkpoint => { checkpoints.push(checkpoint.scannedFiles); },
    });
    assert.deepEqual(checkpoints, [1, 2]);
    assert.ok(budgets.every(budget => budget > 0 && budget <= 3000));
    assert.equal(result.status, "found");
    assert.equal(result.scannedFiles, 2);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { discoverClaudeCodeThreads } from "../src/claude-code-client.ts";

const target = "00000000-0000-4000-8000-000000000061";
const unrelated = "00000000-0000-4000-8000-000000000062";
const line = (id: string, cwd: string) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "synthetic request " + id } }) + "\n";

function fixture(context: TestContext): { root: string; project: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan63-log-claude-"));
    const previousHome = process.env.MEMORY_STORE_CLAUDE_HOME;
    const previousDesktop = process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS;
    const previousData = process.env.MEMORY_STORE_DATA_ROOT;
    process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
    process.env.MEMORY_STORE_CLAUDE_HOME = root;
    process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS = path.join(root, "desktop");
    const project = path.join(root, "projects", "synthetic-project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, target + ".jsonl"), line(target, root));
    fs.writeFileSync(path.join(project, unrelated + ".jsonl"), line(unrelated, root));
    context.after(() => {
        if (previousHome === undefined) delete process.env.MEMORY_STORE_CLAUDE_HOME; else process.env.MEMORY_STORE_CLAUDE_HOME = previousHome;
        if (previousDesktop === undefined) delete process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS; else process.env.MEMORY_STORE_CLAUDE_DESKTOP_INDEX_ROOTS = previousDesktop;
        if (previousData === undefined) delete process.env.MEMORY_STORE_DATA_ROOT; else process.env.MEMORY_STORE_DATA_ROOT = previousData;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, project };
}

test("Claude Code explicit IDs do not open unrelated transcripts through the production backend", async context => {
    const { root, project } = fixture(context);
    const { createLogHostBackend } = await import("../src/conversation-host-logs.ts");
    const opened = new Set<string>();
    const original = fs.promises.open;
    fs.promises.open = (async (...arguments_: Parameters<typeof original>) => {
        const filename = String(arguments_[0]);
        if (filename.startsWith(project) && filename.endsWith(".jsonl")) opened.add(path.basename(filename));
        return original(...arguments_);
    }) as typeof original;
    try {
        const backend = createLogHostBackend("claude-code", { cacheRoot: path.join(root, "cache") });
        const candidates = await backend.list({ conversationIds: [target], workspaces: [root], workspaceMode: "exact" }, {});
        assert.deepEqual(candidates.map(candidate => candidate.id), [target]);
        assert.deepEqual([...opened], [target + ".jsonl"]);
        assert.equal(backend.sourceStatuses!()[0]!.status, "ok");
    } finally { fs.promises.open = original; }
});

test("Claude Code discovery returns bounded partial metadata and an expired request reads nothing", async context => {
    const { root } = fixture(context);
    const { createLogHostBackend } = await import("../src/conversation-host-logs.ts");
    const entries = await discoverClaudeCodeThreads({ maxEntries: 2 });
    assert.equal(entries.threads.length, 1);
    assert.equal(entries.partial, true);
    const bounded = await discoverClaudeCodeThreads({ maxBytes: 8 });
    assert.ok(bounded.scannedBytes <= 8);
    assert.equal(bounded.partial, true);
    const expired = await discoverClaudeCodeThreads({ deadlineMs: 0 });
    assert.equal(expired.scannedBytes, 0);
    assert.equal(expired.partial, true);
    assert.ok(expired.warnings.some(warning => warning.includes("deadline")));
    const backend = createLogHostBackend("claude-code", { cacheRoot: path.join(root, "cache") });
    assert.deepEqual(await backend.list({}, { deadlineAt: 0 }), []);
    assert.equal(backend.sourceStatuses!()[0]!.status, "partial");
});

test("Claude Code cancellation stops metadata reads and a new request remains usable", async context => {
    fixture(context);
    let cancelled = false;
    let reads = 0;
    await assert.rejects(discoverClaudeCodeThreads({ isCancelled: () => cancelled, onProgress: () => { reads += 1; cancelled = true; } }), error => (error as Error).name === "AbortError");
    assert.equal(reads, 1);
    assert.equal((await discoverClaudeCodeThreads({ conversationIds: [target] })).threads.length, 1);
});

test("Claude Code duplicate exact files remain ambiguous", async context => {
    const { root } = fixture(context);
    const duplicate = path.join(root, "projects", "duplicate");
    fs.mkdirSync(duplicate);
    fs.writeFileSync(path.join(duplicate, target + ".jsonl"), line(target, root));
    const result = await discoverClaudeCodeThreads({ conversationIds: [target] });
    assert.equal(result.threads.length, 0);
    assert.equal(result.partial, true);
    assert.ok(result.warnings.some(warning => warning.includes("duplicate_id")));
});

test("Claude Code targeted metadata preserves desktop titles and ownership fields", async context => {
    const { root } = fixture(context);
    const directory = path.join(root, "desktop", "synthetic-account", "synthetic-organization");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "local_synthetic.json"), JSON.stringify({ cliSessionId: target, title: "Synthetic desktop title", cwd: root,
        lastActivityAt: "2026-01-01T00:00:00.000Z", isArchived: true }));
    const discovered = await discoverClaudeCodeThreads({ conversationIds: [target] });
    assert.equal(discovered.threads.length, 1);
    assert.equal(discovered.threads[0]!.title, "Synthetic desktop title");
    assert.equal(discovered.threads[0]!.isArchived, true);
    assert.equal(discovered.threads[0]!.accountId, "synthetic-account");
    assert.equal(discovered.partial, false);
});

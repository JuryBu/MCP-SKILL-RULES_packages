import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { after, test } from "node:test";
import { readRoleExcludedCodexProjection } from "../src/conversation-corpus-reader-role-proof.ts";
import type { CorpusConversation, CorpusReadControl } from "../src/conversation-corpus-types.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-role-proof-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const threadId = "10000000-0000-4000-8000-000000000001";
const baseId = "20000000-0000-4000-8000-000000000001";
const leafId = "20000000-0000-4000-8000-000000000002";
const child = { subagent: { thread_spawn: { parent_thread_id: "30000000-0000-4000-8000-000000000001" } } };
let fixtureNumber = 0;

function fixture(source: unknown = child, baseSource?: unknown) {
    const root = path.join(temporary, String(++fixtureNumber));
    fs.mkdirSync(root);
    const header = (origin: unknown, base?: unknown) => JSON.stringify({ type: "session_meta", payload: {
        id: threadId, ...(origin !== undefined ? { source: origin } : {}), ...(base ? { history_base: base } : {}),
    } }) + "\n";
    const pathsByRolloutId = new Map<string, string[]>();
    let basePath: string | undefined;
    let base: unknown;
    if (baseSource !== undefined) {
        basePath = path.join(root, `rollout-2026-01-01T00-00-00-${threadId}_${baseId}.jsonl`);
        const prefix = header(baseSource);
        fs.writeFileSync(basePath, prefix + "excluded invalid JSON body\n");
        pathsByRolloutId.set(baseId, [basePath]);
        base = { thread_id: baseId, end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(prefix) };
    }
    const leafPath = path.join(root, `rollout-2026-01-01T00-00-00-${threadId}_${leafId}.jsonl`);
    fs.writeFileSync(leafPath, header(source, base) + "excluded invalid JSON body\n");
    pathsByRolloutId.set(leafId, [leafPath]);
    const conversation: CorpusConversation = { id: threadId, title: "synthetic", workspace: root, rolloutPath: leafPath, source: "codex" };
    const options = { roots: [root], pathsByRolloutId };
    return { root, leafPath, basePath, conversation, options, read: (control: CorpusReadControl = {}) => readRoleExcludedCodexProjection(conversation, control, options) };
}

test("pure subagent chain returns requested-role proof without parsing excluded body or writing cache", async () => {
    const sample = fixture(child, child);
    const before = fs.readdirSync(sample.root).sort();
    const result = await sample.read();
    assert.ok(result);
    assert.deepEqual(result.messages, []);
    assert.equal(result.complete, true);
    assert.equal(result.requestedRangeComplete, undefined);
    assert.equal(result.cacheGeneration, undefined);
    assert.equal(result.sourceBytes, undefined);
    assert.equal(result.projectionKind, "requested-role-exclusion");
    assert.equal(result.roleExclusion.sourceContentValidated, false);
    assert.equal(result.roleExclusion.fullBodyCachePrepared, false);
    assert.equal(result.roleExclusion.segments.length, 2);
    assert.equal(result.sourceIdentities.length, 2);
    assert.ok(result.roleExclusion.segments[0]!.endByte);
    assert.match(result.revision, /^role-excluded:[a-f0-9]{64}$/u);
    assert.equal((await sample.read())!.revision, result.revision);
    assert.ok(result.warnings.includes("source_content_not_validated"));
    assert.deepEqual(fs.readdirSync(sample.root).sort(), before);
});

test("literal and serialized subagent sources are accepted, including a single requested role", async () => {
    for (const source of ["subagent", JSON.stringify(child), JSON.stringify("subagent")]) {
        const result = await fixture(source).read({ messageRoles: ["user"] });
        assert.ok(result);
        assert.deepEqual(result.roleExclusion.requestedRoles, ["user"]);
    }
});

test("main inherited ancestor requires ordinary scan even when selected child metadata says child", async () => {
    const sample = fixture(child, "cli");
    sample.conversation.isChildThread = true;
    sample.conversation.agentRole = "reviewer";
    assert.equal(await sample.read(), null);
});

test("CLI plus parent id or agent role alone is not explicit subagent evidence", async () => {
    const sample = fixture("cli");
    const record = JSON.parse(fs.readFileSync(sample.leafPath, "utf8").split("\n")[0]!);
    record.payload.parent_thread_id = "30000000-0000-4000-8000-000000000001";
    record.payload.agent_role = "reviewer";
    fs.writeFileSync(sample.leafPath, JSON.stringify(record) + "\nnot JSON\n");
    assert.equal(await sample.read(), null);
});

test("unknown and malformed origin metadata falls back conservatively", async () => {
    for (const source of [null, "unknown", "{not-json", {}, { subagent: null }, { agentRole: "reviewer" }]) assert.equal(await fixture(source).read(), null);
    assert.equal(await fixture(child, {}).read(), null);
});

test("requests including subagent or tool, and empty roles, fall back before filesystem reads", async () => {
    const sample = fixture();
    sample.conversation.rolloutPath = path.join(sample.root, "missing.jsonl");
    for (const roles of [["subagent"], ["user", "subagent"], ["tool"], ["assistant", "tool"], []] as CorpusReadControl["messageRoles"][]) assert.equal(await sample.read({ messageRoles: roles }), null);
});

test("compressed source and matching replica headers are role-proved without body equality claims", async context => {
    const compress = (zlib as unknown as { zstdCompressSync?: (value: Buffer) => Buffer }).zstdCompressSync;
    if (!compress) { context.skip("native zstd compression unavailable"); return; }
    const sample = fixture();
    const compressedPath = `${sample.leafPath}.zst`;
    const header = fs.readFileSync(sample.leafPath, "utf8").split("\n")[0]!;
    fs.writeFileSync(compressedPath, compress(Buffer.from(`${header}\n${"invalid JSON excluded body\n".repeat(5000)}`)));
    sample.conversation.rolloutPath = compressedPath;
    const result = await sample.read();
    assert.ok(result);
    assert.equal(result.sourceIdentities.length, 2);
    assert.ok(result.warnings.includes("replica_bodies_not_compared"));
    assert.equal(result.roleExclusion.sourceContentValidated, false);
    fs.unlinkSync(sample.leafPath);
    assert.ok(await sample.read());
});

test("conflicting replica metadata fails rather than publishing a role proof", async context => {
    const compress = (zlib as unknown as { zstdCompressSync?: (value: Buffer) => Buffer }).zstdCompressSync;
    if (!compress) { context.skip("native zstd compression unavailable"); return; }
    const sample = fixture();
    const record = JSON.parse(fs.readFileSync(sample.leafPath, "utf8").split("\n")[0]!);
    record.payload.source = "cli";
    fs.writeFileSync(`${sample.leafPath}.zst`, compress(Buffer.from(JSON.stringify(record) + "\nexcluded\n")));
    await assert.rejects(sample.read(), /replica metadata/u);
});

test("source drift before completion is an error and produces no projection", async () => {
    const sample = fixture();
    let changed = false;
    await assert.rejects(sample.read({ onProgress: () => {
        if (!changed) { changed = true; fs.appendFileSync(sample.leafPath, "changed\n"); }
    } }), /changed/u);
});

test("ancestor and replica drift are also rejected", async context => {
    const sample = fixture(child, child);
    await assert.rejects(sample.read({ onProgress: () => fs.appendFileSync(sample.basePath!, "changed\n") }), /changed/u);
    const compress = (zlib as unknown as { zstdCompressSync?: (value: Buffer) => Buffer }).zstdCompressSync;
    if (!compress) { context.skip("native zstd compression unavailable"); return; }
    const replicated = fixture();
    const replicaPath = `${replicated.leafPath}.zst`;
    fs.writeFileSync(replicaPath, compress(fs.readFileSync(replicated.leafPath)));
    await assert.rejects(replicated.read({ onProgress: () => fs.appendFileSync(replicaPath, Buffer.from([0])) }), /changed/u);
});

test("cancellation is preserved before I/O and after header progress, including archive cancellation", async () => {
    const sample = fixture();
    await assert.rejects(sample.read({ isCancelled: () => true }), { name: "AbortError" });
    let cancelled = false;
    await assert.rejects(sample.read({ isCancelled: () => cancelled, onProgress: () => { cancelled = true; } }), { name: "AbortError" });
    await assert.rejects(readRoleExcludedCodexProjection(sample.conversation, {}, { ...sample.options, archive: { isCancelled: () => true } }), { name: "AbortError" });
});

test("role and physical changes produce new revisions on a later call", async () => {
    const sample = fixture();
    const first = await sample.read();
    const single = await sample.read({ messageRoles: ["assistant"] });
    assert.ok(first && single);
    assert.notEqual(single.revision, first.revision);
    fs.appendFileSync(sample.leafPath, "still excluded\n");
    const appended = await sample.read();
    assert.ok(appended);
    assert.notEqual(appended.revision, first.revision);
});

test("conversation mismatch and impossible adopted byte boundaries are errors", async () => {
    const sample = fixture();
    sample.conversation.id = baseId;
    await assert.rejects(sample.read(), /identity mismatch/u);
    const bounded = fixture(child, child);
    const record = JSON.parse(fs.readFileSync(bounded.leafPath, "utf8").split("\n")[0]!);
    record.payload.history_base.end_byte_offset = fs.statSync(bounded.basePath!).size + 1;
    fs.writeFileSync(bounded.leafPath, JSON.stringify(record) + "\nexcluded\n");
    await assert.rejects(bounded.read(), /bounds exceed/u);
});

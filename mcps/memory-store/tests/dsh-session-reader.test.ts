import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import {
    DshSessionReaderError,
    listDshSessionSnapshots,
    readDshSession,
    resolveDshSessionsRoot,
} from "../src/dsh-session-reader.ts";

const zstd = zlib as unknown as { zstdCompressSync?: (input: Uint8Array) => Uint8Array };

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function header(id: string, version = 0): Record<string, unknown> {
    return { type: "session", version, id, created: "2026-08-14T00:00:00.000Z" };
}

function textEvent(seq: number, text = "hello"): Record<string, unknown> {
    return { type: "assistant/chunk", seq, time: 1000 + seq, data: { turn: 0, step: 0, chunk: { type: "text-delta", index: 0, text } } };
}

function reasoningEvent(seq: number): Record<string, unknown> {
    return { type: "assistant/chunk", seq, time: 1000 + seq, data: { turn: 0, step: 0, chunk: { type: "reasoning-delta", index: 1, text: "think" } } };
}

function toolEvent(seq: number): Record<string, unknown> {
    return { type: "assistant/chunk", seq, time: 1000 + seq, data: { turn: 0, step: 0, chunk: { type: "tool-call-delta", index: 2, id: "call-1", name: "read_file", argumentsDelta: "{\"path\":\"a.txt\"}" } } };
}

async function sessionPath(root: string, project: string, session: string, file = "session.jsonl"): Promise<string> {
    const directory = path.join(root, project, session);
    await mkdir(directory, { recursive: true });
    return path.join(directory, file);
}

async function expectReject(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
    await assert.rejects(action, error => error instanceof DshSessionReaderError && pattern.test(error.message));
}

function compress(value: string): Buffer {
    assert.equal(typeof zstd.zstdCompressSync, "function", "Node v24 must expose zstdCompressSync");
    return Buffer.from(zstd.zstdCompressSync!(Buffer.from(value)));
}

async function run(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "dsh-session-reader-"));
    try {
        assert.equal(resolveDshSessionsRoot({ sessionsRoot: "explicit", env: { MEMORY_STORE_DSH_SESSIONS_ROOT: "env", DSH_HOME: "dsh" }, homeDir: "home" }), path.resolve("explicit"));
        assert.equal(resolveDshSessionsRoot({ env: { MEMORY_STORE_DSH_SESSIONS_ROOT: "env", DSH_HOME: "dsh" }, homeDir: "home" }), path.resolve("env"));
        assert.equal(resolveDshSessionsRoot({ env: { DSH_HOME: "dsh" }, homeDir: "home" }), path.resolve("dsh", "sessions"));
        assert.equal(resolveDshSessionsRoot({ env: {}, homeDir: "home" }), path.resolve("home", ".dsh", "sessions"));

        const rawPath = await sessionPath(root, "raw-project", "raw-directory");
        await writeFile(rawPath, `${line(header("raw-id"))}${line(textEvent(0))}${line(reasoningEvent(1))}${line(toolEvent(2))}`, "utf8");
        const raw = await readDshSession("raw-id", { sessionsRoot: root });
        assert.equal(raw.events.length, 3);
        assert.deepEqual(raw.events[0], textEvent(0));
        assert.deepEqual(raw.events[2], toolEvent(2));
        assert.equal(raw.provenance.format, "jsonl");

        const zstdPath = await sessionPath(root, "zstd-project", "zstd-directory", "session.jsonl.zstd");
        await writeFile(zstdPath, Buffer.concat([compress(line(header("zstd-id"))), compress(line(textEvent(0, "first"))), compress(line(reasoningEvent(1))), compress(line(toolEvent(2)))]));
        const multiFrame = await readDshSession("zstd-id", { sessionsRoot: root });
        assert.equal(multiFrame.events.length, 3);
        assert.equal((multiFrame.events[0].data as { chunk: { text: string } }).chunk.text, "first");
        assert.equal(multiFrame.provenance.format, "jsonl.zstd");

        const packedPath = await sessionPath(root, "packed-project", "packed-directory");
        const packedRows = [
            { type: "text-chunks", seq0: 7, time0: 42, data: { turn: 2, step: 3, index: 4, dt: [3], texts: ["pack", "ed"] } },
            { type: "reasoning-chunks", seq0: 9, time0: 50, data: { turn: 2, step: 3, index: 5, dt: [2], texts: ["rea", "son"] } },
            { type: "tool-call-chunks", seq0: 11, time0: 60, data: { turn: 2, step: 3, index: 6, id: "call-2", name: "lookup", dt: [1], args: ["{\"q\":", "\"x\"}"] } },
        ];
        await writeFile(packedPath, line(header("packed-id")) + packedRows.map(line).join(""), "utf8");
        const packed = await readDshSession({ sessionId: "packed-id", sessionsRoot: root });
        assert.deepEqual(packed.events.slice(0, 2), [
            { type: "assistant/chunk", seq: 7, time: 42, data: { turn: 2, step: 3, chunk: { type: "text-delta", index: 4, text: "pack" } } },
            { type: "assistant/chunk", seq: 8, time: 45, data: { turn: 2, step: 3, chunk: { type: "text-delta", index: 4, text: "ed" } } },
        ]);
        assert.equal((packed.events[2].data as { chunk: { type: string; text: string } }).chunk.type, "reasoning-delta");
        assert.deepEqual((packed.events[5].data as { chunk: Record<string, unknown> }).chunk, {
            type: "tool-call-delta",
            index: 6,
            id: "call-2",
            name: "lookup",
            argumentsDelta: "\"x\"}",
        });

        const malformedPackedPath = await sessionPath(root, "malformed-packed-project", "malformed-packed-directory");
        await writeFile(malformedPackedPath, `${line(header("malformed-packed-id"))}${line({ type: "reasoning-chunks", seq0: 0, time0: 42, data: { turn: 0, step: 0, index: 0, dt: [], texts: ["a", "b"] } })}`, "utf8");
        await expectReject(() => readDshSession("malformed-packed-id", { sessionsRoot: root }), /dt length does not match member count/);
        await rm(path.join(root, "malformed-packed-project"), { recursive: true, force: true });

        const partialRawPath = await sessionPath(root, "partial-raw-project", "partial-raw-directory");
        await writeFile(partialRawPath, `${line(header("partial-raw-id"))}${JSON.stringify(textEvent(0, "ignored"))}`, "utf8");
        const partialRaw = await readDshSession("partial-raw-id", { sessionsRoot: root });
        assert.equal(partialRaw.events.length, 0);
        assert.equal(partialRaw.provenance.ignoredTrailingTextRecord, true);

        const partialZstdPath = await sessionPath(root, "partial-zstd-project", "partial-zstd-directory", "session.jsonl.zstd");
        const partialFrame = compress(line(textEvent(0, "ignored")));
        await writeFile(partialZstdPath, Buffer.concat([compress(line(header("partial-zstd-id"))), partialFrame.subarray(0, partialFrame.length - 2)]));
        const partialZstd = await readDshSession("partial-zstd-id", { sessionsRoot: root });
        assert.equal(partialZstd.events.length, 0);
        assert.equal(partialZstd.provenance.ignoredTrailingZstdFrame, true);

        const futurePath = await sessionPath(root, "future-project", "future-directory");
        await writeFile(futurePath, line(header("future-id", 1)), "utf8");
        await expectReject(() => readDshSession("future-id", { sessionsRoot: root }), /unsupported DSH session version/);
        await rm(path.join(root, "future-project"), { recursive: true, force: true });

        const escapeRoot = await mkdtemp(path.join(tmpdir(), "dsh-session-reader-escape-"));
        try {
            const escapedSource = await sessionPath(escapeRoot, "outside-project", "outside-session");
            await writeFile(escapedSource, line(header("outside-id")), "utf8");
            await symlink(path.join(escapeRoot, "outside-project"), path.join(root, "escape-project"), "junction");
            const snapshots = await listDshSessionSnapshots({ sessionsRoot: root });
            assert.equal(snapshots.some(snapshot => snapshot.id === "outside-id"), false);
        } finally {
            await rm(escapeRoot, { recursive: true, force: true });
        }

        const duplicateOne = await sessionPath(root, "duplicate-project-one", "duplicate-one");
        const duplicateTwo = await sessionPath(root, "duplicate-project-two", "duplicate-two");
        await writeFile(duplicateOne, line(header("duplicate-id")), "utf8");
        await writeFile(duplicateTwo, line(header("duplicate-id")), "utf8");
        await expectReject(() => listDshSessionSnapshots({ sessionsRoot: root }), /duplicate DSH session id/);
        await rm(path.join(root, "duplicate-project-one"), { recursive: true, force: true });
        await rm(path.join(root, "duplicate-project-two"), { recursive: true, force: true });

        const stableFirst = await listDshSessionSnapshots({ sessionsRoot: root });
        const stableSecond = await listDshSessionSnapshots({ sessionsRoot: root });
        const first = stableFirst.find(snapshot => snapshot.id === "raw-id");
        const second = stableSecond.find(snapshot => snapshot.id === "raw-id");
        assert.ok(first && second);
        assert.equal(first.fingerprint, second.fingerprint);
        assert.equal(first.provenance.sourceSizeBytes, second.provenance.sourceSizeBytes);
        assert.equal((await readDshSession(first, { sessionsRoot: root })).fingerprint, first.fingerprint);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

await run();
console.log("dsh-session-reader tests passed");

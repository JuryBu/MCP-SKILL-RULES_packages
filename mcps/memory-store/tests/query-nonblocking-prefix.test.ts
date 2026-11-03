import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { readMemoryQueryPrefix } from "../src/memory-query-prefix.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-query-prefix-"));

after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("memory-store-query-prefix-"));
    await fs.rm(directory, { recursive: true, force: true });
});

test("prefix matches complete UTF-8 decoding followed by UTF-16 slice", async () => {
    const cases = [
        Buffer.alloc(0),
        Buffer.from("---\ntitle: 前言\n---\n猫咪🐈正文"),
        Buffer.from("\uFEFF" + "界".repeat(3500)),
        Buffer.from("界".repeat(1365) + "🐈" + "尾".repeat(2000)),
        Buffer.from("界".repeat(2999) + "🐈最后"),
        Buffer.concat([Buffer.from("前缀"), Buffer.from([0xe2, 0x28, 0xa1, 0xf0, 0x9f])]),
        Buffer.concat([Buffer.from("界".repeat(2999)), Buffer.from([0xf0, 0x9f, 0x90])]),
    ];
    for (const [index, content] of cases.entries()) {
        const filename = path.join(directory, `unicode-${index}.md`);
        await fs.writeFile(filename, content);
        assert.equal(await readMemoryQueryPrefix(filename, 3000), content.toString("utf8").slice(0, 3000));
    }
    const astral = await readMemoryQueryPrefix(path.join(directory, "unicode-4.md"), 3000);
    assert.equal(astral!.length, 3000);
    assert.equal(astral!.charCodeAt(2999), "🐈".charCodeAt(0));
});

test("large bodies have a bounded asynchronous read and close the handle", async context => {
    const filename = path.join(directory, "large.md");
    await fs.writeFile(filename, "prefixneedle " + "x".repeat(4 * 1024 * 1024));
    const originalOpen = fs.open;
    let bytesRead = 0;
    let closed = false;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        const originalClose = handle.close.bind(handle);
        context.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number | null) => {
            const result = await originalRead(buffer, offset, length, position);
            bytesRead += result.bytesRead;
            return result;
        });
        context.mock.method(handle, "close", async () => {
            closed = true;
            return originalClose();
        });
        return handle;
    });
    const prefix = await readMemoryQueryPrefix(filename, 3000);
    assert.equal(prefix, ("prefixneedle " + "x".repeat(3000)).slice(0, 3000));
    assert.ok(bytesRead >= 3000);
    assert.ok(bytesRead <= 9003, `read ${bytesRead} bytes for a 3000-unit prefix`);
    assert.equal(closed, true);
});

test("UTF-8 sequences survive partial byte reads", async context => {
    const filename = path.join(directory, "short-reads.md");
    const content = Buffer.from("汉🐈字\uFEFF终结");
    await fs.writeFile(filename, content);
    const originalOpen = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        context.mock.method(handle, "read", (buffer: Buffer, offset: number, length: number, position: number | null) => {
            return originalRead(buffer, offset, Math.min(length, 1), position);
        });
        return handle;
    });
    assert.equal(await readMemoryQueryPrefix(filename, 6), content.toString("utf8").slice(0, 6));
});

test("absent files and a non-directory parent remain empty candidates", async () => {
    assert.equal(await readMemoryQueryPrefix(path.join(directory, "absent.md"), 3000), null);
    const regularFile = path.join(directory, "regular-file");
    await fs.writeFile(regularFile, "plain");
    assert.equal(await readMemoryQueryPrefix(path.join(regularFile, "entry.md"), 3000), null);
});

test("permission failures propagate instead of looking like an empty file", async context => {
    const failure = Object.assign(new Error("prefix permission denied"), { code: "EACCES" });
    context.mock.method(fs, "open", async () => { throw failure; });
    await assert.rejects(readMemoryQueryPrefix("permission-fixture.md", 3000), error => error === failure);
});

test("read failures still close the file handle", async context => {
    const filename = path.join(directory, "read-error.md");
    await fs.writeFile(filename, "read error fixture");
    const originalOpen = fs.open;
    const failure = Object.assign(new Error("prefix read failed"), { code: "EIO" });
    let closed = false;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        const originalClose = handle.close.bind(handle);
        context.mock.method(handle, "read", async () => { throw failure; });
        context.mock.method(handle, "close", async () => {
            closed = true;
            return originalClose();
        });
        return handle;
    });
    await assert.rejects(readMemoryQueryPrefix(filename, 3000), error => error === failure);
    assert.equal(closed, true);
});

test("invalid prefix lengths fail before opening a file", async () => {
    for (const limit of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(readMemoryQueryPrefix("unused-fixture.md", limit), RangeError);
    }
});

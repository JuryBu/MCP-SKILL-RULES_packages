import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLocalPbCandidates, fingerprintLocalPbCandidates, loadLocalPbConversation } from "../src/conversation-source-adapters.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-pb-fingerprint-"));
const activeRoot = path.join(temporary, "active");
const implicitRoot = path.join(temporary, "implicit");
const key = Buffer.from("0123456789abcdef0123456789abcdef");
const environmentKeys = ["MEMORY_STORE_LOCAL_PB_KEY", "MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT", "MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT"];
const originalEnvironment = new Map(environmentKeys.map(name => [name, process.env[name]]));
const conversationId = "fingerprint-fixture";
const activePath = path.join(activeRoot, conversationId + ".pb");
const implicitPath = path.join(implicitRoot, conversationId + ".pb");

function varint(value: number): Buffer {
    const bytes: number[] = [];
    do { bytes.push((value & 127) | (value >= 128 ? 128 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
}

function field(fieldNumber: number, value: string | Buffer): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    return Buffer.concat([varint(fieldNumber * 8 + 2), varint(bytes.length), bytes]);
}

function encrypted(userText: string): Buffer {
    const plaintext = Buffer.concat([field(1, conversationId), field(2, field(19, field(1, userText)))]);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

const fingerprint = () => fingerprintLocalPbCandidates(discoverLocalPbCandidates("antigravity", conversationId), "antigravity");
try {
    fs.mkdirSync(activeRoot);
    fs.mkdirSync(implicitRoot);
    process.env.MEMORY_STORE_LOCAL_PB_KEY = key.toString("base64");
    process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = activeRoot;
    process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = implicitRoot;
    fs.writeFileSync(activePath, encrypted("alpha"));
    fs.writeFileSync(implicitPath, Buffer.alloc(20, 1));
    const original = fs.statSync(activePath);
    const first = fingerprint();
    const loaded = loadLocalPbConversation("antigravity", conversationId)!;
    assert.equal(loaded.rounds[0]!.userMessage, "alpha");
    assert.equal(loaded.partial, true);
    assert.equal(loaded.fingerprint.revision, first.revision);
    assert.equal(fingerprint().revision, first.revision);
    fs.writeFileSync(activePath, encrypted("bravo"));
    fs.utimesSync(activePath, original.atime, original.mtime);
    const changed = fingerprint();
    assert.equal(fs.statSync(activePath).size, original.size);
    assert.notEqual(changed.revision, first.revision);
    assert.equal(loadLocalPbConversation("antigravity", conversationId)!.rounds[0]!.userMessage, "bravo");
    const implicitStat = fs.statSync(implicitPath);
    fs.writeFileSync(implicitPath, Buffer.alloc(20, 2));
    fs.utimesSync(implicitPath, implicitStat.atime, implicitStat.mtime);
    assert.notEqual(fingerprint().revision, changed.revision);
    console.log("PASS authenticated PB fingerprints bind decoded bytes and changed failed candidates despite equal size/mtime");
} finally {
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
}

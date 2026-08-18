import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConversationData } from "../src/conversation-bridge.ts";
import {
    compareConversationRoundCompleteness,
    discoverLocalPbCandidates,
    loadLocalPbConversation,
    localPbResultToRounds,
} from "../src/conversation-source-adapters.ts";
import {
    resetConversationSourceCacheForTests,
    setConversationSourceCacheDataRootForTests,
} from "../src/conversation-source-cache.ts";
import {
    LocalPbReaderError,
    decryptLocalPb,
    readLocalPbCandidate,
    readLocalPbCandidates,
} from "../src/local-pb-reader.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function varint(value: bigint | number): Buffer {
    let current = typeof value === "bigint" ? value : BigInt(value);
    const bytes: number[] = [];
    do {
        const byte = Number(current & 0x7fn);
        current >>= 7n;
        bytes.push(current === 0n ? byte : byte | 0x80);
    } while (current !== 0n);
    return Buffer.from(bytes);
}

function fieldVarint(fieldNumber: number, value: bigint | number): Buffer {
    return Buffer.concat([varint((fieldNumber << 3) | 0), varint(value)]);
}

function fieldBytes(fieldNumber: number, value: Buffer | string): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    return Buffer.concat([varint((fieldNumber << 3) | 2), varint(bytes.byteLength), bytes]);
}

function encrypted(plaintext: Buffer, key = KEY): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function step(options: {
    user?: string;
    response?: string;
    thinking?: string;
    modifiedResponse?: string;
    system?: string;
    marker?: string;
    toolName?: string;
    seconds?: number;
    contextTokens?: number;
}): Buffer {
    const fields: Buffer[] = [];
    if (options.seconds !== undefined) {
        const timestamp = Buffer.concat([fieldVarint(1, options.seconds), fieldVarint(2, 123_000_000)]);
        fields.push(fieldBytes(4, timestamp));
    }
    if (options.contextTokens !== undefined) fields.push(fieldBytes(5, fieldVarint(25, options.contextTokens)));
    if (options.user) fields.push(fieldBytes(19, fieldBytes(1, options.user)));
    if (options.response || options.thinking || options.modifiedResponse) {
        const planner = Buffer.concat([
            ...(options.response ? [fieldBytes(1, options.response)] : []),
            ...(options.thinking ? [fieldBytes(2, options.thinking)] : []),
            ...(options.modifiedResponse ? [fieldBytes(3, options.modifiedResponse)] : []),
        ]);
        fields.push(fieldBytes(20, planner));
    }
    if (options.system) fields.push(fieldBytes(114, fieldBytes(1, options.system)));
    if (options.marker) fields.push(fieldBytes(60, fieldBytes(1, options.marker)));
    if (options.toolName) fields.push(fieldBytes(25, Buffer.concat([fieldBytes(1, options.toolName), fieldBytes(2, "raw-tool-argument")] )));
    return Buffer.concat(fields);
}

function trajectory(id: string, steps: Buffer[]): Buffer {
    return Buffer.concat([fieldBytes(1, id), ...steps.map(item => fieldBytes(2, item))]);
}

const activePlaintext = trajectory("active-trajectory", [step({
    user: "你好，active 用户",
    response: "response 保留",
    thinking: "thinking 保留",
    modifiedResponse: "modified 保留",
    system: "system 保留",
    toolName: "tool.variant",
    marker: "checkpoint partial",
    seconds: 1_704_067_200,
    contextTokens: 215_023,
})]);
const implicitPlaintext = fieldBytes(1, trajectory("implicit-trajectory", [step({ user: "implicit 历史", response: "隐式回复" })]));

{
    const result = readLocalPbCandidate({ kind: "active", encrypted: encrypted(activePlaintext) }, {
        sourceFlavor: "windsurf",
        key: KEY,
    });
    const parsed = result.trajectory.steps[0];
    assert.equal(result.sourceFlavor, "windsurf");
    assert.equal(result.trajectory.id, "active-trajectory");
    assert.equal(parsed.user, "你好，active 用户");
    assert.deepEqual(parsed.planner, { response: "response 保留", thinking: "thinking 保留", modifiedResponse: "modified 保留" });
    assert.equal(parsed.system, "system 保留");
    assert.equal(parsed.timestamp?.seconds, "1704067200");
    assert.equal(parsed.timestamp?.iso, "2024-01-01T00:00:00.123Z");
    assert.equal(parsed.contextTokens, 215_023, "WSF/Antigravity context tokens must be decoded from nested f5.f25");
    const toolVariant = parsed.toolVariants.find(item => item.variantName === "field_25");
    assert.equal(toolVariant?.rawSubfields[0].text, "tool.variant");
    assert.deepEqual(parsed.diagnostics.map(item => item.kind).sort(), ["checkpoint", "partial", "unknown_variant"]);
}

{
    const result = readLocalPbCandidate({
        kind: "active",
        encrypted: encrypted(trajectory("planner-projection", [step({
            user: "用户问题",
            modifiedResponse: "The user wants me to inspect the source-only reasoning field.",
            toolName: "wire.variant",
        })])),
    }, {
        sourceFlavor: "windsurf",
        key: KEY,
    });
    const [round] = localPbResultToRounds(result);
    assert.equal(round.aiResponses[0]?.response, "", "WSF local PB reasoning-only planner field must not become a visible AI response");
    assert.match(round.aiResponses[0]?.thinking || "", /source-only reasoning/u, "reasoning-only planner field must be preserved as thinking");
    assert.equal(round.toolCalls.length, 0, "unmapped local PB wire variants must not become semantic tool calls");
    assert.equal(
        round.semanticEvents?.some(event => event.kind === "pb_wire_variant" && event.name === "field_25"),
        true,
        "unmapped local PB wire variants must remain diagnosable",
    );
}

{
    const inlinePngBase64 = `iVBORw0KGgo${"A".repeat(700)}`;
    const result = readLocalPbCandidate({
        kind: "active",
        encrypted: encrypted(trajectory("inline-image", [step({ user: inlinePngBase64 })])),
    }, {
        sourceFlavor: "windsurf",
        key: KEY,
    });
    const [round] = localPbResultToRounds(result);
    assert.doesNotMatch(round.userMessage, /iVBORw0KGgo/u, "local PB inline image base64 must be omitted from user-visible text");
    assert.match(round.userMessage, /inline image base64 omitted/u, "local PB inline image base64 should leave a compact placeholder");
    assert.equal(round.attachments?.[0]?.mimeType, "image/png", "local PB inline image placeholder should retain image provenance");
    assert.equal(round.userMessages?.[0]?.attachments?.[0]?.source, "local-pb-inline-base64");
    assert.equal(
        compareConversationRoundCompleteness([round], [{
            ...round,
            userMessage: "",
            userMessages: [{ ...round.userMessages![0], text: "" }],
        }]),
        "equal",
        "local PB inline image placeholders must not create a false PB/LS text conflict",
    );
    assert.equal(
        compareConversationRoundCompleteness([{
            ...round,
            userMessage: "markdown",
            userMessages: [{ ...round.userMessages![0], text: "markdown" }],
            attachments: [],
        }], [{
            ...round,
            userMessage: "",
            userMessages: [{ ...round.userMessages![0], text: "" }],
        }]),
        "equal",
        "local PB attachment format sentinels must not create a false PB/LS text conflict",
    );
}

{
    const outcomes = readLocalPbCandidates([
        { kind: "active", encrypted: encrypted(activePlaintext), label: "active" },
        { kind: "implicit", encrypted: encrypted(implicitPlaintext), label: "implicit" },
    ], { sourceFlavor: "antigravity", env: { TEST_LOCAL_PB_KEY: KEY.toString("base64") }, keyEnv: "TEST_LOCAL_PB_KEY" });
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].result?.sourceFlavor, "antigravity");
    assert.equal(outcomes[1].result?.trajectory.id, "implicit-trajectory");
    assert.equal(outcomes[1].result?.trajectory.steps[0].user, "implicit 历史");
}

{
    const textKey = "safeCodeiumworldKeYsecretBalloon";
    const payload = encrypted(activePlaintext, Buffer.from(textKey, "utf8"));
    assert.equal(decryptLocalPb(payload, { sourceFlavor: "windsurf" }).byteLength, activePlaintext.byteLength);
}

{
    const payload = encrypted(activePlaintext);
    assert.throws(() => decryptLocalPb(payload, { sourceFlavor: "windsurf", key: Buffer.alloc(32, 7) }), (error: unknown) => {
        return error instanceof LocalPbReaderError && error.code === "AUTH_FAILED";
    });
    assert.throws(() => decryptLocalPb(payload.subarray(0, 20), { sourceFlavor: "windsurf", key: KEY }), (error: unknown) => {
        return error instanceof LocalPbReaderError && error.code === "TRUNCATED";
    });
}

{
    const malformed = Buffer.concat([varint(10), varint(10), Buffer.from([1])]);
    assert.throws(() => readLocalPbCandidate({ kind: "active", encrypted: encrypted(malformed) }, { sourceFlavor: "windsurf", key: KEY }), (error: unknown) => {
        return error instanceof LocalPbReaderError && error.code === "TRUNCATED";
    });
    const unsafeLength = Buffer.concat([varint(10), Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02])]);
    assert.throws(() => readLocalPbCandidate({ kind: "active", encrypted: encrypted(unsafeLength) }, { sourceFlavor: "windsurf", key: KEY }), (error: unknown) => {
        return error instanceof LocalPbReaderError && error.code === "UNSAFE_VARINT";
    });
}

{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-local-pb-adapter-"));
    const activeRoot = path.join(root, "active");
    const implicitRoot = path.join(root, "implicit");
    const bridgeCacheRoot = path.join(root, "bridge-cache");
    const environmentKeys = [
        "MEMORY_STORE_LOCAL_PB_KEY",
        "MEMORY_STORE_LOCAL_PB_MAX_ENCRYPTED_BYTES",
        "MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT",
        "MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT",
    ] as const;
    const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
    try {
        fs.mkdirSync(activeRoot);
        fs.mkdirSync(implicitRoot);
        process.env.MEMORY_STORE_LOCAL_PB_KEY = KEY.toString("base64");
        process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = activeRoot;
        process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = implicitRoot;
        resetConversationSourceCacheForTests();
        setConversationSourceCacheDataRootForTests(bridgeCacheRoot);

        const oversizedCandidateId = "adapter-invalid-encrypted-limit";
        const defaultEncryptedLimitBytes = 96 * 1024 * 1024;
        const oversizedCandidatePath = path.join(activeRoot, `${oversizedCandidateId}.pb`);
        fs.closeSync(fs.openSync(oversizedCandidatePath, "w"));
        fs.truncateSync(oversizedCandidatePath, defaultEncryptedLimitBytes + 1);
        for (const invalidValue of ["Infinity", "NaN", "-1", "0", "1.5"]) {
            process.env.MEMORY_STORE_LOCAL_PB_MAX_ENCRYPTED_BYTES = invalidValue;
            assert.throws(
                () => discoverLocalPbCandidates("antigravity", oversizedCandidateId),
                new RegExp(`exceeds encrypted byte limit ${defaultEncryptedLimitBytes}`, "u"),
                `${invalidValue} must fall back to the encrypted local PB default byte limit`,
            );
        }

        for (const failure of [
            { suffix: "auth-failed", encrypted: encrypted(implicitPlaintext, Buffer.alloc(32, 7)), errorCode: "AUTH_FAILED" },
            { suffix: "truncated", encrypted: encrypted(implicitPlaintext).subarray(0, 20), errorCode: "TRUNCATED" },
        ] as const) {
            const conversationId = `adapter-partial-${failure.suffix}`;
            fs.writeFileSync(path.join(activeRoot, `${conversationId}.pb`), encrypted(activePlaintext));
            fs.writeFileSync(path.join(implicitRoot, `${conversationId}.pb`), failure.encrypted);

            const result = loadLocalPbConversation("antigravity", conversationId);
            assert.ok(result);
            assert.equal(result.selected.candidate, "active");
            assert.equal(result.rounds[0]?.userMessage, "你好，active 用户");
            assert.deepEqual(result.candidateKinds, ["active"], "failed implicit candidate must not be reported as a successful source");
            assert.equal(result.partial, true, "a decoded active candidate plus a failed implicit candidate must be explicitly partial");
            assert.deepEqual(
                result.diagnostics.map(({ kind, status, stepCount, errorCode }) => ({ kind, status, stepCount, errorCode })),
                [
                    { kind: "active", status: "success", stepCount: 1, errorCode: undefined },
                    { kind: "implicit", status: "failed", stepCount: undefined, errorCode: failure.errorCode },
                ],
                "successful and failed candidates must remain separately diagnosable",
            );
            const bridged = await loadConversationData("antigravity", conversationId, { source: "local" });
            assert.equal(bridged?.totalSteps, 1, "bridge should retain the decoded local PB rounds");
            assert.equal(bridged?.aiResponseCount, 1, "local PB cache overview must count decoded AI responses");
            assert.equal(bridged?.toolCallCount, 0, "wire-level local PB variants must not be counted as semantic tool calls");
            assert.equal(
                bridged?.rounds[0]?.semanticEvents?.some(event => event.kind === "pb_wire_variant" && event.name === "field_25"),
                true,
                "wire-level local PB variants must remain available as diagnostics",
            );
            const cached = await loadConversationData("antigravity", conversationId, { source: "cache" });
            assert.equal(cached?.cacheGeneration, bridged?.cacheGeneration, "source=cache must read the latest explicit local fetch generation");
            assert.equal(cached?.rounds[0]?.userMessage, "你好，active 用户", "source=cache must reuse the normalized local PB result");
            assert.equal(cached?.aiResponseCount, 1, "cache-only reads must preserve the full local PB AI response count");
            assert.equal(cached?.toolCallCount, 0, "cache-only reads must preserve semantic tool counts without counting PB wire variants");
            assert.match(bridged?.sourceDiagnostics?.[0] || "", /部分候选解码失败/u, "bridge result must expose local PB partial status");
            assert.ok(
                bridged?.sourceDiagnostics?.some(item => item.includes(`本地 PB implicit: failed/${failure.errorCode}`)),
                "bridge result must preserve the skipped implicit candidate diagnostic",
            );
        }

        const failedConversationId = "adapter-all-failed";
        fs.writeFileSync(path.join(activeRoot, `${failedConversationId}.pb`), encrypted(activePlaintext, Buffer.alloc(32, 7)));
        fs.writeFileSync(path.join(implicitRoot, `${failedConversationId}.pb`), encrypted(implicitPlaintext).subarray(0, 20));
        assert.throws(() => loadLocalPbConversation("antigravity", failedConversationId), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /active \(AUTH_FAILED\): Local PB AES-256-GCM authentication failed/u);
            assert.match(error.message, /implicit \(TRUNCATED\): Encrypted local PB is shorter than a GCM nonce and authentication tag/u);
            return true;
        });
    } finally {
        resetConversationSourceCacheForTests();
        setConversationSourceCacheDataRootForTests(null);
        for (const key of environmentKeys) {
            const value = originalEnvironment.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
}

console.log("local-pb-reader.test.ts PASS: active/implicit, bridge partial/skipped diagnostics, AES-GCM auth, truncation, uint64 guard, flavors, Unicode, timestamps, tools");

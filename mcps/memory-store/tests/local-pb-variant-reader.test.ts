import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readLocalPbCandidate, type LocalPbSourceFlavor } from "../src/local-pb-reader.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const URI = "file:///fixture/project/example.cpp";

function varint(value: number | bigint): Buffer {
    let remaining = BigInt(value);
    const bytes: number[] = [];
    do {
        const byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        bytes.push(remaining ? byte | 0x80 : byte);
    } while (remaining);
    return Buffer.from(bytes);
}

function scalar(fieldNumber: number, value: number | bigint): Buffer {
    return Buffer.concat([varint(fieldNumber * 8), varint(value)]);
}

function bytes(fieldNumber: number, value: string | Buffer): Buffer {
    const payload = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    return Buffer.concat([varint(fieldNumber * 8 + 2), varint(payload.length), payload]);
}

function typedStep(type: number, fieldNumber: number, payload: Buffer, status = 3): Buffer {
    const timestamp = Buffer.concat([scalar(1, 1_704_067_200), scalar(2, 123_000_000)]);
    return Buffer.concat([scalar(1, type), scalar(4, status), bytes(5, bytes(1, timestamp)), bytes(fieldNumber, payload)]);
}

function read(steps: Buffer[], sourceFlavor: LocalPbSourceFlavor = "windsurf", implicit = true) {
    const trajectory = Buffer.concat([bytes(1, "fixture-payload-id"), ...steps.map(step => bytes(2, step))]);
    const plaintext = implicit ? bytes(1, trajectory) : trajectory;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return readLocalPbCandidate({
        kind: implicit ? "implicit" : "active",
        label: "fixture-filename-id.pb",
        encrypted: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]),
    }, { key: KEY, sourceFlavor });
}

function fileContext(sourceFlavor: LocalPbSourceFlavor, options: { empty?: boolean; extraLineField?: boolean; binary?: boolean; extraInputField?: boolean } = {}): Buffer {
    const lines = options.empty ? Buffer.alloc(0) : Buffer.concat([
        bytes(3, Buffer.concat([bytes(1, "第一行\r"), scalar(2, 1), ...(options.extraLineField ? [bytes(9, "unknown")] : [])])),
        bytes(3, scalar(2, 2)),
        bytes(3, Buffer.concat([bytes(1, "last line"), scalar(2, 3)])),
    ]);
    const resource = Buffer.concat([
        bytes(2, Buffer.concat([...(sourceFlavor === "windsurf" && !options.empty ? [scalar(2, 3)] : []), bytes(3, lines)])),
        bytes(8, URI),
        ...(sourceFlavor === "windsurf" && !options.empty ? [bytes(10, options.binary ? Buffer.from([0xff, 0]) : "\uFEFF完整文件\r\npartial identifier\n")] : []),
        ...(sourceFlavor === "antigravity" && !options.empty ? [scalar(11, 42)] : []),
    ]);
    const input = options.empty ? bytes(4, bytes(1, bytes(5, URI))) : sourceFlavor === "windsurf"
        ? bytes(1, bytes(7, Buffer.concat([bytes(1, URI), scalar(3, 2), ...(options.extraInputField ? [bytes(99, "unknown input")] : [])])))
        : bytes(2, bytes(2, bytes(5, URI)));
    return Buffer.concat([bytes(1, input), bytes(2, bytes(1, resource))]);
}

function fileChange(extra: Buffer = Buffer.alloc(0)): Buffer {
    return Buffer.concat([bytes(1, URI), scalar(3, 2), bytes(4, "partial value"), bytes(9, "partial value\n"), scalar(17, 1), extra]);
}

function terminalCommand(options: { terminalId?: boolean; emptyOutput?: boolean } = {}): Buffer {
    return Buffer.concat([
        bytes(2, "/fixture/project"), scalar(6, 0),
        ...(options.terminalId ? [bytes(13, "fixture-terminal-id")] : [scalar(11, 1)]),
        bytes(21, options.emptyOutput ? Buffer.alloc(0) : bytes(1, "输出\r\n")),
        scalar(22, 2), bytes(23, "echo first"), bytes(25, "echo second"),
    ]);
}

function terminalOutput(output = "first\r\n", alternate?: string): Buffer {
    return Buffer.concat([bytes(1, "fixture-terminal-id"), scalar(2, 3),
        ...(alternate !== undefined ? [scalar(5, 1)] : []), bytes(9, output),
        ...(alternate !== undefined ? [bytes(12, alternate)] : [])]);
}

{
    const result = read([typedStep(5, 10, fileContext("windsurf")), typedStep(5, 10, fileContext("windsurf", { empty: true }))]);
    const step = result.trajectory.steps[0];
    const activity = step.activities?.[0];
    assert.equal(result.partial, false);
    assert.equal(activity?.kind, "file_context");
    assert.equal(activity?.sourceFlavor, "windsurf");
    assert.equal(activity?.uri, URI);
    assert.deepEqual(activity?.textFields, [{ fieldPath: "10.2.1.10", text: "\uFEFF完整文件\r\npartial identifier\n" }]);
    assert.deepEqual(activity?.lineSequence, { fieldPath: "10.2.1.2.3.3", lines: [
        { text: "第一行\r", rawFlag: "1" }, { rawFlag: "2" }, { text: "last line", rawFlag: "3" },
    ] });
    assert.equal(step.timestamp?.iso, "2024-01-01T00:00:00.123Z");
    assert.equal(step.user, undefined);
    assert.equal(step.planner, undefined);
    assert.equal(step.toolVariants.length, 0);
    assert.deepEqual(result.trajectory.steps[1].activities?.[0].lineSequence?.lines, []);
    assert.deepEqual(result.trajectory.steps[1].activities?.[0].textFields, []);
    assert.equal(result.trajectory.id, "fixture-payload-id");
    assert.equal(result.label, "fixture-filename-id.pb");
    console.log("PASS WSF field10 preserves snapshot, native lines and payload/filename identities");
}

{
    const result = read([typedStep(5, 10, fileContext("antigravity")), typedStep(5, 10, fileContext("antigravity", { empty: true }))], "antigravity");
    const activities = result.trajectory.steps.flatMap(step => step.activities || []);
    assert.equal(result.partial, false);
    assert.equal(activities.length, 2);
    assert.deepEqual(activities[0].textFields, []);
    assert.equal(activities[0].lineSequence?.lines.length, 3);
    assert.deepEqual(activities[1].lineSequence?.lines, []);
    assert.deepEqual(activities[1].textFields, []);
    assert.ok(result.trajectory.steps.every(step => !step.user && !step.planner));
    console.log("PASS AGY field10 retains line records and empty binary-resource context without invented text");
}

{
    const result = read([typedStep(8, 14, fileChange()), typedStep(21, 28, terminalCommand()),
        typedStep(21, 28, terminalCommand({ terminalId: true, emptyOutput: true })),
        typedStep(28, 37, terminalOutput("first\r\n", "different\n"))], "windsurf", false);
    const activities = result.trajectory.steps.flatMap(step => step.activities || []);
    assert.equal(result.partial, false);
    assert.deepEqual(activities.map(activity => activity.kind), ["file_change", "terminal_command", "terminal_command", "terminal_output"]);
    assert.deepEqual(activities[0].textFields.map(field => field.text), ["partial value", "partial value\n"]);
    assert.deepEqual(activities[1].textFields, [
        { fieldPath: "28.23", text: "echo first" }, { fieldPath: "28.25", text: "echo second" }, { fieldPath: "28.21.1", text: "输出\r\n" },
    ]);
    assert.equal(activities[2].terminalId, "fixture-terminal-id");
    assert.equal(activities[2].textFields.length, 2);
    assert.deepEqual(activities[3].textFields.map(field => field.text), ["first\r\n", "different\n"]);
    assert.equal(createHash("sha256").update(activities[1].textFields[2].text).digest("hex"), createHash("sha256").update("输出\r\n").digest("hex"));
    assert.ok(result.trajectory.steps.every(step => !step.user && !step.planner && !step.toolVariants.length));
    console.log("PASS WSF field14/28/37 preserve separate text fields, commands, outputs and empty output");
}

{
    const result = read([typedStep(28, 37, terminalOutput("<truncated 12 lines>\nkept", "<truncated 12 lines>\nkept"))]);
    assert.equal(result.partial, true);
    assert.equal(result.diagnostics.filter(diagnostic => diagnostic.kind === "partial").length, 1);
    assert.equal(result.trajectory.steps[0].activities?.length, 1);
    assert.equal(result.trajectory.steps[0].toolVariants.length, 0);
    console.log("PASS explicit terminal truncation remains structured partial even for a recognized activity");
}

{
    for (const sourceFlavor of ["windsurf", "antigravity"] as const) {
        const otherFlavor = sourceFlavor === "windsurf" ? "antigravity" : "windsurf";
        const result = read([typedStep(5, 10, fileContext(otherFlavor))], sourceFlavor);
        assert.equal(result.partial, true);
        assert.equal(result.trajectory.steps[0].activities?.length, 0);
    }
    for (const [type, number, payload] of [[8, 14, fileChange()], [21, 28, terminalCommand()], [28, 37, terminalOutput()]] as const) {
        const result = read([typedStep(type, number, payload)], "antigravity");
        assert.equal(result.partial, true);
        assert.equal(result.trajectory.steps[0].activities?.length, 0);
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === "unknown_variant" && diagnostic.fieldNumber === number));
    }
    const unsupported = [
        typedStep(8, 10, fileContext("windsurf")),
        typedStep(5, 10, fileContext("windsurf"), 2),
        typedStep(5, 10, fileContext("windsurf", { extraLineField: true })),
        typedStep(5, 10, fileContext("windsurf", { extraInputField: true })),
        typedStep(5, 10, fileContext("windsurf", { binary: true })),
        typedStep(8, 14, fileChange(bytes(99, "unknown body"))),
        typedStep(8, 14, Buffer.from([0xff])),
        typedStep(8, 14, Buffer.alloc(0)),
        bytes(88, scalar(1, 7)),
        bytes(89, "future variant body"),
        Buffer.concat([typedStep(8, 14, fileChange()), bytes(14, fileChange())]),
    ];
    for (const step of unsupported) {
        const result = read([step]);
        assert.equal(result.partial, true);
        assert.equal(result.trajectory.steps[0].activities?.length, 0);
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === "unknown_variant"));
        assert.equal(result.trajectory.steps[0].user, undefined);
    }
    console.log("PASS source/type/status/shape gates and unknown variants preserve partial without fabricated dialogue");
}

{
    const result = read([Buffer.concat([bytes(19, bytes(1, "真实用户 fixture")), bytes(20, bytes(1, "模型正文 fixture"))]),
        typedStep(5, 10, fileContext("windsurf"))]);
    assert.equal(result.partial, false);
    assert.equal(result.trajectory.steps[0].user, "真实用户 fixture");
    assert.equal(result.trajectory.steps[0].planner?.response, "模型正文 fixture");
    assert.equal(result.trajectory.steps[1].user, undefined);
    assert.equal(result.trajectory.steps[1].planner, undefined);
    assert.equal(result.trajectory.steps[1].activities?.length, 1);
    console.log("PASS existing explicit dialogue remains distinct from implicit editor activity");
}

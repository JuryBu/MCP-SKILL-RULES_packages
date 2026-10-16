import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GuardCheckResult } from "../src/guard-engine.js";
import type { GuardEvidenceAssetInput } from "../src/guard-evidence-index.js";

const originalEnvironment = { ...process.env };
const originalWorkingDirectory = process.cwd();
const originalTempDirectory = os.tmpdir();
const cliPathProbe = process.argv.includes("--cli-path-probe");
const cliPathRegression = process.argv.includes("--cli-path-regression");
const executionRoleRegression = process.argv.includes("--execution-evidence-role");
const fixtureRoot = fs.mkdtempSync(path.join(originalTempDirectory, "memory-store-guard-tool-"));
const fixtureDirectory = path.join(fixtureRoot, "中文 空格 fixtures");
const temporaryDirectory = path.join(fixtureRoot, "tmp");
const invocationPath = path.join(fixtureRoot, "invocations.jsonl");
const fakeCliSource = path.join(fixtureDirectory, "fake-cli.cjs");
const fakeCliCommand = path.join(fixtureDirectory, process.platform === "win32" ? "fake-cli.cmd" : "fake-cli");
for (const directory of [fixtureDirectory, temporaryDirectory, "home", "appdata", "localappdata", "codex", "data"].map(directory => path.isAbsolute(directory) ? directory : path.join(fixtureRoot, directory))) {
    fs.mkdirSync(directory, { recursive: true });
}
const inheritedEnvironment = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "SystemDrive", "OS", "PROCESSOR_ARCHITECTURE"];
for (const name of Object.keys(process.env)) delete process.env[name];
for (const name of inheritedEnvironment) {
    if (originalEnvironment[name] !== undefined) process.env[name] = originalEnvironment[name];
}
Object.assign(process.env, {
    HOME: path.join(fixtureRoot, "home"), USERPROFILE: path.join(fixtureRoot, "home"),
    APPDATA: path.join(fixtureRoot, "appdata"), LOCALAPPDATA: path.join(fixtureRoot, "localappdata"),
    CODEX_HOME: path.join(fixtureRoot, "codex"), TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory,
    MEMORY_STORE_DATA_ROOT: path.join(fixtureRoot, "data"), MEMORY_STORE_AUTO_RECORD: "0",
    MEMORY_STORE_CODEX_COMMAND: fakeCliCommand, MEMORY_STORE_CODEX_MODEL: "fixture-model", MEMORY_STORE_CODEX_SPEED: "standard",
    MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET: "60000", MEMORY_STORE_GUARD_EVIDENCE_TOTAL_CHARS: "18000",
    MEMORY_STORE_GUARD_EVIDENCE_FILE_CHARS: "14000", MEMORY_STORE_GUARD_TIMEOUT: "15000",
    MEMORY_STORE_CODEX_GUARD_TIMEOUT: "15000", MEMORY_STORE_CODEX_GUARD_BACKGROUND_TIMEOUT: "15000",
    GUARD_TOOL_FIXTURE_INVOCATIONS: invocationPath, GUARD_TOOL_FIXTURE_MODE: "pass", GUARD_TOOL_FIXTURE_STAGE: "initial",
});
process.chdir(fixtureDirectory);
fs.writeFileSync(fakeCliSource, String.raw`
const fs = require("node:fs");
if (process.argv.includes("--version")) {
    console.log("guard-tool-fake-cli 0.0.0");
    process.exit(0);
}
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const outputPath = args[outputIndex + 1];
if (outputIndex < 0 || !outputPath) throw new Error("fixture requires -o");
const prompt = fs.readFileSync(0, "utf8");
const mode = process.env.GUARD_TOOL_FIXTURE_MODE;
fs.appendFileSync(process.env.GUARD_TOOL_FIXTURE_INVOCATIONS, JSON.stringify({ stage: process.env.GUARD_TOOL_FIXTURE_STAGE, mode, args, outputPath, prompt, pid: process.pid }) + "\n", "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "synthetic-guard-cli" }));
if (mode === "cancel") {
    setInterval(() => {}, 1000);
} else if (mode === "empty-failure") {
    console.error("synthetic fixture exited without model text");
    process.exit(7);
} else {
    const reply = mode === "model-claim" ? "EVIDENCE_INSUFFICIENT\n本机读取命令被策略拒绝" : "PASS\nSynthetic fixture evidence inspected";
    fs.writeFileSync(outputPath, reply, "utf8");
    if (mode === "structured-rejection") {
        process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "synthetic-command", type: "command_execution", command: "echo ordinary-guard-fixture", status: "declined", exit_code: null } }) + "\n" + JSON.stringify({ type: "item.completed", item: { id: "synthetic-reply", type: "agent_message", text: reply } }) + "\n");
    } else {
        console.log(JSON.stringify({ type: "item.completed", item: { id: "synthetic-reply", type: "agent_message", text: reply } }));
    }
}
`, "utf8");
fs.writeFileSync(fakeCliCommand, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake-cli.cjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeCliSource}" "$@"\n`, { encoding: "utf8", mode: 0o700 });

const guard = await import("../src/tools/stage-guard.js");
const { runGuardCheck } = await import("../src/guard-engine.js");
const { callCodexExec } = await import("../src/model-bridge.js");
const { getGuardLocks, readGuardState } = await import("../src/guard-store.js");
const { getBackgroundTask, waitForBackgroundTask, readBackgroundTaskDiagnostics, __testEvictFromMemory, __testWritePersistedTask, recoverBackgroundTask, stableJsonHash, BACKGROUND_TASK_RESUME_VERSION } = await import("../src/background-tasks.js");
const server = new McpServer({ name: "guard-final-coverage-tool-fixture", version: "1" });
const client = new Client({ name: "guard-final-coverage-tool-client", version: "1" });
const conversationId = "01900000-1111-7222-8333-555555555555";
const identity = { conversationId, chain: "auto", dataChain: "codex", modelChain: "codex", childScopeId: "integration", scopeSelectors: ["Fixture evidence"] };
const observed = new Map<string, GuardCheckResult>();
const diagnosticCallbacks = new Map<string, Array<NonNullable<GuardCheckResult["codexDiagnostics"]>>>();
const progressStages = new Map<string, string[]>();
const executionRoles = new Map<string, Array<"required" | "reference" | undefined>>();
const pendingChecks = new Set<Promise<GuardCheckResult>>();
const activeCases = new Set<string>();
const taskFiles = new Map<string, string>();
const guardIds = new Map<string, string>();
const caseTaskIds = new Map<string, string>();
let checkRunnerCalls = 0;
let conversationLoads = 0;
let completed = false;

guard.__testSetStageGuardConversationIdResolver(async identifier => identifier || null);
guard.__testSetStageGuardConversationLoader(async () => {
    conversationLoads++;
    throw new Error("synthetic MCP test must not read conversation history");
});
guard.__testSetStageGuardCheckRunner(async (state, appealNote, evidence, options) => {
    checkRunnerCalls++;
    assert.equal(state.conversationId, conversationId);
    assert.equal(state.childScopeId, scopeForCase(state.stageId));
    assert.deepEqual(state.scopeSelectors, state.stageId === "locator-rejection" ? [] : identity.scopeSelectors);
    executionRoles.set(state.stageId, [...(executionRoles.get(state.stageId) || []), options?.executionEvidenceRole]);
    const running = runGuardCheck({ ...state, conversationId: "" }, appealNote, evidence, {
        ...options,
        onCodexDiagnostics: diagnostic => {
            diagnosticCallbacks.set(state.stageId, [...(diagnosticCallbacks.get(state.stageId) || []), diagnostic]);
            options?.onCodexDiagnostics?.(diagnostic);
        },
        onProgress: stage => {
            progressStages.set(state.stageId, [...(progressStages.get(state.stageId) || []), stage]);
            options?.onProgress?.(stage);
        },
    });
    pendingChecks.add(running);
    try {
        const result = await running;
        observed.set(state.stageId, result);
        return result;
    } finally {
        pendingChecks.delete(running);
    }
});
guard.registerStageGuard(server);

function scopeForCase(stageId: string): string {
    return stageId === "locator-rejection" ? "main" : identity.childScopeId;
}

function toolText(response: any): string {
    return response.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
}

async function callTool(stageId: string, parameters: Record<string, unknown>): Promise<string> {
    const requestIdentity = stageId === "locator-rejection" ? { conversationId, chain: "auto", dataChain: "codex", modelChain: "codex" } : identity;
    const response = await client.callTool({ name: "stage_guard", arguments: { ...requestIdentity, stageId, ...parameters } });
    assert.notEqual(response.isError, true, toolText(response));
    return toolText(response);
}

function invocations(stageId: string): any[] {
    if (!fs.existsSync(invocationPath)) return [];
    return fs.readFileSync(invocationPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(item => item.stage === stageId);
}

function withinFixture(filePath: string): string {
    const resolved = path.resolve(filePath);
    assert.ok(resolved.startsWith(path.resolve(fixtureRoot) + path.sep), resolved);
    return resolved;
}

function readArtifact(filePath: string): string {
    return fs.readFileSync(withinFixture(filePath), "utf8");
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function inspectResult(stageId: string, response: string) {
    const result = observed.get(stageId);
    assert.ok(result, `real runGuardCheck result missing for ${stageId}`);
    assert.ok(result.reportPath, response);
    assert.ok(result.evidenceIndexManifestPath);
    assert.ok(result.codexDiagnostics?.manifestPath, response);
    const report = readArtifact(result.reportPath);
    const evidenceManifest = JSON.parse(readArtifact(result.evidenceIndexManifestPath));
    const diagnostics = JSON.parse(readArtifact(result.codexDiagnostics.manifestPath));
    const execution = invocations(stageId);
    assert.equal(execution.length, 1, `${stageId}: CLI must run exactly once`);
    const invocation = execution[0];
    assert.ok(invocation.args.includes("--json"));
    assert.ok(invocation.args.includes("--ephemeral"));
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(fs.existsSync(withinFixture(invocation.outputPath)), false, "-o output must be cleaned after capture");
    assert.equal(result.promptBudget?.provider, "codex");
    if (!result.infrastructureError) assert.equal(result.modelChainUsed, "codex");
    assert.equal(diagnostics.metadata.command, process.env.MEMORY_STORE_CODEX_COMMAND);
    assert.equal(diagnostics.metadata.model, "fixture-model");
    assert.equal(diagnostics.metadata.context.guardId, guardIds.get(stageId));
    assert.equal(diagnostics.metadata.context.childScopeId, scopeForCase(stageId));
    assert.equal(diagnostics.metadata.context.stageId, stageId);
    assert.equal(diagnostics.metadata.promptSha256, sha256(invocation.prompt));
    assert.equal(sha256(readArtifact(result.codexDiagnostics.manifestPath)), result.codexDiagnostics.manifestSha256);
    assert.equal(diagnostics.state, "finished");
    if (diagnostics.rejectedCommandCount === 0) assert.equal(diagnostics.outcome.exitCode, stageId === "empty-failure" ? 7 : 0);
    else assert.equal(result.safetyStopped, true);
    assert.equal(diagnostics.retention, "private-until-explicit-archive-or-removal");
    if (diagnostics.rejectedCommandCount === 0) assert.equal(diagnostics.eventCoverage, "complete");
    else assert.ok(["complete", "partial"].includes(diagnostics.eventCoverage));
    for (const streamName of ["stdout", "stderr"]) {
        const stream = diagnostics[streamName];
        const text = readArtifact(stream.path);
        assert.equal(sha256(text), stream.sha256);
        assert.equal(stream.sha256, stream.streamSha256);
        assert.equal(Buffer.byteLength(text, "utf8"), stream.capturedBytes);
        assert.equal(stream.capturedBytes, stream.bytes);
        assert.equal(stream.truncated, false);
    }
    assert.deepEqual(result.coverage?.externalEvidence, evidenceManifest.coverage);
    const coverage = result.coverage!;
    assert.match(report, new RegExp(`\\*\\*Coverage\\*\\*: confidence=${coverage.confidence}, truncationRisk=${coverage.truncationRisk}`));
    assert.ok(report.includes(`confidence: ${coverage.confidence}\ntruncationRisk: ${coverage.truncationRisk}`));
    assert.ok(invocation.prompt.includes(`confidence: ${coverage.confidence}; truncationRisk: ${coverage.truncationRisk}`));
    const external = evidenceManifest.coverage;
    assert.ok(report.includes(`externalEvidence: requested=${external.requestedAssets}, complete=${external.completeAssets}, partial=${external.partialAssets}, unread=${external.unreadAssets}, included/source=${external.includedChars}/${external.sourceChars} chars`));
    const section = result.promptBudget!.sections.find(item => item.name === "evidenceIndexText")!;
    assert.equal(section.sourceChars, external.sourceChars);
    assert.equal(section.availableChars, external.includedChars);
    assert.equal(section.preCompressedChars, section.sourceChars - section.availableChars!);
    assert.equal(section.compressedChars, section.sourceChars - section.includedChars);
    assert.equal(result.promptBudget!.promptChars, invocation.prompt.length);
    assert.ok(report.includes(`evidenceIndexText: ${section.includedChars}/${section.sourceChars} chars, preProvider=${section.availableChars}`));
    if (section.compressedChars > 0) {
        assert.ok(invocation.prompt.includes(`evidenceIndexText: source=${section.sourceChars}, available=${section.availableChars}, included=${section.includedChars} chars`));
    }
    assert.ok(report.includes(`- **模型原始首行**: ${result.rawResponse.split("\n")[0] || "未返回模型正文"}`));
    assert.ok(report.includes(`## Flash 原始返回\n\n\x60\x60\x60\n${result.rawResponse}\n\x60\x60\x60`));
    assert.ok(response.includes(result.reportPath));
    assert.ok(response.includes(result.codexDiagnostics.manifestPath));
    console.log(JSON.stringify({ stageId, passed: result.passed, reason: result.evidenceInsufficientReason || (result.infrastructureError ? "INFRASTRUCTURE_ERROR" : "PASS"), rawFirstLine: result.rawResponse.split("\n")[0], coverage: external, promptSection: section, reportSha256: sha256(report), diagnosticSha256: result.codexDiagnostics.manifestSha256, exitCode: diagnostics.outcome.exitCode, observedRejections: diagnostics.rejectedCommandCount, modelReportedRefusal: diagnostics.modelReportedRefusal }));
    return { result, report, evidenceManifest, diagnostics, invocation, section };
}

async function startCase(stageId: string, mode = "pass"): Promise<void> {
    process.env.GUARD_TOOL_FIXTURE_STAGE = stageId;
    process.env.GUARD_TOOL_FIXTURE_MODE = mode;
    process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = "60000";
    const taskFile = path.join(fixtureDirectory, `${stageId}-Task.md`);
    fs.writeFileSync(taskFile, "# Synthetic Task\n\n## Fixture evidence\n- [x] Verify isolated evidence through the registered MCP tool\n", "utf8");
    taskFiles.set(stageId, taskFile);
    const response = await callTool(stageId, { action: "start", startRound: 1, taskFiles: [taskFile] });
    assert.match(response, /已激活/u);
    activeCases.add(stageId);
    const state = readGuardState(conversationId, stageId, scopeForCase(stageId))!;
    assert.ok(state.active);
    guardIds.set(stageId, state.guardId);
    assert.equal(state.checkHistory.length, 0);
    assert.equal(getGuardLocks(taskFile).length, 1);
}

function assertRetained(stageId: string): void {
    const state = readGuardState(conversationId, stageId, scopeForCase(stageId))!;
    assert.ok(state?.active);
    assert.equal(state.checkHistory.length, 0);
    assert.equal(getGuardLocks(taskFiles.get(stageId)!).length, 1);
}

function assertReleased(stageId: string): void {
    assert.equal(readGuardState(conversationId, stageId, scopeForCase(stageId)), null);
    assert.equal(getGuardLocks(taskFiles.get(stageId)!).length, 0);
    activeCases.delete(stageId);
}

function persistedTaskText(taskId: string): string {
    return readArtifact(path.join(process.env.MEMORY_STORE_DATA_ROOT!, "tasks", `${taskId}.json`));
}

async function assertLateDiagnostics(stageId: string, taskId: string, beforeCleanup: string): Promise<void> {
    await waitUntil(() => Boolean(readBackgroundTaskDiagnostics(taskId)?.references.length), "late CLI diagnostics were not linked to original terminal task");
    const diagnostic = observed.get(stageId)!.codexDiagnostics!;
    const association = readBackgroundTaskDiagnostics(taskId)!;
    assert.equal(association.taskId, taskId);
    assert.equal(association.guardId, guardIds.get(stageId));
    assert.equal(association.references.length, 1);
    assert.equal(association.references[0].manifestPath, diagnostic.manifestPath);
    assert.equal(association.references[0].manifestSha256, diagnostic.manifestSha256);
    const manifest = JSON.parse(readArtifact(diagnostic.manifestPath!));
    assert.equal(manifest.metadata.context.backgroundTaskId, taskId);
    assert.equal(manifest.metadata.context.guardId, guardIds.get(stageId));
    assert.equal(persistedTaskText(taskId), beforeCleanup, "late diagnostic callback must not rewrite terminal task file");
    const before = JSON.parse(beforeCleanup);
    const polled = await callTool(stageId, { action: "check", taskId });
    assert.ok(polled.includes(diagnostic.manifestPath!));
    assert.ok(polled.includes(`taskId=${taskId}`));
    assert.ok(polled.includes(guardIds.get(stageId)!));
    assert.equal(getBackgroundTask(taskId)?.status, before.status);
    assert.equal(getBackgroundTask(taskId)?.finishedAt, before.finishedAt);
    assert.equal(getBackgroundTask(taskId)?.error, before.error);
    __testEvictFromMemory(taskId);
    const reloaded = await callTool(stageId, { action: "check", taskId });
    assert.ok(reloaded.includes(diagnostic.manifestPath!));
    assert.equal(persistedTaskText(taskId), beforeCleanup);
}

async function checkCase(stageId: string, evidenceAssets: GuardEvidenceAssetInput[], background = false): Promise<string> {
    return callTool(stageId, { action: "check", evidenceAssets, background });
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, description);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

function makePathCli(directoryName: string): string {
    const directory = path.join(fixtureRoot, directoryName);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(fakeCliSource, path.join(directory, "fake-cli.cjs"));
    const command = path.join(directory, "fake-cli.cmd");
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fake-cli.cjs" %*\r\n`, "utf8");
    return command;
}

async function runCliPathProbe(): Promise<void> {
    assert.equal(process.platform, "win32", "Windows cmd.exe path probe only");
    const sourcePath = path.resolve(originalWorkingDirectory, "src", "model-bridge.ts");
    console.log(JSON.stringify({ probe: "source", sourceSha256: sha256(fs.readFileSync(sourcePath, "utf8")), nodeVersion: process.version, fixtureRoot }));
    const pathCases = [
        { name: "ascii", directory: "cli-ascii" }, { name: "space", directory: "cli ascii" },
        { name: "unicode", directory: "中文" }, { name: "unicode-space", directory: "中文 空格" },
    ];
    const observations: Array<{ name: string; command: string; diagnostics: any; text: string | null }> = [];
    for (const item of pathCases) {
        const command = makePathCli(item.directory);
        process.env.MEMORY_STORE_CODEX_COMMAND = command;
        process.env.GUARD_TOOL_FIXTURE_STAGE = `path-${item.name}`;
        const result = await callCodexExec("ordinary synthetic path probe", "fixture-model", 10000, { guardId: "synthetic-path-guard", childScopeId: "integration", stageId: `path-${item.name}` });
        assert.ok(result.codexDiagnostics?.manifestPath);
        const diagnostics = JSON.parse(readArtifact(result.codexDiagnostics.manifestPath));
        assert.equal(diagnostics.rejectedCommandCount, 0);
        assert.equal(diagnostics.metadata.command, command);
        assert.equal(fs.existsSync(diagnostics.metadata.args[diagnostics.metadata.args.indexOf("-o") + 1]), false);
        const stderrBytes = fs.readFileSync(withinFixture(diagnostics.stderr.path));
        console.log(JSON.stringify({ probe: "actual-bridge", name: item.name, command, text: result.text, error: result.error, exitCode: diagnostics.outcome.exitCode, calls: invocations(`path-${item.name}`).length, rejected: diagnostics.rejectedCommandCount, manifestPath: result.codexDiagnostics.manifestPath, stderrBase64: stderrBytes.toString("base64"), stderrSha256: diagnostics.stderr.sha256, args: diagnostics.metadata.args }));
        observations.push({ name: item.name, command, diagnostics, text: result.text });
    }
    assert.equal(observations.find(item => item.name === "ascii")?.text?.split("\n")[0], "PASS");
    assert.equal(observations.find(item => item.name === "unicode")?.text?.split("\n")[0], "PASS");
    const quote = (argument: string) => argument === "" ? '""' : /[\s"]/u.test(argument) ? `"${argument.replace(/"/gu, '""')}"` : argument;
    const candidates = [
        { name: "verbatim-only", outerQuotes: false, verbatim: true, source: "space" },
        { name: "outer-quotes-only", outerQuotes: true, verbatim: false, source: "space" },
        { name: "outer-quotes-and-verbatim", outerQuotes: true, verbatim: true, source: "space" },
        { name: "outer-quotes-and-verbatim-unicode", outerQuotes: true, verbatim: true, source: "unicode-space" },
    ];
    for (const candidate of candidates) {
        const observation = observations.find(item => item.name === candidate.source)!;
        const outputPath = path.join(temporaryDirectory, `candidate-${candidate.name}.txt`);
        const args = [...observation.diagnostics.metadata.args];
        args[args.indexOf("-o") + 1] = outputPath;
        const commandString = `${quote(observation.command)} ${args.map(quote).join(" ")}`;
        const spawnArgs = ["/d", "/s", "/c", candidate.outerQuotes ? `"${commandString}"` : commandString];
        process.env.GUARD_TOOL_FIXTURE_STAGE = candidate.name;
        const execution = await new Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
            const child = spawn("cmd.exe", spawnArgs, { cwd: fixtureDirectory, env: process.env, windowsHide: true, windowsVerbatimArguments: candidate.verbatim, stdio: ["pipe", "pipe", "pipe"] });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const timer = setTimeout(() => { child.kill(); reject(new Error(`synthetic quoting probe timed out: ${candidate.name}`)); }, 10000);
            child.on("error", error => { clearTimeout(timer); reject(error); });
            child.stdout.on("data", chunk => stdout.push(chunk));
            child.stderr.on("data", chunk => stderr.push(chunk));
            child.stdin.on("error", () => {});
            child.on("close", exitCode => { clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
            child.stdin.end("ordinary synthetic path probe", "utf8");
        });
        const logPrefix = path.join(fixtureRoot, `quoting-${candidate.name}`);
        fs.writeFileSync(`${logPrefix}.stdout.bin`, execution.stdout);
        fs.writeFileSync(`${logPrefix}.stderr.bin`, execution.stderr);
        const detail = { probe: "quoting-candidate", ...candidate, commandString, spawnArgs, exitCode: execution.exitCode, calls: invocations(candidate.name).length, output: fs.existsSync(outputPath) ? readArtifact(outputPath) : null, stderrBase64: execution.stderr.toString("base64"), logPrefix };
        fs.writeFileSync(`${logPrefix}.json`, JSON.stringify(detail, null, 2), "utf8");
        console.log(JSON.stringify(detail));
        if (candidate.outerQuotes && candidate.verbatim) {
            assert.equal(execution.exitCode, 0);
            assert.equal(detail.output?.split("\n")[0], "PASS");
            assert.equal(detail.calls, 1);
        }
    }
    console.log("PASS focused Windows CLI path probe: four actual-bridge path variants and four ordinary quoting controls captured; production source untouched");
}

async function runExecutionRoleRegression(): Promise<void> {
    const tool = (await client.listTools()).tools.find(item => item.name === "stage_guard")!;
    const roleSchema = tool.inputSchema.properties?.executionEvidenceRole as any;
    assert.deepEqual(roleSchema.enum, ["required", "reference"]);
    assert.match(roleSchema.description, /默认 required/u);
    assert.match(roleSchema.description, /仅有显式必需外部证据.*覆盖缺口仍显示/u);
    const invalid = await client.callTool({ name: "stage_guard", arguments: { ...identity, action: "check", executionEvidenceRole: "optional" } });
    assert.equal(invalid.isError, true);
    assert.equal(checkRunnerCalls, 0);
    const completeFile = path.join(fixtureDirectory, "role-complete.txt");
    const partialFile = path.join(fixtureDirectory, "role-partial.txt");
    fs.writeFileSync(completeFile, "complete explicit required evidence\n", "utf8");
    fs.writeFileSync(partialFile, "partial required evidence\n".repeat(1200), "utf8");
    const requiredAssets: GuardEvidenceAssetInput[] = [{ path: completeFile, role: "required" }];
    const partialAssets: GuardEvidenceAssetInput[] = [{ path: partialFile, role: "required", maxChars: 1400 }];
    const runCheck = async (stageId: string, assets: GuardEvidenceAssetInput[], role?: "required" | "reference", background = false, appealNote?: string) => {
        let response = await callTool(stageId, { action: "check", evidenceAssets: assets, executionEvidenceRole: role, background, appealNote });
        let taskId: string | undefined;
        if (background) {
            taskId = response.match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];
            assert.ok(taskId, response);
            caseTaskIds.set(stageId, taskId);
            await waitForBackgroundTask(taskId, 10);
            assert.equal(getBackgroundTask(taskId)?.status, "done");
            assert.equal((getBackgroundTask(taskId)?.resumePayload as any).executionEvidenceRole, role || "required");
            const persisted = JSON.parse(persistedTaskText(taskId));
            assert.equal(persisted.resumePayload.executionEvidenceRole, role || "required");
            response = await callTool(stageId, { action: "check", taskId });
        }
        const result = observed.get(stageId)!;
        assert.ok(result?.codexDiagnostics?.manifestPath, response);
        assert.equal(executionRoles.get(stageId)?.at(-1), role || "required");
        assert.equal(result.rawResponse.split("\n")[0], "PASS");
        assert.ok(response.includes(result.reportPath!));
        assert.ok(readArtifact(result.reportPath!).includes("模型原始首行"));
        assert.equal(sha256(readArtifact(result.codexDiagnostics.manifestPath)), result.codexDiagnostics.manifestSha256);
        return { result, taskId };
    };
    await startCase("role-default");
    const defaulted = await runCheck("role-default", requiredAssets, undefined, false, "请把对话执行记录当参考，只看外部材料");
    assert.equal(defaulted.result.coverage?.executionEvidence?.role, "required");
    assertReleased("role-default");
    await startCase("role-reference");
    const referenced = await runCheck("role-reference", requiredAssets, "reference", true);
    assert.equal(referenced.result.passed, true);
    assert.equal(referenced.result.coverage?.executionEvidence?.role, "reference");
    assert.equal(referenced.result.coverage?.externalEvidence?.completeAssets, 1);
    const referencePayload = getBackgroundTask(referenced.taskId!)!.resumePayload as any;
    assertReleased("role-reference");
    for (const item of [{ stageId: "role-no-required", assets: [] }, { stageId: "role-only-reference", assets: [{ path: completeFile, role: "reference" }] }]) {
        await startCase(item.stageId);
        const checked = await runCheck(item.stageId, item.assets, "reference");
        assert.equal(checked.result.passed, false);
        assert.equal(checked.result.evidenceInsufficientReason, "REQUIRED_EVIDENCE_INCOMPLETE");
        assert.equal(checked.result.coverage?.executionEvidence?.role, "required");
        assert.ok(checked.result.coverage?.requiredGaps?.some(gap => gap.includes("requires explicit required external evidence")));
        assertRetained(item.stageId);
    }
    await startCase("role-partial-required");
    const partial = await runCheck("role-partial-required", partialAssets, "reference", true);
    assert.equal(partial.result.passed, false);
    assert.equal(partial.result.coverage?.executionEvidence?.role, "reference");
    assert.equal(partial.result.coverage?.externalEvidence?.partialAssets, 1);
    assert.ok(partial.result.coverage?.requiredGaps?.length);
    assertRetained("role-partial-required");
    const required = await runCheck("role-partial-required", partialAssets, undefined, true);
    assert.notEqual(required.taskId, partial.taskId);
    assert.equal(required.result.coverage?.executionEvidence?.role, "required");
    const beforeEquivalent = checkRunnerCalls;
    const equivalent = await callTool("role-partial-required", { action: "check", evidenceAssets: partialAssets, executionEvidenceRole: "required", background: true });
    assert.equal(equivalent.match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1], required.taskId);
    assert.equal(checkRunnerCalls, beforeEquivalent);
    for (const item of [{ stageId: "role-recovered-reference", role: "reference" }, { stageId: "role-legacy-required", role: undefined }] as const) {
        await startCase(item.stageId);
        const state = readGuardState(conversationId, item.stageId, identity.childScopeId)!;
        const payload = { ...referencePayload, stageId: item.stageId, guardId: state.guardId, guardStartedAt: state.startedAt, appealNote: "把对话执行记录当参考" };
        if (item.role) payload.executionEvidenceRole = item.role;
        else delete payload.executionEvidenceRole;
        const taskId = `stage-guard-check-role-recovery-${crypto.randomUUID()}`;
        const startedAt = new Date(Date.now() - 1000).toISOString();
        __testWritePersistedTask({ id: taskId, kind: "stage-guard-check", status: "running", startedAt, updatedAt: startedAt,
            maxRunMs: 15000, ownerPid: 2147483647, resumePayload: payload, resumeVersion: BACKGROUND_TASK_RESUME_VERSION, resumeHash: stableJsonHash(payload) });
        caseTaskIds.set(item.stageId, taskId);
        __testEvictFromMemory(taskId);
        const recovery = await recoverBackgroundTask(taskId);
        assert.equal(recovery.outcome, "resumed", recovery.reason);
        assert.equal(recovery.recoveredTaskId, taskId);
        await waitForBackgroundTask(taskId, 10);
        assert.equal(getBackgroundTask(taskId)?.status, "done");
        assert.equal(executionRoles.get(item.stageId)?.at(-1), item.role || "required");
        assert.equal(observed.get(item.stageId)?.coverage?.executionEvidence?.role, item.role || "required");
        const polled = await callTool(item.stageId, { action: "check", taskId });
        assert.ok(polled.includes(observed.get(item.stageId)!.codexDiagnostics!.manifestPath!));
        assertReleased(item.stageId);
    }
    assert.equal(checkRunnerCalls, 8);
    assert.equal(conversationLoads, 0);
    console.log("PASS execution evidence role: MCP enum validation and explicit option forwarding, default/appealNote/legacy payload stay required, missing or optional-only required assets block PASS, partial required external evidence blocks PASS, complete required assets permit reference, role-sensitive task identity and same original task recovery preserve role and diagnostic query; 8 real runGuardCheck/Fake CLI checks, stable 11-case suite not repeated");
}

try {
    if (cliPathProbe) {
        await runCliPathProbe();
        completed = true;
    } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === "stage_guard"));
    if (executionRoleRegression) {
        await runExecutionRoleRegression();
        completed = true;
    } else if (cliPathRegression) {
        process.env.MEMORY_STORE_CODEX_COMMAND = makePathCli("中文 空格");
        await startCase("cli-path-regression");
        const asset = path.join(fixtureDirectory, "path-evidence.txt");
        fs.writeFileSync(asset, "ordinary path fixture evidence\n", "utf8");
        const checked = inspectResult("cli-path-regression", await checkCase("cli-path-regression", [{ path: asset }]));
        assert.equal(checked.result.passed, true);
        assertReleased("cli-path-regression");
        assert.equal(checkRunnerCalls, 1);
        assert.equal(conversationLoads, 0);
        console.log("PASS focused original Windows CLI path regression: Chinese plus space command through actual MCP/runGuardCheck/new bridge/report, exact lock/state released");
        completed = true;
    } else {
    const largeAsset = path.join(fixtureDirectory, "large-evidence.txt");
    const rangedAsset = path.join(fixtureDirectory, "ranged-evidence.txt");
    const providerAsset = path.join(fixtureDirectory, "provider-evidence.txt");
    fs.writeFileSync(largeAsset, "synthetic evidence line\n".repeat(1200), "utf8");
    fs.writeFileSync(rangedAsset, "OUTSIDE_FIRST_SENTINEL\nSELECTED_LINE_TWO\nSELECTED_LINE_THREE\nOUTSIDE_LAST_SENTINEL\n", "utf8");
    fs.writeFileSync(providerAsset, "provider evidence\n".repeat(450), "utf8");

    await startCase("required-truncated");
    const requiredStarted = await checkCase("required-truncated", [{ path: largeAsset, maxChars: 2400 }], true);
    const taskId = requiredStarted.match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(taskId, requiredStarted);
    caseTaskIds.set("required-truncated", taskId);
    await waitForBackgroundTask(taskId, 20);
    assert.equal(getBackgroundTask(taskId)?.status, "done");
    const requiredResponse = await callTool("required-truncated", { action: "check", taskId });
    const required = inspectResult("required-truncated", requiredResponse);
    assert.equal(required.result.passed, false);
    assert.equal(required.result.evidenceInsufficientReason, "REQUIRED_EVIDENCE_INCOMPLETE");
    assert.equal(required.result.rawResponse.split("\n")[0], "PASS");
    assert.match(required.report, /\*\*结果\*\*: EVIDENCE_INSUFFICIENT/u);
    assert.equal(required.evidenceManifest.items[0].sourceReadStatus, "complete");
    assert.equal(required.evidenceManifest.items[0].readStatus, "partial");
    assert.equal(required.result.coverage?.confidence, "low");
    assert.equal(required.result.coverage?.truncationRisk, "high");
    assert.ok(required.section.sourceChars > required.section.includedChars);
    assertRetained("required-truncated");
    const previousCalls = checkRunnerCalls;
    const persistedTask = JSON.parse(readArtifact(path.join(process.env.MEMORY_STORE_DATA_ROOT!, "tasks", `${taskId}.json`)));
    assert.equal(persistedTask.status, "done");
    assert.ok(persistedTask.result.includes(required.result.reportPath));
    assert.ok(persistedTask.result.includes(required.result.codexDiagnostics!.manifestPath));
    assert.ok(getBackgroundTask(taskId)?.result?.includes(required.result.codexDiagnostics!.manifestPath!));
    assert.equal(await callTool("required-truncated", { action: "check", taskId }), requiredResponse);
    assert.equal(checkRunnerCalls, previousCalls);
    assert.equal(invocations("required-truncated").length, 1);
    assertRetained("required-truncated");
    console.log("PASS required truncation: actual MCP background task done, immutable task/result diagnostics, repeated polling runs neither check runner nor CLI, lock retained and checkHistory unchanged");

    await startCase("required-total-budget");
    const tailAsset = path.join(fixtureDirectory, "unread-tail-evidence.txt");
    fs.writeFileSync(tailAsset, "UNREAD_TAIL_SENTINEL\n", "utf8");
    const totalLimited = inspectResult("required-total-budget", await checkCase("required-total-budget", [
        { path: largeAsset, maxChars: 9000 }, { path: largeAsset, maxChars: 9000 }, { path: tailAsset },
    ]));
    assert.equal(totalLimited.result.evidenceInsufficientReason, "REQUIRED_EVIDENCE_INCOMPLETE");
    assert.equal(totalLimited.evidenceManifest.coverage.requestedAssets, 3);
    assert.equal(totalLimited.evidenceManifest.coverage.partialAssets, 2);
    assert.equal(totalLimited.evidenceManifest.coverage.unreadAssets, 1);
    assert.equal(totalLimited.evidenceManifest.items[2].readStatus, "unread");
    assert.equal(totalLimited.evidenceManifest.items[2].sourceReadStatus, "unread");
    assert.equal(totalLimited.evidenceManifest.items[2].includedChars, 0);
    assert.ok(totalLimited.evidenceManifest.items[2].coverageGaps.some((gap: string) => gap.includes("total_budget_skipped")));
    assert.doesNotMatch(totalLimited.invocation.prompt, /UNREAD_TAIL_SENTINEL/u);
    assert.ok(totalLimited.section.sourceChars > totalLimited.section.includedChars);
    assert.ok(totalLimited.evidenceManifest.coverage.includedChars <= 18000);
    assertRetained("required-total-budget");
    console.log("PASS total budget: all three requested assets counted, two partial and final asset unread, source count exceeds included count, model PASS cannot clear lock/history");

    await startCase("declared-range");
    const ranged = inspectResult("declared-range", await checkCase("declared-range", [{ path: rangedAsset, range: "2-3" }]));
    assert.equal(ranged.result.passed, true);
    assert.match(ranged.report, /\*\*结果\*\*: PASS/u);
    assert.equal(ranged.evidenceManifest.items[0].requestedRange, "2-3");
    assert.equal(ranged.evidenceManifest.items[0].readStatus, "complete");
    assert.equal(ranged.evidenceManifest.coverage.completeAssets, 1);
    assert.equal(ranged.evidenceManifest.coverage.truncated, false);
    assert.match(ranged.invocation.prompt, /SELECTED_LINE_TWO\nSELECTED_LINE_THREE/u);
    assert.doesNotMatch(ranged.invocation.prompt, /OUTSIDE_FIRST_SENTINEL|OUTSIDE_LAST_SENTINEL/u);
    assertReleased("declared-range");
    console.log("PASS declared range: only requested lines included, true complete coverage and PASS removes exact fixture lock/state");

    await startCase("optional-reference");
    const reference = inspectResult("optional-reference", await checkCase("optional-reference", [{ path: largeAsset, maxChars: 2400, role: "reference" }]));
    assert.equal(reference.result.passed, true);
    assert.equal(reference.evidenceManifest.items[0].role, "reference");
    assert.equal(reference.evidenceManifest.items[0].readStatus, "partial");
    assert.equal(reference.evidenceManifest.coverage.partialAssets, 1);
    assert.equal(reference.evidenceManifest.coverage.truncated, true);
    assert.deepEqual(reference.result.coverage?.requiredGaps, []);
    assert.ok(reference.result.coverage?.coverageGaps.length);
    assert.notEqual(reference.result.coverage?.confidence, "high");
    assertReleased("optional-reference");
    console.log("PASS optional reference: partial coverage remains visible in prompt, manifest and report while optional evidence permits PASS");

    await startCase("provider-truncated");
    process.env.MEMORY_STORE_GUARD_CODEX_PROMPT_BUDGET = "6500";
    const provider = inspectResult("provider-truncated", await checkCase("provider-truncated", [{ path: providerAsset }]));
    assert.equal(provider.evidenceManifest.items[0].readStatus, "complete");
    assert.equal(provider.evidenceManifest.coverage.completeAssets, 1);
    assert.equal(provider.section.preCompressedChars, 0);
    assert.ok(provider.section.includedChars < provider.section.availableChars!);
    assert.ok(provider.invocation.prompt.length <= 6500);
    assert.equal(provider.result.passed, false);
    assert.equal(provider.result.evidenceInsufficientReason, "REQUIRED_EVIDENCE_INCOMPLETE");
    assert.match(provider.report, /\*\*结果\*\*: EVIDENCE_INSUFFICIENT/u);
    assertRetained("provider-truncated");
    console.log("PASS provider compression: complete acquired asset becomes incomplete final model input; report and original PASS stay distinct");

    await startCase("structured-rejection", "structured-rejection");
    const rejectedResponse = await checkCase("structured-rejection", [{ path: rangedAsset, range: "2-3" }]);
    const rejected = inspectResult("structured-rejection", rejectedResponse);
    assert.equal(rejected.result.evidenceInsufficientReason, "COMMAND_REJECTED");
    assert.equal(rejected.result.safetyStopped, true);
    assert.equal(rejected.result.passed, false);
    if (rejected.result.rawResponse) assert.equal(rejected.result.rawResponse.split("\n")[0], "PASS");
    assert.equal(rejected.diagnostics.rejectedCommandCount, 1);
    assert.equal(rejected.diagnostics.commands[0].command, "echo ordinary-guard-fixture");
    assert.equal(rejected.diagnostics.commands[0].status, "declined");
    assert.equal(rejected.diagnostics.commands[0].rejectionEvidence, "structured-status");
    assert.match(rejected.report, /\*\*结果\*\*: EVIDENCE_INSUFFICIENT/u);
    assert.match(rejectedResponse, /原补读或被拒动作继续停止/u);
    assert.doesNotMatch(rejectedResponse, /换.*(?:链|模型)|切换.*(?:链|模型)|modelChain\s*=|重跑|重试/u);
    assertRetained("structured-rejection");
    console.log("PASS structured rejection: fixture writes -o PASS before declined event, bridge safely stops even without returned model text, exact command evidence retained and tool gives no chain/retry advice");

    await startCase("locator-rejection", "structured-rejection");
    const locating = await checkCase("locator-rejection", [], true);
    const locatorTaskId = locating.match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(locatorTaskId, locating);
    caseTaskIds.set("locator-rejection", locatorTaskId);
    await waitForBackgroundTask(locatorTaskId, 10);
    assert.equal(getBackgroundTask(locatorTaskId)?.status, "done");
    const locatorResult = observed.get("locator-rejection")!;
    assert.ok(locatorResult);
    assert.equal(locatorResult.evidenceInsufficientReason, "COMMAND_REJECTED");
    assert.equal(locatorResult.safetyStopped, true);
    assert.equal(locatorResult.passed, false);
    assert.equal(locatorResult.coverage?.confidence, "low");
    assert.equal(locatorResult.promptBudget, undefined);
    assert.deepEqual(progressStages.get("locator-rejection"), ["input", "locator"]);
    const locatorCalls = invocations("locator-rejection");
    assert.equal(locatorCalls.length, 1);
    assert.match(locatorCalls[0].prompt, /受限定位器/u);
    assert.ok(locatorCalls[0].prompt.includes("目标 Stage: locator-rejection"));
    assert.equal(fs.existsSync(withinFixture(locatorCalls[0].outputPath)), false);
    const locatorDiagnostic = locatorResult.codexDiagnostics!;
    assert.ok(locatorDiagnostic?.manifestPath);
    assert.equal(locatorDiagnostic.rejectedCommandCount, 1);
    assert.equal(sha256(readArtifact(locatorDiagnostic.manifestPath)), locatorDiagnostic.manifestSha256);
    assert.equal(diagnosticCallbacks.get("locator-rejection")?.length, 1);
    assert.equal(diagnosticCallbacks.get("locator-rejection")?.[0].callId, locatorDiagnostic.callId);
    assert.equal(locatorResult.codexDiagnosticAttempts?.length, 1);
    const locatorManifest = JSON.parse(readArtifact(locatorDiagnostic.manifestPath));
    assert.equal(locatorManifest.metadata.context.guardId, guardIds.get("locator-rejection"));
    assert.equal(locatorManifest.metadata.context.stageId, "locator-rejection");
    assert.equal(locatorManifest.metadata.context.childScopeId, "main");
    assert.equal(locatorManifest.metadata.context.backgroundTaskId, locatorTaskId);
    const locatorReport = readArtifact(locatorResult.reportPath!);
    assert.ok(locatorReport.includes(`Guard Id: ${guardIds.get("locator-rejection")}`));
    assert.ok(locatorReport.includes(locatorDiagnostic.manifestPath));
    assert.match(locatorReport, /结果: EVIDENCE_INSUFFICIENT/u);
    assert.match(locatorReport, /最终检查未发起/u);
    const locatorPoll = await callTool("locator-rejection", { action: "check", taskId: locatorTaskId });
    assert.ok(locatorPoll.includes(locatorResult.reportPath!));
    assert.ok(locatorPoll.includes(locatorDiagnostic.manifestPath));
    assert.equal(readBackgroundTaskDiagnostics(locatorTaskId)?.guardId, guardIds.get("locator-rejection"));
    assert.equal(readBackgroundTaskDiagnostics(locatorTaskId)?.references[0].callId, locatorDiagnostic.callId);
    assert.equal(invocations("locator-rejection").length, 1);
    assertRetained("locator-rejection");
    console.log("PASS locator rejection: absent scopeSelectors and nonmatching stage trigger low coverage, one real locator CLI rejection stops before evidence/final-model progress, final model calls=0, report/callback/original MCP task preserve the same guard identity");

    await startCase("model-claim", "model-claim");
    const claimedResponse = await checkCase("model-claim", [{ path: rangedAsset, range: "2-3" }]);
    const claimed = inspectResult("model-claim", claimedResponse);
    assert.equal(claimed.result.evidenceInsufficientReason, "MODEL_REPORTED_REFUSAL_UNVERIFIED");
    assert.equal(claimed.result.safetyStopped, true);
    assert.equal(claimed.result.passed, false);
    assert.equal(claimed.diagnostics.rejectedCommandCount, 0);
    assert.deepEqual(claimed.diagnostics.commands, []);
    assert.equal(claimed.diagnostics.modelReportedRefusal, true);
    assert.match(claimedResponse, /MODEL_REPORTED_REFUSAL_UNVERIFIED/u);
    assert.match(claimedResponse, /观察到的拒绝=0/u);
    assert.match(claimedResponse, /原补读或被拒动作继续停止/u);
    assertRetained("model-claim");
    console.log("PASS model-only claim: no observed command/rejection invented, unverified reason exposed, original read remains stopped and checkHistory unchanged");

    await startCase("empty-failure", "empty-failure");
    const failedResponse = await checkCase("empty-failure", [{ path: rangedAsset, range: "2-3" }]);
    const failed = inspectResult("empty-failure", failedResponse);
    assert.equal(failed.result.infrastructureError, true);
    assert.equal(failed.result.rawResponse, "");
    assert.equal(failed.result.passed, false);
    assert.match(failed.report, /\*\*结果\*\*: INFRASTRUCTURE_ERROR/u);
    assert.match(failed.report, /未返回模型正文/u);
    assert.match(failedResponse, /模型链路失败/u);
    assertRetained("empty-failure");
    console.log("PASS exit7 without model text: registered tool still returns readable report and retained hashed CLI diagnostics, no checkHistory increment");

    await startCase("cancel-running", "cancel");
    const cancelling = await checkCase("cancel-running", [{ path: rangedAsset, range: "2-3" }], true);
    const cancelTaskId = cancelling.match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(cancelTaskId, cancelling);
    caseTaskIds.set("cancel-running", cancelTaskId);
    await waitUntil(() => invocations("cancel-running").length === 1, "fake CLI cancellation fixture did not start");
    assert.equal(readBackgroundTaskDiagnostics(cancelTaskId)?.guardId, guardIds.get("cancel-running"));
    assert.equal(readBackgroundTaskDiagnostics(cancelTaskId)?.references.length, 0);
    const cancelled = await callTool("cancel-running", { action: "cancel", taskId: cancelTaskId });
    assert.match(cancelled, /已取消/u);
    const cancelledBeforeCleanup = persistedTaskText(cancelTaskId);
    await waitUntil(() => observed.has("cancel-running"), "real runGuardCheck did not settle after cancellation");
    const cancelledResult = observed.get("cancel-running")!;
    assert.equal(cancelledResult.cancelled, true);
    assert.ok(cancelledResult.codexDiagnostics?.manifestPath);
    const cancelDiagnostics = JSON.parse(readArtifact(cancelledResult.codexDiagnostics.manifestPath));
    assert.equal(cancelDiagnostics.outcome.cancelled, true);
    assert.equal(cancelDiagnostics.metadata.context.guardId, guardIds.get("cancel-running"));
    assert.equal(cancelDiagnostics.metadata.context.childScopeId, identity.childScopeId);
    assert.equal(cancelDiagnostics.metadata.context.stageId, "cancel-running");
    assert.equal(cancelDiagnostics.eventCoverage, "partial");
    assert.equal(cancelDiagnostics.rejectedCommandCount, 0);
    assert.equal(sha256(readArtifact(cancelledResult.codexDiagnostics.manifestPath)), cancelledResult.codexDiagnostics.manifestSha256);
    assert.equal(getBackgroundTask(cancelTaskId)?.status, "cancelled");
    await assertLateDiagnostics("cancel-running", cancelTaskId, cancelledBeforeCleanup);
    const cancelCalls = checkRunnerCalls;
    const cancelledPoll = await callTool("cancel-running", { action: "check", taskId: cancelTaskId });
    assert.match(cancelledPoll, /cancelled|已取消/u);
    assert.equal(checkRunnerCalls, cancelCalls);
    assert.equal(getBackgroundTask(cancelTaskId)?.status, "cancelled");
    assert.equal(fs.existsSync(withinFixture(invocations("cancel-running")[0].outputPath)), false);
    assert.throws(() => process.kill(invocations("cancel-running")[0].pid, 0), { code: "ESRCH" });
    assertReleased("cancel-running");
    console.log(JSON.stringify({ stageId: "cancel-running", status: getBackgroundTask(cancelTaskId)?.status, diagnosticSha256: cancelledResult.codexDiagnostics.manifestSha256, eventCoverage: cancelDiagnostics.eventCoverage, cancelled: cancelDiagnostics.outcome.cancelled }));
    console.log("PASS cancellation: original MCP task and disk reload expose late diagnostics after cleanup, terminal task file/status/finishedAt/error unchanged, process exits and state/lock stay cleared");

    await startCase("timeout-running", "cancel");
    process.env.MEMORY_STORE_STAGE_GUARD_BACKGROUND_MAX_RUN_MS = "3000";
    const timingOut = await checkCase("timeout-running", [{ path: rangedAsset, range: "2-3" }], true);
    delete process.env.MEMORY_STORE_STAGE_GUARD_BACKGROUND_MAX_RUN_MS;
    const timeoutTaskId = timingOut.match(/taskId:\s*([A-Za-z0-9._-]+)/)?.[1];
    assert.ok(timeoutTaskId, timingOut);
    caseTaskIds.set("timeout-running", timeoutTaskId);
    await waitUntil(() => invocations("timeout-running").length === 1, "fake CLI timeout fixture did not start");
    assert.equal(readBackgroundTaskDiagnostics(timeoutTaskId)?.references.length, 0);
    await waitForBackgroundTask(timeoutTaskId, 6);
    assert.equal(getBackgroundTask(timeoutTaskId)?.status, "error");
    assert.equal(getBackgroundTask(timeoutTaskId)?.timedOut, true);
    const timeoutBeforeCleanup = persistedTaskText(timeoutTaskId);
    await waitUntil(() => observed.has("timeout-running"), "real runGuardCheck did not settle after host timeout");
    await assertLateDiagnostics("timeout-running", timeoutTaskId, timeoutBeforeCleanup);
    assertRetained("timeout-running");
    const timeoutCalls = checkRunnerCalls;
    const timeoutPoll = await callTool("timeout-running", { action: "check", taskId: timeoutTaskId });
    assert.match(timeoutPoll, /timedOut: true/u);
    assert.equal(checkRunnerCalls, timeoutCalls);
    assert.equal(invocations("timeout-running").length, 1);
    assert.throws(() => process.kill(invocations("timeout-running")[0].pid, 0), { code: "ESRCH" });
    console.log("PASS host timeout: original error/timedOut task exposes late CLI diagnostics through MCP and disk reload, terminal task file/status/finishedAt/error unchanged, poll never reruns and Guard lock/history retained");

    assert.equal(conversationLoads, 0);
    assert.equal(checkRunnerCalls, 11);
    assert.equal(fs.readdirSync(temporaryDirectory).filter(name => name.startsWith("memory-store-codex-bridge-")).length, 0);
    console.log("PASS Guard final coverage MCP integration: 11 real runGuardCheck/Fake CLI checks including locator rejection and cancelled/error late diagnostics; permanent Chinese plus space CLI path; no real model, research/history fetch, original rejected command, or production data used");
    completed = true;
    }
    }
} finally {
    for (const stageId of activeCases) await callTool(stageId, { action: "cancel", taskId: caseTaskIds.get(stageId) });
    await Promise.allSettled([...pendingChecks]);
    guard.__testSetStageGuardConversationIdResolver();
    guard.__testSetStageGuardConversationLoader();
    guard.__testSetStageGuardCheckRunner();
    await client.close();
    await server.close();
    process.chdir(originalWorkingDirectory);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
    if (completed && !cliPathProbe) {
        assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(originalTempDirectory));
        const assertNoLinks = (directory: string) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const filePath = withinFixture(path.join(directory, entry.name));
                assert.equal(fs.lstatSync(filePath).isSymbolicLink(), false, filePath);
                if (entry.isDirectory()) assertNoLinks(filePath);
            }
        };
        assertNoLinks(fixtureRoot);
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        assert.equal(fs.existsSync(fixtureRoot), false);
        console.log("PASS cleanup: only owned, path-checked, link-free synthetic fixture removed; environment and cwd restored");
    } else {
        console.error(`Synthetic ${cliPathProbe && completed ? "path probe" : "failure"} evidence retained at ${fixtureRoot}`);
    }
}

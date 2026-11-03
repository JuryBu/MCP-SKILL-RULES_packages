import assert from "node:assert/strict";
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import type { PdfRenderOptions, PdfRenderResult } from "../src/conversation-pdf.js";

const source = fs.readFileSync(new URL("../src/conversation-pdf.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("conversation-pdf.ts", source, ts.ScriptTarget.Latest, true);
const declarations = ["runPdfPython", "findPythonCommand", "tryEmbedPdfAttachments", "renderConversationPdf"];
const selected = tree.statements.filter(statement => ts.isFunctionDeclaration(statement) && declarations.includes(statement.name?.text || ""));
const compiled = ts.transpileModule(selected.map(statement => statement.getText(tree).replace(/^export\s+/u, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test("PDF Python call chain contains no synchronous subprocess and awaits embedding", () => {
    const awaited = new Map<string, number>();
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            assert.ok(!["spawnSync", "execFileSync"].includes(node.expression.text));
            if (["runPdfPython", "findPythonCommand", "tryEmbedPdfAttachments"].includes(node.expression.text)) {
                assert.ok(ts.isAwaitExpression(node.parent), node.expression.text);
                awaited.set(node.expression.text, (awaited.get(node.expression.text) || 0) + 1);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.deepEqual(Object.fromEntries(awaited), { runPdfPython: 2, findPythonCommand: 1, tryEmbedPdfAttachments: 1 });
});

interface PythonResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}

function createHarness(context: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-pdf-execution-"));
    const fixture = path.join(root, "python-fixture.cjs");
    fs.writeFileSync(fixture, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.PDF_EXECUTION_FIXTURE_MODE;
if (mode === "hang") {
    if (!args.includes("-c")) {
        const payload = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
        fs.writeFileSync(payload.output, "synthetic-partial");
    }
    setInterval(() => {}, 25);
} else if (mode === "overflow") {
    process.stdout.write("x".repeat(2 * 1024 * 1024));
} else if (mode === "fail") {
    process.stderr.write("NO_PYPDF: fixture unavailable");
    process.exitCode = 2;
} else if (args.includes("-c")) {
    process.stdout.write("Python fixture version");
} else {
    const payload = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
    fs.writeFileSync(payload.output, "synthetic-with-attachments");
    process.stdout.write(String(payload.attachments.length));
}
`, "utf8");
    const children: ChildProcess[] = [];
    const closed = new Set<ChildProcess>();
    const requests: Array<{ command: string; args: string[]; timeout?: number; payload?: unknown }> = [];
    let behavior = (_command: string, _args: string[]): string => "ok";
    const launch = (command: string, args: string[], options: ExecFileOptions & { encoding: "utf-8" }, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
        const mode = behavior(command, args);
        requests.push({ command, args, timeout: options.timeout, payload: args.includes("-c") ? undefined : JSON.parse(fs.readFileSync(args.at(-1)!, "utf8")) });
        const child = execFile(mode === "missing" ? path.join(root, "absent-executable") : process.execPath,
            [fixture, ...args], { ...options, env: { ...process.env, PDF_EXECUTION_FIXTURE_MODE: mode } }, callback);
        children.push(child);
        child.once("close", () => closed.add(child));
        return child;
    };
    let browser = "synthetic-browser";
    let printError: Error | undefined;
    const clock = { now: () => Date.now() };
    const dependencies = {
        fs, os: { tmpdir: () => root }, path, randomUUID, execFile: launch, Date: clock,
        spawnSync: () => assert.fail("synchronous PDF subprocess used"),
        MAX_EMBED_ATTACHMENT_BYTES: 20 * 1024 * 1024, DEFAULT_PDF_TIMEOUT_MS: 120_000,
        markdownToHtml: () => "<p>synthetic fixture</p>", findPdfBrowser: () => browser || null,
        runBrowserPrint: async (_browser: string, _html: string, pdf: string) => {
            if (printError) throw printError;
            fs.writeFileSync(pdf, "synthetic-original", "utf8");
        },
    };
    const api = new Function(...Object.keys(dependencies), `${compiled}; return { renderConversationPdf, runPdfPython };`)(...Object.values(dependencies)) as {
        renderConversationPdf(options: PdfRenderOptions): Promise<PdfRenderResult>;
        runPdfPython(command: string, args: string[], timeoutMs: number): Promise<PythonResult>;
    };
    const markdownPath = path.join(root, "conversation.md");
    const pdfPath = path.join(root, "conversation.pdf");
    const attachment = path.join(root, "附件.txt");
    fs.writeFileSync(markdownPath, "synthetic markdown", "utf8");
    fs.writeFileSync(attachment, "synthetic attachment", "utf8");
    const options: PdfRenderOptions = {
        exportDir: root, markdownPath, pdfPath, timeoutMs: 2_000,
        attachmentFiles: [{ path: attachment, name: "附件.txt" }, { path: path.join(root, "absent.txt"), name: "missing.txt" }],
    };
    context.after(async () => {
        for (const child of children) {
            if (child.pid && child.exitCode === null && child.signalCode === null) {
                const closing = once(child, "close");
                child.kill("SIGKILL");
                await closing;
            }
        }
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return {
        api, root, options, requests,
        render: (overrides: Partial<PdfRenderOptions> = {}) => api.renderConversationPdf({ ...options, ...overrides }),
        setBehavior: (next: typeof behavior) => { behavior = next; },
        setBrowser: (next: string) => { browser = next; },
        setPrintError: (next: Error) => { printError = next; },
        freezeClock: () => { clock.now = () => 1_000; },
        assertClosed: () => {
            assert.equal(closed.size, children.length, "promise must settle after direct-child close");
            for (const child of children) if (child.pid) {
                assert.ok(child.exitCode !== null || child.signalCode !== null);
                assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
            }
            return children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, closeObserved: closed.has(child) }));
        },
        assertTemporaryFilesRemoved: () => assert.deepEqual(fs.readdirSync(root).filter(name => /memory-store-pdf-attach-|attachments\.tmp\.pdf$/u.test(name)), []),
    };
}

test("PDF render awaits async attachment output and preserves eligible payload", async context => {
    const harness = createHarness(context);
    const result = await harness.render({ timeoutMs: 120_000 });
    assert.equal(result.ok, true);
    assert.equal(result.embeddedAttachments, 1);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.pdfPath, harness.options.pdfPath);
    assert.equal(fs.readFileSync(harness.options.pdfPath, "utf8"), "synthetic-with-attachments");
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[0].timeout, 5_000);
    assert.ok(harness.requests[1].timeout! > 0 && harness.requests[1].timeout! <= 60_000);
    assert.deepEqual(harness.requests[1].payload, {
        pdf: harness.options.pdfPath, output: `${harness.options.pdfPath}.attachments.tmp.pdf`,
        attachments: [{ path: harness.options.attachmentFiles![0].path, name: "附件.txt" }],
    });
    harness.assertClosed();
    harness.assertTemporaryFilesRemoved();
});

test("hanging Python probe leaves timers responsive, closes, and next render succeeds", async context => {
    const harness = createHarness(context);
    harness.setBehavior(() => "hang");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const startedAt = Date.now();
    let result: PdfRenderResult;
    try { result = await harness.render({ timeoutMs: 200 }); } finally { clearInterval(timer); }
    assert.ok(ticks >= 3, `heartbeat ticks=${ticks}`);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(result.ok, true);
    assert.equal(result.embeddedAttachments, 0);
    assert.match(result.warnings.join(" "), /未找到 Python/u);
    assert.equal(fs.readFileSync(harness.options.pdfPath, "utf8"), "synthetic-original");
    context.diagnostic(JSON.stringify({ heartbeatTicks: ticks, elapsedMs: Date.now() - startedAt, directChildren: harness.assertClosed() }));
    harness.setBehavior(() => "ok");
    assert.equal((await harness.render()).embeddedAttachments, 1);
    harness.assertClosed();
    harness.assertTemporaryFilesRemoved();
});

test("attachment timeout shares remaining budget and cleans partial output before recovery", async context => {
    const harness = createHarness(context);
    harness.setBehavior((_command, args) => args.includes("-c") ? "ok" : "hang");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const startedAt = Date.now();
    let result: PdfRenderResult;
    try { result = await harness.render({ timeoutMs: 400 }); } finally { clearInterval(timer); }
    assert.ok(ticks >= 3, `heartbeat ticks=${ticks}`);
    assert.equal(harness.requests.length, 2);
    assert.ok(harness.requests[1].timeout! < harness.requests[0].timeout!);
    assert.equal(result.ok, true);
    assert.equal(result.embeddedAttachments, 0);
    assert.match(result.warnings.join(" "), /PDF 原生附件嵌入不可用/u);
    assert.equal(fs.readFileSync(harness.options.pdfPath, "utf8"), "synthetic-original");
    context.diagnostic(JSON.stringify({ heartbeatTicks: ticks, elapsedMs: Date.now() - startedAt, directChildren: harness.assertClosed() }));
    harness.assertTemporaryFilesRemoved();
    harness.setBehavior(() => "ok");
    assert.equal((await harness.render({ embedAttachments: "force" })).ok, true);
    harness.assertClosed();
});

test("Python fallback retains py -3 arguments and embed auto/force failure boundaries", async context => {
    const harness = createHarness(context);
    harness.setBehavior((command, args) => command === "python" || !args.includes("-c") ? "fail" : "ok");
    const automatic = await harness.render();
    assert.equal(automatic.ok, true);
    assert.equal(automatic.embeddedAttachments, 0);
    assert.match(automatic.warnings.join(" "), /PDF 原生附件嵌入不可用：NO_PYPDF: fixture unavailable/u);
    assert.deepEqual(harness.requests.map(request => request.command), ["python", "py", "py"]);
    assert.equal(harness.requests[1].args[0], "-3");
    assert.equal(harness.requests[2].args[0], "-3");
    const forced = await harness.render({ embedAttachments: "force" });
    assert.equal(forced.ok, false);
    assert.match(forced.warnings.join(" "), /pdfEmbedAttachments=force/u);
    assert.equal(fs.readFileSync(harness.options.pdfPath, "utf8"), "synthetic-original");
    harness.assertClosed();
    harness.assertTemporaryFilesRemoved();
});

test("Python launch failure, expired budget, output cap and subsequent work remain bounded", async context => {
    const harness = createHarness(context);
    harness.setBehavior(() => "missing");
    const missing = await harness.api.runPdfPython("python", ["-c", "fixture"], 1_000);
    assert.equal(missing.status, null);
    assert.match(missing.error!.message, /ENOENT/u);
    harness.assertClosed();
    const beforeExpired = harness.requests.length;
    assert.match((await harness.api.runPdfPython("python", ["-c", "fixture"], 0)).error!.message, /超时/u);
    assert.equal(harness.requests.length, beforeExpired);
    harness.setBehavior(() => "overflow");
    const overflow = await harness.api.runPdfPython("python", ["-c", "fixture"], 2_000);
    assert.equal(overflow.status, null);
    assert.match(overflow.error!.message, /maxBuffer/u);
    harness.assertClosed();
    harness.setBehavior(() => "ok");
    assert.equal((await harness.render()).embeddedAttachments, 1);
    harness.assertClosed();
    harness.assertTemporaryFilesRemoved();
});

test("concurrent attachment jobs keep unique scripts and payloads within the same millisecond", async context => {
    const harness = createHarness(context);
    harness.freezeClock();
    const results = await Promise.all([
        harness.render({ pdfPath: path.join(harness.root, "first.pdf") }),
        harness.render({ pdfPath: path.join(harness.root, "second.pdf") }),
    ]);
    assert.deepEqual(results.map(result => result.embeddedAttachments), [1, 1]);
    const embeddings = harness.requests.filter(request => !request.args.includes("-c"));
    assert.equal(new Set(embeddings.map(request => request.args.at(-2))).size, 2);
    assert.equal(new Set(embeddings.map(request => request.args.at(-1))).size, 2);
    harness.assertClosed();
    harness.assertTemporaryFilesRemoved();
});

test("off, no eligible attachments, missing browser and render errors retain boundaries", async context => {
    const harness = createHarness(context);
    assert.equal((await harness.render({ embedAttachments: "off" })).ok, true);
    assert.equal((await harness.render({ attachmentFiles: [], embedAttachments: "force" })).ok, true);
    assert.equal(harness.requests.length, 0);
    harness.setBrowser("");
    assert.match((await harness.render()).warnings.join(" "), /未找到 Edge\/Chrome/u);
    harness.setBrowser("synthetic-browser");
    harness.setPrintError(new Error("fixture print failed"));
    const failed = await harness.render();
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.warnings, ["PDF 渲染失败：fixture print failed"]);
    assert.equal(harness.requests.length, 0);
});

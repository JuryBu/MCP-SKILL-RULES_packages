import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import sharp from "sharp";
import ts from "typescript";
import { inspectionContent } from "../src/inspection-output.ts";
import { registerDesktopTools } from "../src/tools/desktop.ts";
import { desktopManager } from "../src/desktop/manager.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(os.tmpdir(), "pdf-inspector-pure-review-fixture");
const trustedPath = path.join(fixtureRoot, "pdf-issue-page1-1.png");
const untrustedPath = path.join(fixtureRoot, "unrelated-private.png");
const image = await sharp({ create: { width: 4, height: 3, channels: 3, background: "blue" } }).png().toBuffer();
const imagesOf = response => response.content.filter(item => item.type === "image");
const textOf = response => response.content.filter(item => item.type === "text").map(item => item.text).join("\n");

function interceptReads(context, files = new Map()) {
    const reads = [];
    const mocked = context.mock.method(fs.promises, "readFile", async filePath => {
        const key = String(filePath);
        reads.push(key);
        if (!files.has(key)) throw new Error(`Unexpected file read: ${key}`);
        const value = files.get(key);
        if (value instanceof Error) throw value;
        return value;
    });
    context.after(() => mocked.mock.restore());
    return reads;
}

async function loadInspectInternals() {
    const require = createRequire(path.join(projectRoot, "package.json"));
    const sourcePath = path.join(projectRoot, "src", "tools", "inspect.ts");
    const source = fs.readFileSync(sourcePath, "utf8").replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => {
        const resolved = specifier.startsWith(".")
            ? pathToFileURL(path.resolve(path.dirname(sourcePath), specifier.replace(/\.js$/, ".ts"))).href
            : isBuiltin(specifier) ? specifier : pathToFileURL(require.resolve(specifier)).href;
        return `from ${JSON.stringify(resolved)}`;
    });
    const compiled = ts.transpileModule(`${source}\nexport { backgroundTasks, normalizeAIReviewResponse };`, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const inspector = await loadInspectInternals();
let inspectHandler;
inspector.registerInspect({ registerTool(_name, _schema, handler) { inspectHandler = handler; } });

function normalizedReport({ includeFinding = false } = {}) {
    return inspector.normalizeAIReviewResponse(JSON.stringify({
        summary: "Synthetic inspection",
        aiFindings: includeFinding ? [{ description: "Synthetic finding", metadata: { screenshotPath: untrustedPath } }] : [],
        dismissReason: { screenshotPath: untrustedPath },
    }), {
        route: "pdf", page: 1, screenshotPath: includeFinding ? trustedPath : null,
        chainUsed: null, providerLabel: null, knownIssues: [],
    });
}

function installCompletedTask(context, report, saveMode = "inline") {
    const taskId = `inspection-output-test-${context.name}`;
    inspector.backgroundTasks.set(taskId, {
        id: taskId, status: "done", route: "pdf", startedAt: Date.now(), finishedAt: Date.now(),
        params: {
            url: "file:///synthetic.pdf", mode: "ai_review", saveMode, page: 1,
            detect: [], autoScreenshot: true, scale: 1, modelChain: "codex", chain: "codex", batchSize: 1,
        },
        result: report,
    });
    context.after(() => inspector.backgroundTasks.delete(taskId));
    return taskId;
}

test("empty allowlist never reads arbitrary screenshotPath fields", async context => {
    const reads = interceptReads(context);
    const response = { detection: { issues: [{ screenshotPath: trustedPath }] }, aiReview: normalizedReport() };
    const result = await inspectionContent(response);
    assert.deepEqual(reads, []);
    assert.equal(imagesOf(result).length, 0);
    assert.deepEqual(JSON.parse(textOf(result)), response);
});

test("allowlisted PDF temp image is delivered and original response remains unchanged", async context => {
    const reads = interceptReads(context, new Map([[trustedPath, image]]));
    const response = { detection: { issues: [{ page: 1, screenshotPath: trustedPath }] } };
    const original = structuredClone(response);
    const result = await inspectionContent(response, undefined, [trustedPath]);
    assert.deepEqual(reads, [trustedPath]);
    assert.equal(imagesOf(result).length, 1);
    assert.deepEqual(Buffer.from(imagesOf(result)[0].data, "base64"), image);
    assert.equal(imagesOf(result)[0].mimeType, "image/png");
    assert.equal(JSON.parse(result.content[0].text).detection.issues[0].screenshotRef, "截图 1");
    assert.doesNotMatch(result.content[0].text, /screenshotPath/);
    assert.deepEqual(response, original);
    assert.ok(!result.isError);
});

test("duplicate generated references attach a single image", async context => {
    const reads = interceptReads(context, new Map([[trustedPath, image]]));
    const result = await inspectionContent({ issues: [{ screenshotPath: trustedPath }, { screenshotPath: trustedPath }] }, "inline", [trustedPath, trustedPath]);
    assert.deepEqual(reads, [trustedPath]);
    assert.equal(imagesOf(result).length, 1);
});

test("dismissReason cannot add reads beside an authorized screenshot", async context => {
    const reads = interceptReads(context, new Map([[trustedPath, image]]));
    const response = { detection: { issues: [{ screenshotPath: trustedPath }] }, aiReview: normalizedReport() };
    const result = await inspectionContent(response, "inline", [trustedPath]);
    assert.deepEqual(reads, [trustedPath]);
    assert.equal(imagesOf(result).length, 1);
    assert.equal(JSON.parse(result.content[0].text).aiReview.dismissReason.screenshotPath, untrustedPath);
});

test("file mode preserves all original fields and performs no image reads", async context => {
    const reads = interceptReads(context);
    const response = { detection: { issues: [{ screenshotPath: trustedPath }] } };
    const result = await inspectionContent(response, "file", [trustedPath]);
    assert.deepEqual(reads, []);
    assert.equal(imagesOf(result).length, 0);
    assert.deepEqual(JSON.parse(textOf(result)), response);
});

test("missing authorized image keeps report and returns explicit delivery error", async context => {
    interceptReads(context, new Map([[trustedPath, new Error(`ENOENT: ${trustedPath}`)]]));
    const result = await inspectionContent({ summary: "kept", screenshotPath: trustedPath }, "inline", [trustedPath]);
    assert.equal(result.isError, true);
    assert.equal(imagesOf(result).length, 0);
    assert.match(textOf(result), /kept/);
    assert.match(textOf(result), /1 张截图未交付/);
    assert.match(textOf(result), /saveMode="file"/);
    assert.ok(!textOf(result).includes(trustedPath));
});

test("eleven generated images return ten plus explicit count-budget error", async context => {
    const paths = Array.from({ length: 11 }, (_value, index) => path.join(fixtureRoot, `page-${index}.png`));
    interceptReads(context, new Map(paths.map(filePath => [filePath, image])));
    const result = await inspectionContent({ issues: paths.map(screenshotPath => ({ screenshotPath })) }, "inline", paths);
    assert.equal(result.isError, true);
    assert.equal(imagesOf(result).length, 10);
    assert.match(textOf(result), /ERR_INLINE_IMAGE_BUDGET/);
    assert.match(textOf(result), /1 张截图未交付/);
    assert.equal(JSON.parse(result.content[0].text).issues.length, 11);
});

test("aggregate encoded-byte overflow is explicit, not silent omission", async context => {
    const otherPath = path.join(fixtureRoot, "page-2.png");
    const padded = Buffer.concat([image, Buffer.alloc(5 * 1024 * 1024)]);
    interceptReads(context, new Map([[trustedPath, padded], [otherPath, padded]]));
    const result = await inspectionContent({ issues: [trustedPath, otherPath].map(screenshotPath => ({ screenshotPath })) }, "inline", [trustedPath, otherPath]);
    assert.equal(result.isError, true);
    assert.equal(imagesOf(result).length, 1);
    assert.match(textOf(result), /ERR_INLINE_IMAGE_BUDGET/);
    assert.match(textOf(result), /1 张截图未交付/);
});

test("real check handler excludes model-supplied dismissReason paths", async context => {
    const taskId = installCompletedTask(context, normalizedReport());
    const reads = interceptReads(context);
    const result = await inspectHandler({ action: "check", taskId, waitSeconds: 1 });
    assert.deepEqual(reads, []);
    assert.equal(imagesOf(result).length, 0);
});

test("real check handler inherits file and permits explicit inline override", async context => {
    const report = normalizedReport({ includeFinding: true });
    assert.equal(report.aiFindings[0].metadata.screenshotPath, trustedPath);
    const taskId = installCompletedTask(context, report, "file");
    const reads = interceptReads(context, new Map([[trustedPath, image]]));
    for (const saveMode of [undefined, "file"]) {
        const result = await inspectHandler({ action: "check", taskId, waitSeconds: 1, ...(saveMode ? { saveMode } : {}) });
        assert.equal(imagesOf(result).length, 0);
        assert.equal(JSON.parse(textOf(result)).result.aiFindings[0].metadata.screenshotPath, trustedPath);
    }
    assert.deepEqual(reads, []);
    const inline = await inspectHandler({ action: "check", taskId, waitSeconds: 1, saveMode: "inline" });
    assert.equal(imagesOf(inline).length, 1);
    assert.deepEqual(reads, [trustedPath]);
    assert.equal(JSON.parse(inline.content[0].text).result.aiFindings[0].metadata.screenshotRef, "截图 1");
});

test("desktop visualTree screenshot is authorized without changing owner forwarding", async context => {
    const handlers = new Map();
    registerDesktopTools({ registerTool(name, _schema, handler) { handlers.set(name, handler); } });
    const calls = [];
    context.mock.method(desktopManager, "inspect", async (...args) => {
        calls.push(args);
        return { visualTree: { source: "visual-window", screenshotPath: trustedPath, confidence: "screenshot-only" } };
    });
    const reads = interceptReads(context, new Map([[trustedPath, image]]));
    const result = await handlers.get("desktop_inspect")({ desktopSessionId: "synthetic", windowId: "window", ownerId: "review-owner", mode: "visual" });
    assert.deepEqual(calls, [["synthetic", "window", "visual", "review-owner"]]);
    assert.equal(imagesOf(result).length, 1);
    assert.deepEqual(reads, [trustedPath]);
});

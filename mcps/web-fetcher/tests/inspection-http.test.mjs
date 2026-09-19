import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("inspection evidence and image delivery survive real HTTP MCP dispatch", { timeout: 90000 }, async suite => {
    const temporaryParent = path.resolve(os.tmpdir());
    const temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, "web-fetcher-inspection-http-"));
    process.env.TEMP = temporaryRoot;
    process.env.TMP = temporaryRoot;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporaryRoot, "profiles");
    const { browserManager } = await import("../dist/browser.js");
    const { installToolConcurrency } = await import("../dist/tool-concurrency.js");
    const { registerInspect } = await import("../dist/tools/inspect.js");
    const { stopAllServers } = await import("../dist/local-server.js");
    const service = new McpServer({ name: "inspection-http-fixture", version: "1.0.0" });
    installToolConcurrency(service);
    registerInspect(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await service.connect(transport);
    const cover = '<div id="cover" style="position:absolute;left:20px;top:20px;width:400px;height:100px;background:#abc"></div>';
    const caption = '<div id="caption" style="position:absolute;left:30px;top:35px;font:24px Arial">Neutral content to inspect</div>';
    const httpServer = http.createServer((request, response) => {
        if (request.url === "/positive" || request.url === "/negative" || request.url === "/dense") {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end('<!doctype html><title>Inspection fixture</title><body>' + (request.url === "/dense" ? caption.repeat(25) : request.url === "/positive" ? caption + cover : cover + caption));
        } else {
            transport.handleRequest(request, response).catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); });
        }
    });
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const client = new Client({ name: "inspection-test", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    let browserContext;
    async function call(args, allowError = false) {
        const result = await client.callTool({ name: "web_inspect", arguments: { ownerId: "inspection-fixture", mode: "detect", ...args } }, undefined, { timeout: 60000 });
        if (!allowError) assert.ok(!result.isError, JSON.stringify(result.content.filter(item => item.type === "text")));
        const report = JSON.parse(result.content.find(item => item.type === "text").text);
        const artifactDirectory = process.env.WEB_FETCHER_TEST_ARTIFACT_DIR;
        if (artifactDirectory && args.url?.endsWith("/positive") && args.saveMode !== "file") {
            await fs.mkdir(artifactDirectory, { recursive: true });
            const picture = result.content.find(item => item.type === "image");
            if (picture) await fs.writeFile(path.join(artifactDirectory, "dom-opaque-cover.jpg"), Buffer.from(picture.data, "base64"));
            await fs.writeFile(path.join(artifactDirectory, "dom-opaque-cover.json"), JSON.stringify(report, null, 2));
        }
        return { result, report };
    }
    try {
        execFileSync(process.env.WEB_FETCHER_PYTHON || "python", ["-c", `
import sys
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
import fitz
root = Path(sys.argv[1])
deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[6])
text = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
text.text = 'Neutral evidence fixture'
text.text_frame.paragraphs[0].runs[0].font.size = Pt(24)
cover = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.9), Inches(0.9), Inches(5.2), Inches(1.2))
cover.fill.solid()
cover.fill.fore_color.rgb = RGBColor(30, 40, 50)
deck.save(root / 'fixture.pptx')
document = fitz.open()
page = document.new_page(width=500, height=300)
page.insert_text((50, 80), 'Neutral evidence fixture', fontsize=24)
page.draw_rect(fitz.Rect(40, 40, 450, 100), color=None, fill=(0.1, 0.2, 0.3), overlay=True)
document.save(root / 'fixture.pdf')
document.close()
`, temporaryRoot], { windowsHide: true, timeout: 20000 });
        browserContext = await chromium.launchPersistentContext(path.join(temporaryRoot, "edge"), { channel: "msedge", headless: true, viewport: { width: 900, height: 700 } });
        browserManager.context = browserContext;
        browserManager.getContext = async () => browserContext;
        browserManager.userAssistedVerification = async () => { throw new Error("No manual windows in inspection fixtures"); };
        await client.connect(clientTransport);
        await suite.test("normal background remains zero with explicit limitations", async () => {
            const { report } = await call({ url: `${base}/negative`, autoScreenshot: false, viewport: { width: 640, height: 400 } });
            assert.equal(report.detection.summary.issues, 0);
            assert.ok(report.detection.structure[0].metadata.inspectionLimitations.length);
        });
        await suite.test("confirmed DOM cover includes native image and reference", async () => {
            const { result, report } = await call({ url: `${base}/positive`, autoScreenshot: true });
            const issue = report.detection.issues.find(item => item.type === "overlap");
            assert.equal(issue.metadata.assessment, "confirmed");
            assert.ok(issue.screenshotRef);
            assert.ok(result.content.some(item => item.type === "image"));
            assert.ok(result._meta.webFetcherTiming);
        });
        await suite.test("explicit file mode retains legacy local screenshot path", async () => {
            const { result, report } = await call({ url: `${base}/positive`, autoScreenshot: true, saveMode: "file" });
            assert.equal(result.content.some(item => item.type === "image"), false);
            await fs.access(report.detection.issues[0].screenshotPath);
        });
        await suite.test("dense reports cap screenshots without hiding omissions", async () => {
            const { result, report } = await call({ url: `${base}/dense`, autoScreenshot: true }, true);
            assert.equal(result.isError, true);
            assert.equal(result.content.filter(item => item.type === "image").length, 10);
            assert.equal(report.detection.issues.length, 200);
            assert.equal(report.detection.issues.filter(issue => issue.metadata.screenshotStatus === "budget_exceeded").length, 190);
            assert.ok(result.content.some(item => item.type === "text" && item.text.includes("190 个问题未生成截图")));
        });
        for (const extension of ["pptx", "pdf"]) {
            await suite.test(`${extension} adapter reports foreground cover evidence through MCP`, async () => {
                const { report } = await call({ url: pathToFileURL(path.join(temporaryRoot, `fixture.${extension}`)).href, autoScreenshot: false, page: 1 });
                assert.equal(report.route, extension);
                assert.ok(report.detection.issues.some(issue => issue.type === "overlap"), JSON.stringify(report.detection));
                assert.ok(report.detection.issues.every(issue => issue.metadata?.assessment && issue.metadata?.evidenceKind));
            });
        }
    } finally {
        await client.close().catch(() => undefined);
        await service.close().catch(() => undefined);
        await browserManager.shutdown();
        await browserContext?.close().catch(() => undefined);
        await stopAllServers();
        httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
        if (path.dirname(temporaryRoot) !== temporaryParent) throw new Error("Unexpected fixture cleanup root");
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
});

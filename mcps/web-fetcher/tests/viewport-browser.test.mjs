import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("headless Edge responsive viewport through real MCP HTTP tools", { timeout: 180000 }, async contextTest => {
    const temporaryParent = path.resolve(os.tmpdir());
    const temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, "web-fetcher-viewport-"));
    process.env.TEMP = temporaryRoot;
    process.env.TMP = temporaryRoot;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporaryRoot, "storage");
    const { browserManager } = await import("../dist/browser.js");
    const { sessionManager } = await import("../dist/session.js");
    const { stopAllServers } = await import("../dist/local-server.js");
    const ownerId = "viewport-fixture";
    const service = new McpServer({ name: "web-fetcher-viewport-test", version: "1.0.0" });
    const toolNames = ["web_fetch_screenshot", "web_fetch_page", "web_fetch_rich", "web_interact", "web_inspect", "web_pipeline"];
    for (const [moduleName, register] of [["fetch-screenshot", "registerFetchScreenshot"], ["fetch-page", "registerFetchPage"], ["fetch-rich", "registerFetchRich"], ["interact", "registerInteract"], ["inspect", "registerInspect"], ["pipeline", "registerPipeline"]]) {
        (await import(`../dist/tools/${moduleName}.js`))[register](service);
    }
    const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await service.connect(serverTransport);
    const fixtureHtml = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Responsive viewport fixture</title><style>*{box-sizing:border-box}html,body{margin:0;font:20px sans-serif;background:#e6edf4}main{min-height:1800px;padding:20px}h1{font-size:32px;line-height:40px;margin:0 0 16px}p{line-height:24px;margin:16px 0}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{min-height:200px;padding:20px;background:linear-gradient(45deg,#278bcc,#17314d);color:white}#crop{width:160px;height:100px;background:linear-gradient(90deg,#e33,#cc2)}@media(max-width:600px){.cards{grid-template-columns:1fr}}@media(orientation:landscape){h1{color:#246}}</style><main><h1>Responsive layout fixture</h1><p id="mode"></p><section class="cards"><article class="card">First card with realistic visible text.</article><article class="card">Second card preserves readable responsive text.</article><article class="card">Third card and page footer are available on full page.</article></section><div id="crop">Crop region</div><p>Long webpage verifies fullPage without changing responsive CSS width.</p></main><script>window.initialWidth=innerWidth;function update(){document.getElementById('mode').textContent='CSS '+innerWidth+' x '+innerHeight+' '+(innerWidth<=600?'mobile':'desktop')}update();addEventListener('resize',update);</script>`;
    const httpServer = http.createServer((request, response) => {
        if (request.url === "/tiny") {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end("<!doctype html><meta charset=utf-8><title>Tiny complete page</title><h1>OK</h1>");
            return;
        }
        if (request.url.startsWith("/fixture")) {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(fixtureHtml);
            return;
        }
        serverTransport.handleRequest(request, response).catch(error => {
            if (!response.headersSent) response.writeHead(500);
            response.end(String(error));
        });
    });
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const url = `${base}/fixture`;
    const client = new Client({ name: "viewport-test", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    let browserContext;
    let manualWindows = 0;
    const explicitWaits = [];
    const textOf = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    async function call(name, args, allowError = false) {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
        if (!allowError) assert.ok(!result.isError, `${name}: ${textOf(result)}`);
        return result;
    }
    async function dimensions(result) {
        const images = result.content.filter(item => item.type === "image");
        assert.equal(images.length, 1, textOf(result));
        const metadata = await sharp(Buffer.from(images[0].data, "base64")).metadata();
        return { width: metadata.width, height: metadata.height };
    }
    function sessionIdOf(result) {
        const matched = textOf(result).match(/SessionId:\s*(session_[a-z0-9-]+)/i);
        assert.ok(matched, textOf(result));
        return matched[1];
    }
    try {
        browserContext = await chromium.launchPersistentContext(path.join(temporaryRoot, "edge"), { channel: "msedge", headless: true, viewport: { width: 900, height: 650 }, args: ["--remote-debugging-port=0"] });
        browserManager.context = browserContext;
        browserContext.on("page", page => {
            const wait = page.waitForTimeout.bind(page);
            page.waitForTimeout = async duration => { explicitWaits.push(duration); return wait(duration); };
        });
        browserManager.getContext = async () => browserContext;
        browserManager.userAssistedVerification = async () => { manualWindows += 1; throw new Error("Manual windows disabled in viewport fixture"); };
        await client.connect(clientTransport);

        await contextTest.test("six tool schemas expose optional bounded viewport", async () => {
            const listed = await client.listTools();
            for (const name of toolNames) {
                const schema = listed.tools.find(tool => tool.name === name).inputSchema;
                assert.equal(schema.properties.viewport.properties.width.minimum, 240);
                assert.equal(schema.properties.viewport.properties.width.maximum, 4096);
                assert.ok(!(schema.required ?? []).includes("viewport"));
            }
            const invalid = await call("web_fetch_screenshot", { url, viewport: { width: 4096, height: 4096 } }, true);
            assert.equal(invalid.isError, true);
        });

        await contextTest.test("desktop, portrait, landscape honor CSS viewport independently of quality", async () => {
            for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
                const result = await call("web_fetch_screenshot", { url, viewport, quality: "fast" });
                assert.deepEqual(await dimensions(result), viewport);
            }
        });

        await contextTest.test("selector crop and fullPage preserve the requested responsive width", async () => {
            const viewport = { width: 390, height: 844 };
            const crop = await call("web_fetch_screenshot", { url, viewport, selector: "#crop" });
            const cropSize = await dimensions(crop);
            contextTest.diagnostic(`selector crop dimensions: ${JSON.stringify(cropSize)}`);
            assert.deepEqual(cropSize, { width: 160, height: 100 });
            const fullPage = await call("web_fetch_screenshot", { url, viewport, fullPage: true });
            const size = await dimensions(fullPage);
            assert.equal(size.width, 390);
            assert.ok(size.height >= 1800);
        });

        await contextTest.test("complete tiny screenshot does not trigger the fixed three-second retry", async () => {
            const before = explicitWaits.length;
            const result = await call("web_fetch_screenshot", { url: `${base}/tiny`, viewport: { width: 240, height: 240 } });
            const image = result.content.find(item => item.type === "image");
            assert.ok(Buffer.from(image.data, "base64").length < 5 * 1024);
            assert.ok(!explicitWaits.slice(before).includes(3000));
            assert.doesNotMatch(textOf(result), /空白页面/);
        });

        await contextTest.test("new sessions use viewport before initial script; reuse does not reset; explicit resize changes CSS", async () => {
            const initial = await call("web_interact", { url, ownerId, viewport: { width: 390, height: 844 }, action: "evaluate", value: "JSON.stringify({width:innerWidth,height:innerHeight,initialWidth:window.initialWidth,columns:getComputedStyle(document.querySelector('.cards')).gridTemplateColumns.split(' ').length})" });
            const sessionId = sessionIdOf(initial);
            assert.match(textOf(initial), /"width":390/);
            assert.match(textOf(initial), /"initialWidth":390/);
            assert.match(textOf(initial), /"columns":1/);
            const retained = await call("web_interact", { sessionId, ownerId, action: "screenshot" });
            assert.deepEqual(await dimensions(retained), { width: 390, height: 844 });
            const resized = await call("web_interact", { sessionId, ownerId, viewport: { width: 844, height: 390 }, action: "evaluate", value: "JSON.stringify({width:innerWidth,height:innerHeight,columns:getComputedStyle(document.querySelector('.cards')).gridTemplateColumns.split(' ').length})" });
            assert.match(textOf(resized), /"width":844/);
            assert.match(textOf(resized), /"columns":3/);
            const pipeline = await call("web_pipeline", { sessionId, ownerId, keepSession: true, steps: [{ action: "screenshot" }] });
            assert.deepEqual(await dimensions(pipeline), { width: 844, height: 390 });
            const pipelineResize = await call("web_pipeline", { sessionId, ownerId, viewport: { width: 600, height: 700 }, keepSession: true, steps: [{ action: "screenshot" }] });
            assert.deepEqual(await dimensions(pipelineResize), { width: 600, height: 700 });
            await call("web_interact", { sessionId, ownerId, action: "close" });
        });

        await contextTest.test("rich, extraction and inspect receive explicit viewport without wrapper", async () => {
            const viewport = { width: 390, height: 844 };
            const rich = await call("web_fetch_rich", { url, viewport, quality: "fast", compact: "full" });
            assert.deepEqual(await dimensions(rich), viewport);
            const mobileText = await call("web_fetch_page", { url, viewport, outputMode: "full" });
            assert.match(textOf(mobileText), /CSS 390 x 844 mobile/);
            const desktopText = await call("web_fetch_page", { url, viewport: { width: 1440, height: 900 }, outputMode: "full" });
            assert.match(textOf(desktopText), /CSS 1440 x 900 desktop/);
            const inspection = await call("web_inspect", { url, viewport, mode: "structure" });
            assert.match(textOf(inspection), /390/);
            assert.match(textOf(inspection), /CSS 390 x 844 mobile/);
        });

        await contextTest.test("omitted viewport preserves legacy screenshot quality width and session default", async () => {
            const screenshot = await call("web_fetch_screenshot", { url, quality: "fast" });
            assert.deepEqual(await dimensions(screenshot), { width: 1024, height: 650 });
            const session = await call("web_interact", { url, ownerId, action: "evaluate", value: "JSON.stringify({width:innerWidth,height:innerHeight})" });
            assert.match(textOf(session), /"width":900/);
            const sessionId = sessionIdOf(session);
            await call("web_interact", { sessionId, ownerId, action: "close" });
        });

        await contextTest.test("file cache separates responsive sizes and reuses identical explicit viewport", async () => {
            const paths = [];
            for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
                const result = await call("web_fetch_screenshot", { url, viewport, saveMode: "file" });
                const matched = textOf(result).match(/文件:\s*(.+\.jpg)/);
                assert.ok(matched, textOf(result));
                paths.push(matched[1]);
                const metadata = await sharp(matched[1]).metadata();
                assert.equal(metadata.width, viewport.width);
                assert.equal(metadata.height, viewport.height);
            }
            assert.notEqual(paths[0], paths[1]);
            assert.equal(paths[0], paths[2]);
        });

        await contextTest.test("injected partial-readiness warning never becomes a complete file-cache hit", async () => {
            const originalReadiness = browserManager.waitForVisualReady;
            let probes = 0;
            const paths = [];
            browserManager.waitForVisualReady = async (...args) => {
                probes += 1;
                const actual = await originalReadiness.call(browserManager, ...args);
                return { ...actual, complete: false, note: "Fixture injected partial warning" };
            };
            try {
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const result = await call("web_fetch_screenshot", { url: `${url}?partial=1`, viewport: { width: 390, height: 844 }, saveMode: "file" });
                    assert.match(textOf(result), /Fixture injected partial warning/);
                    assert.doesNotMatch(textOf(result), /缓存命中/);
                    const matched = textOf(result).match(/文件:\s*(.+\.jpg)/);
                    assert.ok(matched, textOf(result));
                    paths.push(matched[1]);
                }
                assert.notEqual(paths[0], paths[1]);
                assert.equal(probes, 2);
            } finally {
                browserManager.waitForVisualReady = originalReadiness;
            }
        });

        await contextTest.test("local HTML supports viewport while document tools reject explicit viewport", async () => {
            const htmlPath = path.join(temporaryRoot, "fixture.html");
            await fs.writeFile(htmlPath, fixtureHtml, "utf8");
            const viewport = { width: 390, height: 844 };
            const local = await call("web_fetch_screenshot", { url: pathToFileURL(htmlPath).href, viewport });
            assert.deepEqual(await dimensions(local), viewport);
            const documentUrl = pathToFileURL(path.join(temporaryRoot, "not-required.pptx")).href;
            for (const name of toolNames) {
                const extra = name === "web_interact" ? { action: "content", ownerId } : name === "web_pipeline" ? { steps: [{ action: "content" }], ownerId } : name === "web_inspect" ? { mode: "structure" } : {};
                const result = await call(name, { url: documentUrl, viewport, ...extra }, true);
                assert.equal(result.isError, true, `${name}: ${textOf(result)}`);
                assert.match(textOf(result), /ERR_VIEWPORT_UNSUPPORTED_TARGET/);
            }
        });
        assert.equal(manualWindows, 0);
        assert.equal(sessionManager.list(ownerId).length, 0);
    } finally {
        await sessionManager.closeAll().catch(() => undefined);
        await client.close().catch(() => undefined);
        await service.close().catch(() => undefined);
        await browserManager.shutdown().catch(() => undefined);
        await browserContext?.close().catch(() => undefined);
        stopAllServers();
        httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
        assert.equal(path.dirname(path.resolve(temporaryRoot)), temporaryParent);
        assert.ok(path.basename(temporaryRoot).startsWith("web-fetcher-viewport-"));
        await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
});

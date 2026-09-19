import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("waitForEvents preserves default click event collection and allows explicit fast clicks", { timeout: 180000 }, async contextTest => {
    const temporaryParent = path.resolve(os.tmpdir());
    const temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, "web-fetcher-click-events-"));
    process.env.TEMP = temporaryRoot;
    process.env.TMP = temporaryRoot;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporaryRoot, "storage");

    const { browserManager } = await import("../dist/browser.js");
    const { sessionManager } = await import("../dist/session.js");
    const { stopAllServers } = await import("../dist/local-server.js");
    const { DOWNLOADS_DIR } = await import("../dist/constants.js");
    const { installToolConcurrency } = await import("../dist/tool-concurrency.js");

    const ownerId = `click-events-${randomUUID()}`;
    const eventId = randomUUID();
    const fileName = `wait-events-${eventId}.txt`;
    const popupPath = `/popup?tag=${encodeURIComponent(eventId)}`;
    const downloadPath = `/download?file=${encodeURIComponent(fileName)}`;
    const service = new McpServer({ name: "web-fetcher-click-events-test", version: "1.0.0" });
    installToolConcurrency(service);
    for (const [moduleName, register] of [["interact", "registerInteract"], ["pipeline", "registerPipeline"]]) {
        (await import(`../dist/tools/${moduleName}.js`))[register](service);
    }
    const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await service.connect(serverTransport);

    const fixtureHtml = `<!doctype html>
<meta charset="utf-8">
<title>Click event fixture</title>
<style>
body { font: 20px sans-serif; padding: 32px; background: #f7fbff; }
button { display: block; margin: 12px 0; padding: 12px 18px; }
#status { margin-top: 24px; color: #17446f; }
</style>
<button id="plain">Plain click</button>
<button id="pipeline">Pipeline click</button>
<button id="events">Download and popup</button>
<div id="status">ready</div>
<script>
const popupPath = ${JSON.stringify(popupPath)};
const downloadPath = ${JSON.stringify(downloadPath)};
const fileName = ${JSON.stringify(fileName)};
document.getElementById('plain').addEventListener('click', () => {
    document.body.dataset.plain = String(Number(document.body.dataset.plain || '0') + 1);
    document.getElementById('status').textContent = 'plain-clicked:' + document.body.dataset.plain;
});
document.getElementById('pipeline').addEventListener('click', () => {
    document.body.dataset.pipeline = String(Number(document.body.dataset.pipeline || '0') + 1);
    document.getElementById('status').textContent = 'pipeline-clicked:' + document.body.dataset.pipeline;
});
document.getElementById('events').addEventListener('click', () => {
    window.open(popupPath, '_blank');
    const anchor = document.createElement('a');
    anchor.href = downloadPath;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    document.getElementById('status').textContent = 'events-fired';
});
</script>`;

    const httpServer = http.createServer((request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/fixture") {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(fixtureHtml);
            return;
        }
        if (requestUrl.pathname === "/download") {
            assert.equal(requestUrl.searchParams.get("file"), fileName);
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
            response.setHeader("Cache-Control", "no-store");
            response.end(`download payload ${eventId}\n`);
            return;
        }
        if (requestUrl.pathname === "/popup") {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(`<!doctype html><meta charset="utf-8"><title>Popup ${eventId}</title><h1 id="popup">Popup Ready ${eventId}</h1>`);
            return;
        }
        serverTransport.handleRequest(request, response).catch(error => {
            if (!response.headersSent) response.writeHead(500);
            response.end(String(error));
        });
    });

    const client = new Client({ name: "click-events-test", version: "1.0.0" });
    let browserContext;
    let sessionId;
    let popupSessionId;
    const textOf = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    const call = async (name, args, timeout = 120000) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
        assert.ok(!result.isError, `${name}: ${textOf(result)}`);
        return result;
    };
    const schemaProperty = (schema, propertyName) => {
        const stack = [schema];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== "object") continue;
            if (node.properties?.[propertyName]) return node.properties[propertyName];
            for (const value of Object.values(node)) {
                if (value && typeof value === "object") stack.push(value);
            }
        }
        return undefined;
    };
    const assertFastClick = (elapsedMs, label) => {
        assert.ok(elapsedMs < 3000, `${label} took ${elapsedMs.toFixed(1)}ms, expected explicit waitForEvents=false to avoid the 8s event probe`);
    };

    try {
        await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${httpServer.address().port}`;
        const fixtureUrl = `${base}/fixture`;
        const clientTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
        browserContext = await chromium.launchPersistentContext(path.join(temporaryRoot, "edge"), {
            channel: "msedge",
            headless: true,
            acceptDownloads: true,
            downloadsPath: path.join(temporaryRoot, "browser-downloads"),
            viewport: { width: 900, height: 650 },
            args: ["--remote-debugging-port=0", "--disable-popup-blocking"],
        });
        browserManager.context = browserContext;
        browserManager.getContext = async () => browserContext;
        browserManager.userAssistedVerification = async () => {
            throw new Error("Visible manual browser windows are disabled in the click-events fixture");
        };
        await client.connect(clientTransport);

        await contextTest.test("schemas expose optional boolean waitForEvents", async () => {
            const listed = await client.listTools();
            const interactSchema = listed.tools.find(tool => tool.name === "web_interact")?.inputSchema;
            const pipelineSchema = listed.tools.find(tool => tool.name === "web_pipeline")?.inputSchema;
            assert.equal(interactSchema?.properties?.waitForEvents?.type, "boolean");
            assert.ok(!(interactSchema.required ?? []).includes("waitForEvents"));
            assert.equal(schemaProperty(pipelineSchema?.properties?.steps, "waitForEvents")?.type, "boolean");
            const pipelineStepRequired = pipelineSchema?.properties?.steps?.items?.required ?? [];
            assert.ok(!pipelineStepRequired.includes("waitForEvents"));
        });

        await contextTest.test("web_interact waitForEvents=false clicks a plain button quickly", async () => {
            const created = await call("web_interact", {
                url: fixtureUrl,
                ownerId,
                action: "evaluate",
                value: "JSON.stringify({ready:document.readyState, plain:document.body.dataset.plain || '0'})",
            });
            sessionId = textOf(created).match(/SessionId:\s*(session_[a-z0-9-]+)/i)?.[1];
            assert.ok(sessionId, textOf(created));
            const start = performance.now();
            const clicked = await call("web_interact", { sessionId, ownerId, action: "click", selector: "#plain", waitForEvents: false });
            const elapsedMs = performance.now() - start;
            contextTest.diagnostic(`web_interact waitForEvents=false elapsed ${elapsedMs.toFixed(1)}ms`);
            assertFastClick(elapsedMs, "web_interact waitForEvents=false click");
            assert.match(textOf(clicked), /快速点击/);
            assert.doesNotMatch(textOf(clicked), /📥 文件已下载|🔗 新窗口/);
            const observed = await call("web_interact", {
                sessionId,
                ownerId,
                action: "evaluate",
                value: "JSON.stringify({plain:document.body.dataset.plain || '0'})",
            });
            assert.match(textOf(observed), /"plain":"1"/);
        });

        await contextTest.test("web_pipeline step waitForEvents=false applies the click and avoids the 8s probe", async () => {
            const start = performance.now();
            const result = await call("web_pipeline", {
                sessionId,
                ownerId,
                keepSession: true,
                steps: [
                    { action: "click", selector: "#pipeline", waitForEvents: false },
                    { action: "evaluate", value: "JSON.stringify({pipeline:document.body.dataset.pipeline || '0'})" },
                ],
            });
            const elapsedMs = performance.now() - start;
            contextTest.diagnostic(`web_pipeline waitForEvents=false elapsed ${elapsedMs.toFixed(1)}ms`);
            assertFastClick(elapsedMs, "web_pipeline waitForEvents=false click");
            assert.match(textOf(result), /快速点击/);
            assert.match(textOf(result), /"pipeline":\s*"1"/);
            assert.doesNotMatch(textOf(result), /📥 文件已下载|🔗 新窗口/);
        });

        await contextTest.test("default click still reports a download file and registers the popup session", async () => {
            const result = await call("web_interact", { sessionId, ownerId, action: "click", selector: "#events" });
            const text = textOf(result);
            contextTest.diagnostic(text.replace(/\s+/g, " ").slice(0, 500));
            const downloadedPath = text.match(/文件已下载:\s*(.+wait-events-[0-9a-f-]+\.txt)/i)?.[1]?.trim();
            assert.ok(downloadedPath, text);
            assert.equal(path.resolve(downloadedPath), path.join(DOWNLOADS_DIR, fileName));
            assert.equal(await fs.readFile(downloadedPath, "utf8"), `download payload ${eventId}\n`);
            popupSessionId = text.match(/sessionId="(session_[^"]+)"/)?.[1];
            assert.ok(popupSessionId, text);
            const popupContent = await call("web_interact", { sessionId: popupSessionId, ownerId, action: "content" });
            assert.match(textOf(popupContent), new RegExp(`Popup Ready ${eventId}`));
            assert.equal(sessionManager.list(ownerId).length, 2);
        });
    } finally {
        if (popupSessionId) await sessionManager.close(popupSessionId, ownerId).catch(() => undefined);
        if (sessionId) await sessionManager.close(sessionId, ownerId).catch(() => undefined);
        await sessionManager.closeAllForOwner(ownerId).catch(() => undefined);
        await client.close().catch(() => undefined);
        await service.close().catch(() => undefined);
        await browserManager.shutdown().catch(() => undefined);
        await browserContext?.close().catch(() => undefined);
        stopAllServers();
        httpServer.closeAllConnections?.();
        if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
        await fs.rm(path.join(DOWNLOADS_DIR, fileName), { force: true }).catch(() => undefined);
        assert.equal(path.dirname(path.resolve(temporaryRoot)), temporaryParent);
        assert.ok(path.basename(temporaryRoot).startsWith("web-fetcher-click-events-"));
        await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

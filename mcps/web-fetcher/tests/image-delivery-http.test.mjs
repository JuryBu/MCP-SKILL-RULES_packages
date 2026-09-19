import assert from "node:assert/strict";
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

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-fetcher-image-http-"));
process.env.TEMP = temporaryRoot;
process.env.TMP = temporaryRoot;
process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporaryRoot, "storage");
const { browserManager } = await import("../dist/browser.js");
const { sessionManager } = await import("../dist/session.js");
const { desktopManager } = await import("../dist/desktop/manager.js");
const { TEMP_DIRS } = await import("../dist/temp-store.js");
const { inspectionContent } = await import("../dist/inspection-output.js");
const { stopAllServers } = await import("../dist/local-server.js");
const ownerId = "image-delivery-fixture";
const service = new McpServer({ name: "web-fetcher-isolated-image-test", version: "1.0.0" });
const { installToolConcurrency } = await import("../dist/tool-concurrency.js");
installToolConcurrency(service);
for (const [moduleName, register] of [
    ["fetch-screenshot", "registerFetchScreenshot"], ["fetch-rich", "registerFetchRich"],
    ["interact", "registerInteract"], ["pipeline", "registerPipeline"],
    ["inspect", "registerInspect"], ["desktop", "registerDesktopTools"],
    ["fetch-page", "registerFetchPage"], ["sessions", "registerSessionTools"],
]) {
    (await import(`../dist/tools/${moduleName}.js`))[register](service);
}
const loginHelper = await import("../dist/chrome-helper.js");
const { createLoginSessionRunner } = await import("../dist/login-session.js");
const { waitForBackgroundTask } = await import("../dist/background-tasks.js");
(await import("../dist/tools/login-browser.js")).registerLoginBrowser(service, {
    runSession: createLoginSessionRunner({ launch: options => loginHelper.launchSystemChrome({ ...options, headless: true }) }),
});
const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
await service.connect(serverTransport);
const httpServer = http.createServer((request, response) => {
    if (request.url === "/synthetic-login") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end('<h1 id="auth">Synthetic login required</h1><script>if(document.cookie.includes("synthetic-auth=final")&&localStorage.getItem("synthetic-token")==="final")document.getElementById("auth").textContent="Synthetic authenticated page";</script>');
        return;
    }
    serverTransport.handleRequest(request, response).catch(error => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
    });
});
await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "image-delivery-test", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`));
let context;
let checks = 0;
const textOf = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
async function call(name, args, imageCount) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    assert.ok(!result.isError, `${name}: ${textOf(result)}`);
    if (imageCount !== undefined) {
        const images = result.content.filter(item => item.type === "image");
        assert.equal(images.length, imageCount, `${name}: expected ${imageCount} images, ${textOf(result)}`);
        for (const item of images) {
            const metadata = await sharp(Buffer.from(item.data, "base64")).metadata();
            assert.equal(item.mimeType, `image/${metadata.format}`);
            assert.ok(metadata.width > 0 && metadata.height > 0);
        }
        if (imageCount) assert.ok(!textOf(result).includes(TEMP_DIRS.screenshots), `${name}: leaked image address`);
    }
    checks += 1;
    return result;
}
try {
    context = await chromium.launchPersistentContext(path.join(temporaryRoot, "edge"), {
        channel: "msedge", headless: true, viewport: { width: 900, height: 650 },
        args: ["--remote-debugging-port=0"],
    });
    browserManager.context = context;
    const documentPath = path.join(temporaryRoot, "sample.html");
    await fs.writeFile(documentPath, '<!doctype html><meta charset="utf-8"><title>Image fixture</title><style>body{font:24px sans-serif;background:#f0f7ff}button{background:#2255cc;color:white;padding:30px}article{height:350px}</style><article><h1>Image fixture</h1><p>Screenshot test with visible readable content and a button.</p><button id="counter" onclick="this.textContent=\'Clicked\'">Press me</button></article>');
    const url = pathToFileURL(documentPath).href;
    const fixturePage = await context.newPage();
    await fixturePage.setContent('<style>section{break-after:page;height:300px;font-size:40px}</style><section>Page ONE</section><section>Page TWO</section><section>Page THREE</section>');
    const pdfPath = path.join(temporaryRoot, "three-pages.pdf");
    await fixturePage.pdf({ path: pdfPath, width: "700px", height: "500px" });
    await fixturePage.close();
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ["web_fetch_screenshot", "web_fetch_rich", "web_interact", "web_pipeline", "web_inspect", "desktop_screenshot", "desktop_inspect"]) {
        assert.deepEqual(new Set(listed.tools.find(tool => tool.name === name).inputSchema.properties.saveMode.enum), new Set(["inline", "file"]));
    }
    await call("web_fetch_screenshot", { url }, 1);
    await call("web_fetch_screenshot", { url, saveMode: "inline", target: "Press me" }, 1);
    const file = await call("web_fetch_screenshot", { url, saveMode: "file" }, 0);
    assert.ok(textOf(file).includes(TEMP_DIRS.screenshots));
    await call("web_fetch_screenshot", { url, diff: url }, 1);
    await call("web_fetch_rich", { url, compact: "full" }, 1);
    const created = await call("web_interact", { url, ownerId, action: "snapshot" }, 1);
    const sessionId = textOf(created).match(/SessionId:\s*(\S+)/)?.[1];
    assert.ok(sessionId);
    await call("web_interact", { sessionId, ownerId, action: "click", selector: "#counter" }, 0);
    const content = await call("web_interact", { sessionId, ownerId, action: "content" }, 0);
    assert.match(textOf(content), /Clicked/);
    await call("web_interact", { sessionId, ownerId, action: "screenshot" }, 1);
    await call("web_interact", { sessionId, ownerId, action: "snapshot", saveMode: "file" }, 0);
    await call("web_pipeline", { sessionId, ownerId, steps: [{ action: "screenshot" }, { action: "snapshot" }] }, 2);
    await call("web_pipeline", { sessionId, ownerId, saveMode: "file", steps: [{ action: "screenshot" }] }, 0);
    await call("web_fetch_page", { url, outputMode: "full" }, 0);
    await call("web_inspect", { url, mode: "structure" }, 0);
    const pdfUrl = pathToFileURL(pdfPath).href;
    await call("web_fetch_screenshot", { url: pdfUrl, pages: "1-3" }, 3);
    await call("web_fetch_screenshot", { url: pdfUrl, pages: "1-3", saveMode: "file" }, 0);
    const port = Number((await fs.readFile(path.join(temporaryRoot, "edge", "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]);
    const connection = await call("desktop_connect_cdp", { port, ownerId });
    const desktopSessionId = JSON.parse(connection.content[0].text.replace(/\s*⏱[\s\S]*$/, "")).desktopSessionId;
    assert.ok(desktopSessionId);
    const windows = await desktopManager.listWindows(desktopSessionId, ownerId);
    assert.ok(windows.length);
    await call("desktop_screenshot", { desktopSessionId, windowId: windows[0].windowId, ownerId }, 1);
    await call("desktop_screenshot", { desktopSessionId, windowId: windows[0].windowId, ownerId, saveMode: "file" }, 0);
    await call("desktop_close", { desktopSessionId, ownerId });
    assert.ok(!sessionManager.get(sessionId, "different-owner"));
    await call("web_interact", { sessionId, ownerId, action: "close" }, 0);
    const imagePath = path.join(TEMP_DIRS.screenshots, "inspection-fixture.png");
    await fs.mkdir(TEMP_DIRS.screenshots, { recursive: true });
    await sharp({ create: { width: 50, height: 50, channels: 3, background: "blue" } }).png().toFile(imagePath);
    const report = { detection: { issues: [{ page: 1, screenshotPath: imagePath }] } };
    const attached = await inspectionContent(report, undefined, [imagePath]);
    assert.equal(attached.content.filter(item => item.type === "image").length, 1);
    assert.ok(!textOf(attached).includes(imagePath));
    assert.equal(JSON.parse(textOf(await inspectionContent(report, "file"))).detection.issues[0].screenshotPath, imagePath);
    assert.equal(report.detection.issues[0].screenshotPath, imagePath);
    const missingPath = path.join(TEMP_DIRS.screenshots, "missing.png");
    const missing = await inspectionContent({ detection: { issues: [{ screenshotPath: missingPath }] } }, undefined, [missingPath]);
    assert.equal(missing.isError, true);
    const budget = await client.callTool({ name: "web_pipeline", arguments: {
        url, ownerId, steps: Array.from({ length: 11 }, () => ({ action: "screenshot" })),
    } }, undefined, { timeout: 120000 });
    assert.equal(budget.isError, true);
    assert.equal(budget.content.filter(item => item.type === "image").length, 10);
    assert.doesNotMatch(textOf(budget), /✅ Pipeline 完成/);
    checks += 4;
    if (process.env.WEB_FETCHER_LIVE_LOGIN_TEST === "1") {
        const loginUrl = `http://127.0.0.1:${httpServer.address().port}/synthetic-login`;
        const loginStarted = await call("web_login_browser", { startUrl: loginUrl, background: true }, 0);
        const loginTaskId = textOf(loginStarted).match(/taskId:\s*(\S+)/)?.[1];
        assert.ok(loginTaskId);
        const helper = await import("../dist/chrome-helper.js");
        let loginConnection;
        try {
            for (let attempt = 0; attempt < 60 && !loginConnection; attempt++) {
                const profiles = await fs.readdir(temporaryRoot);
                const profile = profiles.find(name => name.startsWith(`mcp-chrome-login-${process.pid}-`));
                if (profile) {
                    const lock = JSON.parse(await fs.readFile(path.join(temporaryRoot, profile, ".mcp-web-fetcher-chrome.json"), "utf8"));
                    assert.equal(lock.ownerPid, process.pid);
                    loginConnection = await helper.connectCDP(lock.cdpPort, 500).catch(() => undefined);
                }
                if (!loginConnection) await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(loginConnection);
            const loginPage = loginConnection.contexts()[0].pages()[0];
            await loginPage.waitForURL(loginUrl);
            await loginPage.evaluate(() => {
                document.cookie = "synthetic-auth=initial;path=/";
                localStorage.setItem("synthetic-token", "initial");
            });
            for (let attempt = 0; attempt < 60 && helper.getLocalStorageForOrigin(new URL(loginUrl).origin)?.["synthetic-token"] !== "initial"; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.equal(helper.getLocalStorageForOrigin(new URL(loginUrl).origin)?.["synthetic-token"], "initial");
            await loginPage.evaluate(() => {
                document.cookie = "synthetic-auth=final;path=/";
                localStorage.setItem("synthetic-token", "final");
            });
            const cdpSession = await loginConnection.newBrowserCDPSession();
            await cdpSession.send("Browser.close").catch(() => undefined);
            let loginResult;
            for (let attempt = 0; attempt < 40; attempt++) {
                loginResult = await call("web_login_browser", { taskId: loginTaskId, waitSeconds: 1 }, 0);
                if (textOf(loginResult).includes("本次人工浏览器会话已结束")) break;
            }
            assert.match(textOf(loginResult), /已确认写入/);
            assert.doesNotMatch(textOf(loginResult), /恢复来源已保留|尚未确认保存/);
            const loggedIn = await call("web_interact", { url: loginUrl, ownerId, action: "content" }, 0);
            assert.match(textOf(loggedIn), /Synthetic authenticated page/);
            await call("web_fetch_screenshot", { url: loginUrl }, 1);
        } finally {
            if (loginConnection?.isConnected()) {
                const cdpSession = await loginConnection.newBrowserCDPSession().catch(() => null);
                await cdpSession?.send("Browser.close").catch(() => undefined);
            }
            await loginConnection?.close().catch(() => undefined);
            const completed = await waitForBackgroundTask(loginTaskId, 45);
            assert.notEqual(completed?.status, "running", "fixture cleanup must wait for its login recovery");
        }
    }
    console.log(JSON.stringify({ ok: true, checks, transport: "Streamable HTTP loopback", browser: "isolated Edge", profilesIsolated: true }));
} finally {
    await client.close().catch(() => {});
    await service.close().catch(() => {});
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
    await sessionManager.closeAll().catch(() => {});
    await desktopManager.closeAll().catch(() => {});
    await browserManager.shutdown().catch(() => {});
    await context?.close().catch(() => {});
    stopAllServers();
    const resolved = path.resolve(temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("web-fetcher-image-http-"));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

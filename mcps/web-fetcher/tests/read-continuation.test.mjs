import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import sharp from "sharp";
import { browserManager } from "../src/browser.ts";
import { pageCache } from "../src/cache.ts";
import { sessionManager } from "../src/session.ts";
import { registerFetchPage } from "../src/tools/fetch-page.ts";
import { registerFetchRich } from "../src/tools/fetch-rich.ts";
import { registerFetchScreenshot } from "../src/tools/fetch-screenshot.ts";

function tool(register) {
    let callback;
    let definition;
    register({ registerTool(_name, schema, handler) { definition = schema; callback = handler; } });
    return { callback, definition };
}

function text(result) {
    return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

const url = "https://example.test/article";
const html = `<html><head><title>Readable article</title></head><body><article><h1>Readable article</h1><p>${"Useful article content. ".repeat(24)}</p></article></body></html>`;
const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#376b9a" } }).jpeg().toBuffer();

function fakePage() {
    let closes = 0;
    let shots = 0;
    return {
        url: () => url,
        isClosed: () => false,
        content: async () => html,
        title: async () => "Readable article",
        evaluate: async callback => {
            const source = String(callback);
            if (source.includes('querySelectorAll("iframe")')) return { names: [], documentVersion: 1 };
            if (source.includes('scriptUrls:')) return { title: 'Readable article', visibleText: 'Useful article content. '.repeat(24), html, readyState: 'complete', scriptUrls: [], iframeUrls: [], hasPasswordInput: false, hasBusinessForm: false, hasVisualContent: false };
            if (source.includes('documentVersion:')) return { title: 'Readable article', documentVersion: 1 };
            return null;
        },
        screenshot: async () => { shots += 1; return jpeg; },
        viewportSize: () => ({ width: 1280, height: 720 }),
        close: async () => { closes += 1; },
        get closes() { return closes; },
        get shots() { return shots; },
    };
}

test("all three tools accept sessionId-only and keep a borrowed Page open", async () => {
    const original = {
        get: sessionManager.get,
        navigateTo: browserManager.navigateTo,
        check: browserManager.checkAndHandleVerification,
        ready: browserManager.waitForVisualReady,
    };
    const page = fakePage();
    let navigations = 0;
    let checks = 0;
    try {
        pageCache.set(url, "# Stale text\n\nDo not use this cache for a borrowed page.");
        sessionManager.get = (_id, ownerId) => ownerId === "owner-one" ? page : null;
        browserManager.navigateTo = async () => { navigations += 1; throw new Error("unexpected navigation"); };
        browserManager.checkAndHandleVerification = async () => { checks += 1; return { status: "content_ready", contentConfirmed: true, targetMatched: true }; };
        browserManager.waitForVisualReady = async () => ({ complete: true });
        for (const register of [registerFetchPage, registerFetchRich, registerFetchScreenshot]) {
            const { callback, definition } = tool(register);
            assert.ok(definition.inputSchema.sessionId.isOptional());
            assert.ok(definition.inputSchema.ownerId.isOptional());
            assert.ok(definition.inputSchema.url.isOptional());
            const params = { sessionId: "session-existing", ownerId: "owner-one" };
            if (register === registerFetchPage) params.outputMode = "full";
            if (register === registerFetchRich) params.compact = "full";
            const result = await callback(params);
            assert.equal(result.isError, undefined, text(result));
            if (register === registerFetchPage) assert.match(text(result), /Useful article content/);
            assert.equal(page.closes, 0);
        }
        assert.match(pageCache.get(url), /Stale text/);
        assert.equal(navigations, 0);
        assert.ok(checks >= 5);
        assert.ok(page.shots >= 2);
        const mismatch = await tool(registerFetchPage).callback({ sessionId: "session-existing", ownerId: "owner-one", url: "https://example.test/other", outputMode: "full" });
        assert.equal(mismatch.isError, true);
        assert.match(text(mismatch), /不匹配/);
        assert.equal(page.closes, 0);
        assert.equal(navigations, 0);
        const wrongOwner = await tool(registerFetchScreenshot).callback({ sessionId: "session-existing", ownerId: "other" });
        assert.equal(wrongOwner.isError, true);
        page.screenshot = async () => { throw new Error("capture failed"); };
        const failedCapture = await tool(registerFetchScreenshot).callback({ sessionId: "session-existing", ownerId: "owner-one" });
        assert.equal(failedCapture.isError, true);
        assert.equal(page.closes, 0);
    } finally {
        pageCache.clear();
        sessionManager.get = original.get;
        browserManager.navigateTo = original.navigateTo;
        browserManager.checkAndHandleVerification = original.check;
        browserManager.waitForVisualReady = original.ready;
    }
});

test("old challenge cache is invalidated before ai_summary, but ordinary short cache remains valid", async () => {
    const originalNavigate = browserManager.navigateTo;
    let navigations = 0;
    try {
        browserManager.navigateTo = async () => { navigations += 1; throw new Error("fresh page required"); };
        pageCache.set(url, "# Just a moment\n\nChecking your browser before accessing this site. Please wait while we verify your connection.");
        const challenge = await tool(registerFetchPage).callback({ url, outputMode: "ai_summary" });
        assert.equal(challenge.isError, true);
        assert.equal(navigations, 1);
        assert.equal(pageCache.has(url), false);
        assert.doesNotMatch(text(challenge), /AI 摘要|Checking your browser/);

        pageCache.set(url, "# Tiny page\n\nOrdinary short content.");
        const normal = await tool(registerFetchPage).callback({ url, outputMode: "full" });
        assert.equal(normal.isError, undefined);
        assert.match(text(normal), /Ordinary short content/);
        assert.equal(navigations, 1);
    } finally {
        pageCache.clear();
        browserManager.navigateTo = originalNavigate;
    }
});

for (const filename of ["report.pdf", "report.odt"]) {
    test("local " + filename + " keeps its original filename when pdf.js renders about:blank", async () => {
        const originalNavigate = browserManager.navigateTo;
        const originalCheck = browserManager.checkAndHandleVerification;
        const requestedUrl = "file:///C:/fixtures/" + filename;
        const documentText = "Original local document text. ".repeat(24);
        const page = fakePage();
        let navigations = 0;
        let postSnapshotChecks = 0;
        page.url = () => "about:blank";
        page.evaluate = async callback => {
            const source = String(callback);
            if (source.includes('querySelectorAll("iframe")')) return { names: [], documentVersion: 1 };
            if (source.includes("__mcpPdfInfo")) return { texts: { 1: documentText }, totalPages: 1 };
            if (source.includes("documentVersion:")) return { title: "", documentVersion: 1 };
            if (source.includes("scriptUrls:")) return {
                title: "", visibleText: "", html: "<canvas></canvas>", readyState: "complete",
                scriptUrls: [], iframeUrls: [], hasPasswordInput: false, hasBusinessForm: false, hasVisualContent: true,
            };
            return null;
        };
        try {
            pageCache.clear();
            browserManager.navigateTo = async actualUrl => {
                assert.equal(actualUrl, requestedUrl);
                navigations++;
                return page;
            };
            browserManager.checkAndHandleVerification = async () => {
                postSnapshotChecks++;
                return page;
            };
            const result = await tool(registerFetchPage).callback({ url: requestedUrl, outputMode: "full" });
            assert.equal(result.isError, undefined, text(result));
            assert.ok(text(result).startsWith("# " + filename + "\n"), text(result));
            assert.match(text(result), /Original local document text/);
            assert.doesNotMatch(text(result), /# about:blank/);
            assert.equal(navigations, 1);
            assert.equal(postSnapshotChecks, 0);
            assert.equal(page.closes, 1);
        } finally {
            pageCache.clear();
            browserManager.navigateTo = originalNavigate;
            browserManager.checkAndHandleVerification = originalCheck;
        }
    });
}

test("HTTP content uses its frozen final URL after another document commits", async () => {
    const originalNavigate = browserManager.navigateTo;
    const originalCheck = browserManager.checkAndHandleVerification;
    const requestedUrl = "https://example.test/short";
    const finalUrl = "https://example.test/articles/2026/entry";
    const lateUrl = "https://example.test/after-snapshot/another";
    const linkedHtml = html.replace("</article>", '<p><a href="../related">Related page</a></p></article>');
    const frame = {};
    const page = new EventEmitter();
    let currentUrl = finalUrl;
    let contentRead = false;
    let commitsAfterSnapshot = 0;
    let postSnapshotUrlReads = 0;
    let postSnapshotChecks = 0;
    let closes = 0;
    const removeListener = page.off.bind(page);
    page.off = (event, listener) => {
        removeListener(event, listener);
        if (event === "framenavigated" && contentRead && commitsAfterSnapshot === 0 && page.listenerCount(event) === 0) {
            currentUrl = lateUrl;
            commitsAfterSnapshot++;
            page.emit("framenavigated", frame);
        }
        return page;
    };
    Object.assign(page, {
        url: () => {
            if (commitsAfterSnapshot) postSnapshotUrlReads++;
            return currentUrl;
        },
        mainFrame: () => frame,
        isClosed: () => false,
        waitForLoadState: async () => {},
        close: async () => { closes++; },
        content: async () => { contentRead = true; return linkedHtml; },
        evaluate: async callback => {
            const source = String(callback);
            if (source.includes('querySelectorAll("iframe")')) return { names: [], documentVersion: 1 };
            if (source.includes("__mcpPdfInfo")) return null;
            if (source.includes("documentVersion:")) return { title: "Readable article", documentVersion: 1 };
            if (source.includes("scriptUrls:")) return {
                title: "Readable article", visibleText: "Useful article content. ".repeat(24), html: linkedHtml,
                readyState: "complete", scriptUrls: [], iframeUrls: [], hasPasswordInput: false,
                hasBusinessForm: false, hasVisualContent: false,
            };
            return null;
        },
    });
    try {
        pageCache.clear();
        browserManager.navigateTo = async actualUrl => {
            assert.equal(actualUrl, requestedUrl);
            return page;
        };
        browserManager.checkAndHandleVerification = async () => {
            postSnapshotChecks++;
            return page;
        };
        const result = await tool(registerFetchPage).callback({ url: requestedUrl, outputMode: "full" });
        assert.equal(result.isError, undefined, text(result));
        assert.match(text(result), /\[Related page\]\(https:\/\/example\.test\/articles\/related\)/);
        assert.doesNotMatch(text(result), /after-snapshot/);
        assert.equal(commitsAfterSnapshot, 1);
        assert.equal(postSnapshotUrlReads, 0);
        assert.equal(postSnapshotChecks, 0);
        assert.match(pageCache.get(requestedUrl), /https:\/\/example\.test\/articles\/related/);
        assert.equal(page.listenerCount("framenavigated"), 0);
        assert.equal(closes, 1);
    } finally {
        pageCache.clear();
        browserManager.navigateTo = originalNavigate;
        browserManager.checkAndHandleVerification = originalCheck;
    }
});

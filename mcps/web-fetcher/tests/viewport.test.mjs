import assert from "node:assert/strict";
import test from "node:test";
import { viewportSchema, assertViewportTarget, applyExplicitViewport } from "../src/viewport.ts";

test("viewport accepts bounded desktop, portrait and landscape CSS sizes", () => {
    for (const size of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 4096, height: 2048 }]) {
        assert.deepEqual(viewportSchema.parse(size), size);
    }
});

test("viewport rejects invalid dimensions, excess pixels and device-emulation fields", () => {
    for (const size of [{ width: 0, height: 400 }, { width: 239, height: 400 }, { width: 400, height: 4097 }, { width: 390.5, height: 844 }, { width: 4096, height: 4096 }, { width: 390, height: 844, isMobile: true }]) {
        assert.equal(viewportSchema.safeParse(size).success, false);
    }
});

test("explicit viewport rejects file previews but leaves omitted viewport unchanged", () => {
    const size = { width: 390, height: 844 };
    for (const url of ["file:///C:/sample.pptx", "file:///C:/sample.pdf", "file:///C:/sample.epub", "file:///C:/sample.txt", "https://example.test/book.pdf?download=1", "https://example.test/sheet.xlsx"]) {
        assert.throws(() => assertViewportTarget(url, size), /ERR_VIEWPORT_UNSUPPORTED_TARGET/);
        assert.doesNotThrow(() => assertViewportTarget(url));
    }
    for (const url of ["https://example.test/", "http://localhost:3000/app", "file:///C:/sample.html", "file:///C:/sample.xhtml"]) {
        assert.doesNotThrow(() => assertViewportTarget(url, size));
    }
});

test("existing page changes only for explicit different viewport", async () => {
    const calls = [];
    let current = { width: 900, height: 650 };
    const page = { url: () => "https://example.test/", evaluate: async () => true, viewportSize: () => current, setViewportSize: async value => { current = value; calls.push(value); } };
    await applyExplicitViewport(page);
    assert.equal(calls.length, 0);
    await applyExplicitViewport(page, { width: 900, height: 650 });
    assert.equal(calls.length, 0);
    await applyExplicitViewport(page, { width: 390, height: 844 });
    assert.deepEqual(calls, [{ width: 390, height: 844 }]);
    await applyExplicitViewport(page);
    assert.deepEqual(current, { width: 390, height: 844 });
});

test("extensionless non-HTML preview is not silently resized", async () => {
    let resized = false;
    const page = { url: () => "https://example.test/download", evaluate: async () => false, viewportSize: () => null, setViewportSize: async () => { resized = true; } };
    await assert.rejects(applyExplicitViewport(page, { width: 390, height: 844 }), /ERR_VIEWPORT_UNSUPPORTED_TARGET/);
    assert.equal(resized, false);
});

test("DOM structure preserves partial-readiness notes and never swallows cancellation", async () => {
    const { browserManager } = await import("../src/browser.ts");
    const { extractDomStructureFromPage } = await import("../src/inspector/dom-inspector.ts");
    const original = browserManager.waitForVisualReady;
    let evaluations = 0;
    const page = { evaluate: async () => {
        evaluations += 1;
        return { elements: [], dimensions: { width: 390, height: 844, viewportWidth: 390, viewportHeight: 844 }, url: "https://example.test/", title: "Fixture" };
    } };
    try {
        browserManager.waitForVisualReady = async () => ({ complete: false, note: "One image is still pending" });
        const partial = await extractDomStructureFromPage(page);
        assert.equal(partial[0].metadata.readinessNote, "One image is still pending");
        browserManager.waitForVisualReady = async () => { throw new Error("temporary resource probe failure"); };
        const probeFailure = await extractDomStructureFromPage(page);
        assert.match(probeFailure[0].metadata.readinessNote, /temporary resource probe failure/);
        for (const code of ["request_cancelled", "request_deadline_exceeded"]) {
            const before = evaluations;
            browserManager.waitForVisualReady = async () => { throw Object.assign(new Error(code), { code }); };
            await assert.rejects(extractDomStructureFromPage(page), error => error.code === code);
            assert.equal(evaluations, before);
        }
        browserManager.waitForVisualReady = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
        await assert.rejects(extractDomStructureFromPage(page), { name: "AbortError" });
    } finally {
        browserManager.waitForVisualReady = original;
    }
});

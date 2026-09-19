import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { inlineImageContent, assertInlineImageBudget, INLINE_IMAGE_LIMIT, INLINE_IMAGE_BASE64_LIMIT } from "../src/image-output.ts";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-fetcher-image-output-test-"));
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalTmpdir = process.env.TMPDIR;
process.env.TEMP = testRoot;
process.env.TMP = testRoot;
process.env.TMPDIR = testRoot;
const { browserManager } = await import("../src/browser.ts");
const { registerFetchScreenshot } = await import("../src/tools/fetch-screenshot.ts");
const { registerFetchRich } = await import("../src/tools/fetch-rich.ts");
const { TEMP_DIRS } = await import("../src/temp-store.ts");
assert.ok(TEMP_DIRS.screenshots.startsWith(testRoot + path.sep));
after(async () => {
    for (const [name, value] of [["TEMP", originalTemp], ["TMP", originalTmp], ["TMPDIR", originalTmpdir]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    await fs.rm(testRoot, { recursive: true, force: true });
});

const makeImage = (format = "png", width = 128, height = 96) => sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 100, b: 190 } },
}).toFormat(format).toBuffer();
const imageBlocks = result => result.content.filter(item => item.type === "image");
const textBlocks = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
const getTool = register => {
    let callback;
    let definition;
    register({ registerTool(_name, schema, handler) { callback = handler; definition = schema; } });
    return { callback, definition };
};

for (const format of ["png", "jpeg"]) {
    test(`inline ${format} uses actual MIME and unchanged bytes without paths`, async () => {
        const buffer = await makeImage(format);
        const content = await inlineImageContent(buffer, "页面截图");
        assert.equal(content[0].type, "text");
        assert.equal(content[1].mimeType, `image/${format}`);
        assert.deepEqual(Buffer.from(content[1].data, "base64"), buffer);
        assert.doesNotMatch(content[0].text, /file:\/\/|view_file|临时|[A-Z]:\\/i);
    });
}

test("oversized width and height produce row-major two-dimensional tiles", async () => {
    const buffer = await makeImage("png", 7801, 7801);
    const content = await inlineImageContent(buffer, "大图");
    const images = content.filter(item => item.type === "image");
    assert.equal(images.length, 4);
    const dimensions = [];
    for (const item of images) {
        const metadata = await sharp(Buffer.from(item.data, "base64")).metadata();
        assert.ok(metadata.width <= 7800 && metadata.height <= 7800);
        assert.equal(item.mimeType, "image/png");
        dimensions.push([metadata.width, metadata.height]);
    }
    assert.deepEqual(dimensions, [[7800, 7800], [1, 7800], [7800, 1], [1, 1]]);
    assert.match(content[0].text, /分片 1\/4.*x=0，y=0/);
    assert.match(content[2].text, /分片 2\/4.*x=7800，y=0/);
    assert.match(content[4].text, /分片 3\/4.*x=0，y=7800/);
    assert.match(content[6].text, /分片 4\/4.*x=7800，y=7800/);
});

test("autoSplit=false preserves original oversized image", async () => {
    const buffer = await makeImage("jpeg", 7801, 1);
    const content = await inlineImageContent(buffer, "不分片", false);
    assert.equal(content.filter(item => item.type === "image").length, 1);
    assert.deepEqual(Buffer.from(content[1].data, "base64"), buffer);
});

test("tile-count overflow is rejected instead of silently dropping tiles", async () => {
    await assert.rejects(inlineImageContent(await makeImage("png", 78001, 1), "过宽"), /ERR_INLINE_IMAGE_BUDGET.*11.*saveMode/);
});

test("image-count and aggregate encoded-length limits include exact boundaries", () => {
    assert.equal(INLINE_IMAGE_LIMIT, 10);
    assert.doesNotThrow(() => assertInlineImageBudget(Array.from({ length: 10 }, () => ({ type: "image", data: "" }))));
    assert.throws(() => assertInlineImageBudget(Array.from({ length: 11 }, () => ({ type: "image", data: "" }))), /ERR_INLINE_IMAGE_BUDGET.*saveMode/);
    assert.doesNotThrow(() => assertInlineImageBudget([{ type: "image", data: "a".repeat(INLINE_IMAGE_BASE64_LIMIT) }]));
    assert.throws(() => assertInlineImageBudget([
        { type: "image", data: "a".repeat(INLINE_IMAGE_BASE64_LIMIT / 2) },
        { type: "image", data: "b".repeat(INLINE_IMAGE_BASE64_LIMIT / 2 + 1) },
    ]), /ERR_INLINE_IMAGE_BUDGET.*saveMode/);
});

test("single-image encoded budget is enforced before returning content", async () => {
    const buffer = Buffer.concat([await makeImage(), Buffer.alloc(INLINE_IMAGE_BASE64_LIMIT)]);
    await assert.rejects(inlineImageContent(buffer, "过大"), /ERR_INLINE_IMAGE_BUDGET.*saveMode/);
});

function mockPage(buffer, { totalPages = 3, missingPage, failPage } = {}) {
    return {
        evaluate: async () => ({ totalPages, currentPage: 1 }),
        close: async () => {},
        viewportSize: () => ({ width: 1920, height: 1080 }),
        setViewportSize: async () => {},
        screenshot: async () => buffer,
        waitForTimeout: async () => {},
        content: async () => "<html><head><title>示例标题</title></head><body><main><h1>示例正文</h1><p>测试页面的完整正文内容，没有登录或验证码。</p></main></body></html>",
        $: async selector => {
            const pageNum = Number(selector.replace("#pdf-page-", ""));
            if (pageNum === missingPage) return null;
            return { screenshot: async () => {
                if (pageNum === failPage) throw new Error("截图失败测试");
                return buffer;
            } };
        },
    };
}

test("screenshot defaults to inline for PNG/JPEG; explicit file retains file-only result", async context => {
    context.mock.method(browserManager, "waitForVisualReady", async () => ({ complete: true, total: 0, ready: 0, pending: 0, failed: 0, waited: 0, fontsReady: true, scanLimited: false }));
    const { callback, definition } = getTool(registerFetchScreenshot);
    assert.match(definition.inputSchema.saveMode.description, /inline.*默认/);
    for (const format of ["png", "jpeg"]) {
        const buffer = await makeImage(format);
        context.mock.method(browserManager, "navigateTo", async () => mockPage(buffer));
        const result = await callback({ url: `https://image-output.test/${format}` });
        assert.equal(result.isError, undefined, textBlocks(result));
        assert.equal(imageBlocks(result)[0].mimeType, `image/${format}`);
        assert.doesNotMatch(textBlocks(result), /view_file|文件:|[A-Z]:\\/i);
    }
    const fileResult = await callback({ url: "https://image-output.test/file", saveMode: "file", autoSplit: false });
    assert.equal(fileResult.isError, undefined);
    assert.equal(imageBlocks(fileResult).length, 0);
    assert.match(textBlocks(fileResult), /文件:.*\.jpg/);
});

test("multi-page default returns ordered page-labelled images without addresses", async context => {
    const buffer = await makeImage();
    const calls = [];
    context.mock.method(browserManager, "navigateTo", async (_url, options) => {
        calls.push(options);
        return mockPage(buffer);
    });
    const result = await getTool(registerFetchScreenshot).callback({ url: "file:///fixture.pdf", pages: "3,1-2" });
    assert.equal(result.isError, undefined);
    assert.equal(imageBlocks(result).length, 3);
    assert.deepEqual(calls[1].pageNumbers, [1, 2, 3]);
    assert.match(result.content[1].text, /第1页/);
    assert.match(result.content[3].text, /第2页/);
    assert.match(result.content[5].text, /第3页/);
    assert.doesNotMatch(textBlocks(result), /view_file|清单文件|[A-Z]:\\/i);
});

test("multi-page rejects more than ten pages after probe and before full rendering", async context => {
    let navigations = 0;
    const buffer = await makeImage();
    context.mock.method(browserManager, "navigateTo", async () => {
        navigations++;
        return mockPage(buffer, { totalPages: 100 });
    });
    for (const pages of ["all", "1-100"]) {
        navigations = 0;
        const result = await getTool(registerFetchScreenshot).callback({ url: "file:///fixture.pdf", pages });
        assert.equal(result.isError, true);
        assert.match(textBlocks(result), /ERR_INLINE_IMAGE_BUDGET/);
        assert.equal(navigations, 1);
        assert.equal(imageBlocks(result).length, 0);
    }
});

test("missing and failed pages cannot be reported as successful partial completion", async context => {
    const buffer = await makeImage();
    for (const options of [{ missingPage: 2 }, { failPage: 2 }]) {
        context.mock.method(browserManager, "navigateTo", async () => mockPage(buffer, options));
        const result = await getTool(registerFetchScreenshot).callback({ url: "file:///fixture.pdf", pages: "1-3" });
        assert.equal(result.isError, true);
        assert.match(textBlocks(result), /已捕获页码: 1；未完成页码: 2,3/);
        assert.equal(imageBlocks(result).length, 0);
    }
});

test("multi-page explicit file keeps legacy path list and manifest thresholds", async context => {
    const buffer = await makeImage();
    context.mock.method(browserManager, "navigateTo", async () => mockPage(buffer, { totalPages: 12 }));
    const { callback } = getTool(registerFetchScreenshot);
    for (const pages of ["1-2", "1-12"]) {
        const result = await callback({ url: "file:///fixture-file.pdf", pages, saveMode: "file" });
        assert.equal(result.isError, undefined);
        assert.equal(imageBlocks(result).length, 0);
        assert.match(textBlocks(result), pages === "1-2" ? /第1页.*\.jpg/ : /清单文件:.*\.txt/);
    }
});

test("rich defaults to image plus text and explicit file remains text-only", async context => {
    const buffer = await makeImage();
    context.mock.method(browserManager, "navigateTo", async () => mockPage(buffer));
    context.mock.method(browserManager, "waitForVisualReady", async () => ({ complete: true, total: 0, ready: 0, pending: 0, failed: 0, waited: 0, fontsReady: true, scanLimited: false }));
    const { callback, definition } = getTool(registerFetchRich);
    assert.match(definition.inputSchema.saveMode.description, /inline.*默认/);
    const inline = await callback({ url: "https://image-output.test/rich", compact: "full" });
    assert.equal(inline.isError, undefined, textBlocks(inline));
    assert.equal(imageBlocks(inline)[0].mimeType, "image/png");
    assert.match(textBlocks(inline), /示例正文/);
    assert.doesNotMatch(textBlocks(inline), /view_file|[A-Z]:\\/i);
    const file = await callback({ url: "https://image-output.test/rich-file", compact: "full", saveMode: "file" });
    assert.equal(file.isError, undefined);
    assert.equal(imageBlocks(file).length, 0);
    assert.match(textBlocks(file), /view_file/);
});

test("multi-page aggregate byte budget rejects combined images, not just individual pages", async context => {
    const buffer = Buffer.concat([await makeImage(), Buffer.alloc(5 * 1024 * 1024)]);
    context.mock.method(browserManager, "navigateTo", async () => mockPage(buffer, { totalPages: 2 }));
    const result = await getTool(registerFetchScreenshot).callback({ url: "file:///fixture-budget.pdf", pages: "1-2" });
    assert.equal(result.isError, true);
    assert.match(textBlocks(result), /ERR_INLINE_IMAGE_BUDGET/);
    assert.match(textBlocks(result), /已捕获页码: 1；未完成页码: 2/);
    assert.equal(imageBlocks(result).length, 0);
});

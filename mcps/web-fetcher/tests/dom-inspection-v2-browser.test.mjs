import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { extractDomStructureFromPage, detectDomIssuesFromStructure } from "../dist/inspector/dom-inspector.js";
import { browserManager } from "../dist/browser.js";

test("DOM inspection distinguishes actual content evidence from decorative geometry", { timeout: 90000 }, async suite => {
    const browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const base = "<style>body{margin:0;font:20px/24px Arial;color:#111;background:white}.box{position:absolute;left:50px;top:50px;width:320px;height:100px}.text{position:absolute;left:70px;top:70px;white-space:nowrap}</style>";
    async function inspect(markup, checks = ["overlap", "overflow", "readability"]) {
        await page.setContent(base + markup);
        const structure = await extractDomStructureFromPage(page);
        return detectDomIssuesFromStructure(structure, checks, false);
    }
    const touching = (result, first, second) => result.issues.filter(issue => issue.type === "overlap"
        && issue.elements.some(element => element.id === first) && issue.elements.some(element => element.id === second));
    try {
        await suite.test("opaque card behind text is normal composition", async () => {
            const result = await inspect('<div class="box" id="card" style="background:#abc"></div><div class="text" id="caption">Readable card caption</div>');
            assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
        });
        await suite.test("transparent decorative layer does not occlude content", async () => {
            const result = await inspect('<div class="text" id="caption">Readable caption</div><div class="box" id="decor" style="border:1px solid red"></div>');
            assert.equal(result.issues.length, 0);
        });
        await suite.test("opaque foreground cover remains detected with paint evidence", async () => {
            const result = await inspect('<div class="text" id="caption">Hidden caption under an opaque panel</div><div class="box" id="cover" style="background:#abc"></div>');
            const matches = touching(result, "caption", "cover");
            assert.equal(matches.length, 1);
            assert.equal(matches[0].metadata.assessment, "confirmed");
            assert.equal(matches[0].metadata.evidenceKind, "sampled-opaque-paint");
            assert.equal(matches[0].severity, "warning");
        });
        await suite.test("pointer-events none overlay is retained as an unconfirmed candidate", async () => {
            const result = await inspect('<div class="text" id="caption">Caption hidden by pointerless panel</div><div class="box" id="cover" style="background:#abc;pointer-events:none"></div>');
            const matches = touching(result, "caption", "cover");
            assert.equal(matches.length, 1);
            assert.equal(matches[0].metadata.assessment, "candidate");
        });
        await suite.test("opaque panel carrying its own nonintersecting caption still hides underlying text", async () => {
            const result = await inspect('<div class="text" id="caption">Underlying text</div><div class="box" id="cover" style="background:#abc;padding-top:65px;box-sizing:border-box">Panel caption below</div>');
            assert.equal(touching(result, "caption", "cover")[0]?.metadata.assessment, "confirmed");
        });
        await suite.test("descendant panel covering direct parent text is not excluded as normal nesting", async () => {
            const result = await inspect('<div class="box" id="caption">Direct text covered here<div id="cover" style="position:absolute;inset:0;background:#abc"></div></div>');
            assert.equal(touching(result, "caption", "cover")[0]?.metadata.assessment, "confirmed");
        });
        await suite.test("text box whitespace may intersect without text lines intersecting", async () => {
            const result = await inspect('<div id="first" class="box">First line</div><div id="second" class="box" style="top:90px">Second line</div>');
            assert.equal(touching(result, "first", "second").length, 0);
        });
        await suite.test("child SVG covering parent direct text remains a candidate", async () => {
            const result = await inspect('<div class="box" id="caption">Direct text covered here<svg id="cover" style="position:absolute;inset:0;width:320px;height:100px"><rect width="320" height="100" fill="#abc"/></svg></div>');
            assert.equal(touching(result, "caption", "cover")[0]?.metadata.assessment, "candidate");
        });
        await suite.test("fully transparent text is not a confirmed occlusion target", async () => {
            const result = await inspect('<div class="text" id="caption" style="color:rgba(0,0,0,0)">Invisible text</div><div class="box" id="cover" style="background:#abc"></div>');
            assert.equal(result.issues.length, 0);
        });
        await suite.test("aria-hidden visual image may still cover direct parent text", async () => {
            const result = await inspect('<div class="box" id="caption">Direct text<svg id="cover" aria-hidden="true" style="position:absolute;inset:0;width:320px;height:100px"><rect width="320" height="100" fill="#abc"/></svg></div>');
            assert.equal(touching(result, "caption", "cover")[0]?.metadata.assessment, "candidate");
        });
        await suite.test("modern CSS color text is not discarded as invisible", async () => {
            const result = await inspect('<div class="text" id="caption" style="color:color(srgb 1 0 0)">Modern color text</div><div class="box" id="cover" style="background:#abc"></div>');
            assert.equal(touching(result, "caption", "cover")[0]?.metadata.assessment, "confirmed");
        });
        await suite.test("dense overlaps have a bounded report and disclose truncation", async () => {
            const result = await inspect('<div>' + '<span class="text">overlapping text</span>'.repeat(400) + '</div>', ["overlap"]);
            assert.equal(result.issues.length, 200);
            assert.equal(result.structure[0].metadata.detectionTruncated, true);
        });
        await suite.test("actual intersecting text line rectangles remain a visual review candidate", async () => {
            const result = await inspect('<div id="first" class="box">First visible line</div><div id="second" class="box" style="top:58px">Second competing line</div>');
            assert.equal(touching(result, "first", "second").length, 1);
            assert.equal(touching(result, "first", "second")[0].metadata.assessment, "candidate");
        });
        await suite.test("scrollable content is not reported as clipping", async () => {
            const result = await inspect('<div style="width:150px;height:45px;overflow:auto"><div style="width:400px;height:150px">Long scrollable content remains accessible by scrolling</div></div>');
            assert.equal(result.issues.filter(issue => ["overflow", "clipped"].includes(issue.type)).length, 0);
        });
        await suite.test("self overflow hidden cutting text is detected once", async () => {
            const result = await inspect('<div id="cut" style="width:100px;height:24px;white-space:nowrap;overflow:hidden">A long text that is actually cut by its own box</div>');
            const matches = result.issues.filter(issue => ["overflow", "clipped"].includes(issue.type));
            assert.equal(matches.length, 1);
            assert.equal(matches[0].elements[0].id, "cut");
        });
        await suite.test("wrapped text with adequate height is not clipped", async () => {
            const result = await inspect('<div id="wrap" style="width:140px;height:180px;overflow:hidden">Several ordinary lines wrap into a tall card with sufficient room.</div>');
            assert.equal(result.issues.filter(issue => ["overflow", "clipped"].includes(issue.type)).length, 0);
        });
        await suite.test("ancestor opacity zero excludes invisible text", async () => {
            const result = await inspect('<div style="opacity:0"><div class="box">Invisible text</div></div><div class="box">Visible line</div>');
            assert.equal(result.issues.length, 0);
            assert.equal(result.structure[0].elements.some(element => element.text === "Invisible text"), false);
        });
        await suite.test("parent containers do not duplicate descendant text readability issues", async () => {
            const result = await inspect('<div id="outer" style="font-size:8px"><span id="small">Only one small text source</span></div>');
            assert.equal(result.issues.filter(issue => issue.type === "small-font").length, 1);
            assert.equal(result.issues.find(issue => issue.type === "small-font").elements[0].id, "small");
        });
        await suite.test("bounded scans explicitly report unchecked DOM and alignment", async () => {
            const result = await inspect('<div>' + '<span style="display:block">row</span>'.repeat(2050) + '</div>', ["alignment"]);
            assert.ok(result.structure[0].metadata.inspectionLimitations.some(text => text.includes("2000")));
            assert.ok(result.structure[0].metadata.inspectionLimitations.some(text => text.includes("alignment")));
        });
    } finally {
        await browser.close();
        await browserManager.shutdown();
    }
});

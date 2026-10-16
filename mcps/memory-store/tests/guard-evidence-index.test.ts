import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import type { GuardEvidenceIndexItem, GuardEvidenceIndexResult } from "../src/guard-evidence-index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-evidence-index-"));
const previousDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const previousCliMode = process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE;
const previousDirectBytes = process.env.MEMORY_STORE_GUARD_EVIDENCE_DIRECT_TEXT_BYTES;
process.env.MEMORY_STORE_DATA_ROOT = path.join(tmp, "data");
process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE = "off";
process.env.MEMORY_STORE_GUARD_EVIDENCE_DIRECT_TEXT_BYTES = String(2 * 1024 * 1024);

const { buildGuardEvidenceIndexes, GUARD_EVIDENCE_INDEX_END, GUARD_EVIDENCE_INDEX_START } = await import("../src/guard-evidence-index.js");

function artifactText(item: GuardEvidenceIndexItem): string {
    assert.ok(item.artifactPath && fs.existsSync(item.artifactPath));
    const artifact = fs.readFileSync(item.artifactPath, "utf-8");
    assert.ok(artifact.includes(GUARD_EVIDENCE_INDEX_START));
    assert.ok(artifact.includes(GUARD_EVIDENCE_INDEX_END));
    return artifact.slice(artifact.indexOf(GUARD_EVIDENCE_INDEX_START) + GUARD_EVIDENCE_INDEX_START.length, artifact.lastIndexOf(GUARD_EVIDENCE_INDEX_END)).trim();
}

function sourceBlock(item: GuardEvidenceIndexItem, index: number): string {
    const cached = JSON.parse(fs.readFileSync(item.cachePath!, "utf-8"));
    return [
        `### 证据文件 ${index + 1}: ${cached.label || path.basename(cached.path)}`,
        `- path: ${cached.path}`,
        `- kind: ${cached.kind}`,
        `- ingestMode: ${cached.ingestMode}`,
        `- parser: ${cached.parser}`,
        `- ok: ${cached.ok}`,
        `- readStatus: ${cached.readStatus}`,
        `- sourceReadStatus: ${cached.sourceReadStatus}`,
        `- truncated: ${cached.truncated}`,
        cached.requestedRange ? `- requestedRange: ${cached.requestedRange}` : undefined,
        `- artifactPath: ${cached.artifactPath}`,
        cached.warnings.length ? `- warnings: ${cached.warnings.join(" | ")}` : undefined,
        cached.coverageGaps.length ? `- coverageGaps: ${cached.coverageGaps.join(" | ")}` : undefined,
        "",
        artifactText(item),
    ].filter(line => line !== undefined).join("\n");
}

function assertManifest(result: GuardEvidenceIndexResult, requestedAssets: number, budget: number): void {
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.coverage, result.coverage);
    assert.equal(manifest.items.length, requestedAssets);
    assert.equal(result.items.length, requestedAssets);
    assert.equal(result.coverage.requestedAssets, requestedAssets);
    assert.equal(result.coverage.completeAssets + result.coverage.partialAssets + result.coverage.unreadAssets, requestedAssets);
    assert.ok(result.text.length <= budget);
    assert.equal(result.coverage.includedChars, result.text.length);
    assert.ok(result.coverage.sourceChars >= result.coverage.includedChars);
    assert.equal(Buffer.from(result.text, "utf-8").toString("utf-8"), result.text);
    for (const [index, item] of result.items.entries()) {
        assert.ok(Number.isSafeInteger(item.sourceChars) && item.sourceChars >= 0);
        assert.ok(Number.isSafeInteger(item.includedChars) && item.includedChars >= 0);
        assert.ok(item.includedChars <= item.sourceChars);
        assert.equal(manifest.items[index].readStatus, item.readStatus);
        assert.equal(manifest.items[index].sourceChars, item.sourceChars);
        assert.equal(manifest.items[index].includedChars, item.includedChars);
        assert.equal(manifest.items[index].requestedRange, item.requestedRange);
        assert.ok(fs.existsSync(item.artifactPath!));
    }
}

async function main() {
    const largeTextPath = path.join(tmp, "large-report.md");
    const repeated = Array.from({ length: 3000 }, (_, index) => `L${index + 1} npm run test:guard evidence artifact ${index}`).join("\n") + "\nEND_MUST_READ_LARGE";
    fs.writeFileSync(largeTextPath, repeated, "utf-8");

    const textResult = await buildGuardEvidenceIndexes([
        { path: largeTextPath, label: "large report", role: "report", maxChars: 8_000 },
    ], { indexMode: "rebuild", maxTotalChars: 10_000, maxFileChars: 8_000 });

    assert.equal(textResult.items.length, 1);
    assert.equal(textResult.items[0].ok, true);
    assert.equal(textResult.items[0].ingestMode, "direct_text");
    assertManifest(textResult, 1, 10_000);
    assert.ok(artifactText(textResult.items[0]).includes("END_MUST_READ_LARGE"));
    assert.ok(textResult.text.includes("large report"));
    assert.equal(textResult.items[0].sourceReadStatus, "complete");
    assert.equal(textResult.items[0].readStatus, "partial");
    assert.equal(textResult.coverage.partialAssets, 1);
    assert.equal(textResult.coverage.truncated, true);
    assert.equal(textResult.items[0].sourceChars, sourceBlock(textResult.items[0], 0).length);
    assert.ok(textResult.items[0].sourceChars > repeated.length);
    assert.ok(textResult.items[0].coverageGaps.some(gap => gap.startsWith("per_file_budget_truncated:")));

    const cachedResult = await buildGuardEvidenceIndexes([
        { path: largeTextPath, label: "large report", role: "report", maxChars: 8_000 },
    ], { indexMode: "auto", maxTotalChars: 10_000, maxFileChars: 8_000 });
    assert.equal(cachedResult.items[0].ingestMode, "direct_text");
    assert.ok(cachedResult.items[0].cachePath && fs.existsSync(cachedResult.items[0].cachePath));
    assert.equal(cachedResult.items[0].artifactPath, textResult.items[0].artifactPath);
    assert.equal(cachedResult.items[0].sourceChars, textResult.items[0].sourceChars);
    const expanded = await buildGuardEvidenceIndexes([{ path: largeTextPath, label: "large report", role: "report" }], {
        indexMode: "reuse", maxTotalChars: 300_000, maxFileChars: 250_000,
    });
    assertManifest(expanded, 1, 300_000);
    assert.equal(expanded.items[0].artifactPath, textResult.items[0].artifactPath);
    assert.equal(expanded.coverage.completeAssets, 1);
    assert.equal(expanded.coverage.truncated, false);
    assert.ok(expanded.text.includes("END_MUST_READ_LARGE"));
    assert.deepEqual(expanded.coverage.coverageGaps, []);

    const markedPath = path.join(tmp, "nested-markers.md");
    fs.writeFileSync(markedPath, `BEGIN_MARKERS\n${GUARD_EVIDENCE_INDEX_START}\ninner example\n${GUARD_EVIDENCE_INDEX_END}\nEND_MUST_READ_MARKERS`, "utf-8");
    const marked = await buildGuardEvidenceIndexes([{ path: markedPath }], { indexMode: "rebuild", maxTotalChars: 8_000 });
    const markedReuse = await buildGuardEvidenceIndexes([{ path: markedPath }], { indexMode: "reuse", maxTotalChars: 8_000 });
    assert.equal(markedReuse.coverage.completeAssets, 1);
    assert.equal(markedReuse.items[0].sourceChars, marked.items[0].sourceChars);
    assert.ok(markedReuse.text.includes("BEGIN_MARKERS"));
    assert.ok(markedReuse.text.includes("END_MUST_READ_MARKERS"));

    const imagePath = path.join(tmp, "screenshot.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    const imageResult = await buildGuardEvidenceIndexes([
        { path: imagePath, label: "ui screenshot", role: "screenshot" },
    ], { indexMode: "rebuild", maxTotalChars: 8_000 });
    assert.equal(imageResult.items[0].kind, "image");
    assert.equal(imageResult.items[0].ingestMode, "image_metadata");
    assert.ok(imageResult.text.includes("不能声称已看见图片内容"));
    assertManifest(imageResult, 1, 8_000);
    assert.equal(imageResult.items[0].sourceChars, sourceBlock(imageResult.items[0], 0).length);
    assert.equal(imageResult.coverage.partialAssets, 1);
    assert.ok(imageResult.coverage.coverageGaps.some(gap => gap.includes("image_metadata_only:")));

    const missingResult = await buildGuardEvidenceIndexes([
        { path: path.join(tmp, "missing.pdf"), label: "missing pdf" },
    ], { indexMode: "rebuild", maxTotalChars: 8_000 });
    assert.equal(missingResult.items[0].ok, false);
    assert.equal(missingResult.items[0].ingestMode, "unreadable_stub");
    assert.ok(missingResult.text.includes("文件不存在"));
    assertManifest(missingResult, 1, 8_000);
    assert.equal(missingResult.coverage.unreadAssets, 1);
    const offResult = await buildGuardEvidenceIndexes([{ path: largeTextPath, label: "large report", role: "report" }], { indexMode: "off" });
    assert.equal(offResult.items[0].sourceReadStatus, "unread");
    assert.ok(offResult.coverage.coverageGaps.some(gap => gap.includes("evidenceIndexMode=off")));
    const offZero = await buildGuardEvidenceIndexes([{ path: largeTextPath }], { indexMode: "off", maxTotalChars: 0 });
    assertManifest(offZero, 1, 0);
    assert.ok(offZero.coverage.coverageGaps.some(gap => gap.includes("evidenceIndexMode=off")));

    const limitedResult = await buildGuardEvidenceIndexes([
        { path: largeTextPath, label: "first" },
        { path: largeTextPath, label: "second" },
    ], { indexMode: "rebuild", maxTotalChars: 2_000, maxFileChars: 1_200 });
    assertManifest(limitedResult, 2, 2_000);
    assert.equal(limitedResult.coverage.truncated, true);
    assert.ok(limitedResult.coverage.unreadAssets >= 1);
    assert.ok(limitedResult.coverage.coverageGaps.some(gap => gap.includes("budget")));

    const longDirectory = path.join(tmp, "long-path".repeat(5), "nested-path".repeat(4));
    fs.mkdirSync(longDirectory, { recursive: true });
    const multiInputs = ["first", "last"].map((name) => {
        const filePath = path.join(longDirectory, `${name}.md`);
        fs.writeFileSync(filePath, `BEGIN_${name}\n${"证据🙂".repeat(80)}\nEND_MUST_READ_${name}`, "utf-8");
        return { path: filePath, label: `${name}-${"很长标签🙂".repeat(180)}`, role: "report" };
    });
    const multiFull = await buildGuardEvidenceIndexes(multiInputs, { indexMode: "rebuild", maxTotalChars: 50_000, maxFileChars: 30_000 });
    assertManifest(multiFull, 2, 50_000);
    assert.equal(multiFull.coverage.completeAssets, 2);
    const expectedBlocks = multiFull.items.map(sourceBlock);
    const expectedPreamble = [
        "## 外部证据文件索引",
        "- coverage: requested=2, complete=2, partial=0, unread=0",
        `- 完整覆盖状态、缺失与未注入材料记录: ${multiFull.manifestPath}`,
        "", "",
    ].join("\n");
    const expectedFull = expectedPreamble + expectedBlocks.join("\n\n---\n\n");
    assert.equal(multiFull.coverage.sourceChars, expectedFull.length);
    assert.equal(multiFull.coverage.includedChars, expectedFull.length);
    assert.equal(multiFull.text, expectedFull);
    const exactBudget = expectedFull.length + 32;
    const multiExact = await buildGuardEvidenceIndexes(multiInputs, { indexMode: "reuse", maxTotalChars: exactBudget, maxFileChars: 30_000 });
    assertManifest(multiExact, 2, exactBudget);
    assert.equal(multiExact.coverage.completeAssets, 2);
    assert.ok(multiExact.text.includes("END_MUST_READ_first"));
    assert.ok(multiExact.text.includes("END_MUST_READ_last"));
    const oldBodyOnlyBudget = multiFull.items.reduce((sum, item) => sum + artifactText(item).length + 80, 0);
    assert.ok(oldBodyOnlyBudget < expectedFull.length);
    const multiLimited = await buildGuardEvidenceIndexes(multiInputs, { indexMode: "reuse", maxTotalChars: oldBodyOnlyBudget, maxFileChars: 30_000 });
    assertManifest(multiLimited, 2, oldBodyOnlyBudget);
    assert.ok(multiLimited.coverage.completeAssets < 2);
    assert.equal(multiLimited.coverage.truncated, true);
    assert.ok(multiLimited.coverage.sourceChars > multiLimited.coverage.includedChars);

    const rangePath = path.join(tmp, "range.md");
    fs.writeFileSync(rangePath, "HEAD\nline two\nline three\nEND_MUST_READ_RANGE", "utf-8");
    for (const range of ["#2-3", "first2", "last2"]) {
        const rangeResult = await buildGuardEvidenceIndexes([{ path: rangePath, range }], { indexMode: "rebuild", maxTotalChars: 8_000 });
        assertManifest(rangeResult, 1, 8_000);
        assert.equal(rangeResult.items[0].requestedRange, range);
        assert.equal(rangeResult.coverage.completeAssets, 1);
        assert.deepEqual(rangeResult.coverage.coverageGaps, []);
        const reusedRange = await buildGuardEvidenceIndexes([{ path: rangePath, range }], { indexMode: "reuse", maxTotalChars: 8_000 });
        assert.equal(reusedRange.items[0].artifactPath, rangeResult.items[0].artifactPath);
        assert.equal(reusedRange.coverage.completeAssets, 1);
        if (range === "last2") assert.ok(reusedRange.text.includes("END_MUST_READ_RANGE"));
    }
    const outOfRange = await buildGuardEvidenceIndexes([{ path: rangePath, range: "9-10" }], { indexMode: "rebuild" });
    assert.equal(outOfRange.coverage.unreadAssets, 1);
    assert.ok(outOfRange.coverage.coverageGaps.some(gap => gap.includes("requested_range_incomplete:")));
    const invalidRange = await buildGuardEvidenceIndexes([{ path: rangePath, range: "3-1" }], { indexMode: "rebuild" });
    assert.equal(invalidRange.coverage.unreadAssets, 1);
    assert.ok(!invalidRange.text.includes("END_MUST_READ_RANGE"));
    for (const range of ["bogus", "#0-2", "first0", "last0"]) {
        const result = await buildGuardEvidenceIndexes([{ path: rangePath, range }], { indexMode: "rebuild" });
        assert.equal(result.coverage.unreadAssets, 1);
        assert.equal(result.items[0].requestedRange, range);
        assert.ok(!result.text.includes("END_MUST_READ_RANGE"));
    }

    const prefixPath = path.join(tmp, "unicode-prefix.md");
    const prefixHeader = "range first\nrange second\n";
    fs.writeFileSync(prefixPath, prefixHeader + "a".repeat(2 * 1024 * 1024 - Buffer.byteLength(prefixHeader) - 1) + "🙂\nEND_AFTER_BYTE_LIMIT", "utf-8");
    const prefixRange = await buildGuardEvidenceIndexes([{ path: prefixPath, range: "1-2" }], { indexMode: "rebuild", maxTotalChars: 8_000 });
    assert.equal(prefixRange.coverage.completeAssets, 1);
    for (const range of ["last2", "3-4", "999-1000"]) {
        const result = await buildGuardEvidenceIndexes([{ path: prefixPath, range }], { indexMode: "rebuild", maxTotalChars: 4_000, maxFileChars: 2_000 });
        assertManifest(result, 1, 4_000);
        assert.equal(result.coverage.completeAssets, 0);
        assert.ok(result.coverage.coverageGaps.some(gap => gap.includes(range === "last2" ? "requested_range_unreached:" : "requested_range_incomplete:")));
        assert.ok(!result.text.includes("END_AFTER_BYTE_LIMIT"));
        if (range === "last2") {
            assert.equal(result.items[0].sourceReadStatus, "unread");
            assert.ok(!result.text.includes("range first"));
            const reused = await buildGuardEvidenceIndexes([{ path: prefixPath, range }], { indexMode: "reuse", maxTotalChars: 4_000, maxFileChars: 2_000 });
            assert.equal(reused.items[0].artifactPath, result.items[0].artifactPath);
            assert.equal(reused.coverage.unreadAssets, 1);
        }
    }
    const prefixResult = await buildGuardEvidenceIndexes([{ path: prefixPath }], { indexMode: "rebuild", maxTotalChars: 4_000, maxFileChars: 2_000 });
    assertManifest(prefixResult, 1, 4_000);
    assert.equal(prefixResult.items[0].sourceReadStatus, "partial");
    assert.ok(!artifactText(prefixResult.items[0]).includes("\uFFFD"));
    const prefixReuse = await buildGuardEvidenceIndexes([{ path: prefixPath }], { indexMode: "reuse", maxTotalChars: 4_000, maxFileChars: 2_000 });
    assert.equal(prefixReuse.items[0].artifactPath, prefixResult.items[0].artifactPath);
    assert.equal(prefixReuse.items[0].sourceChars, prefixResult.items[0].sourceChars);

    const unicodePath = path.join(tmp, "unicode.md");
    fs.writeFileSync(unicodePath, "🙂证据𝄞".repeat(1000) + "END_UNICODE", "utf-8");
    const unicodeFull = await buildGuardEvidenceIndexes([{ path: unicodePath }], { indexMode: "rebuild", maxTotalChars: 20_000, maxFileChars: 20_000 });
    assert.equal(unicodeFull.coverage.completeAssets, 1);
    for (const indexMode of ["reuse", "auto"] as const) {
        const reduced = await buildGuardEvidenceIndexes([{ path: unicodePath }], { indexMode, maxTotalChars: 2_000, maxFileChars: 1_800 });
        assertManifest(reduced, 1, 2_000);
        assert.equal(reduced.items[0].artifactPath, unicodeFull.items[0].artifactPath);
        assert.equal(reduced.items[0].sourceChars, unicodeFull.items[0].sourceChars);
        assert.ok(reduced.coverage.includedChars < unicodeFull.coverage.includedChars);
        assert.equal(reduced.coverage.completeAssets, 0);
        assert.equal(reduced.coverage.truncated, true);
        assert.ok(artifactText(reduced.items[0]).includes("END_UNICODE"));
    }
    for (const budget of [0, 1, 2, 3, 8, 31, 64, 200, 800, 1_200, 1_201, 1_202, 2_000, -1, 0.5, NaN, Infinity]) {
        const normalizedBudget = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
        const result = await buildGuardEvidenceIndexes([{ path: unicodePath }], { indexMode: "auto", maxTotalChars: budget, maxFileChars: 8_000 });
        assertManifest(result, 1, normalizedBudget);
        assert.equal(result.coverage.completeAssets, 0);
        assert.equal(result.coverage.truncated, true);
        if (normalizedBudget === 0) assert.equal(result.text, "");
    }
    for (const fileBudget of [0, 1, -1, NaN, Infinity]) {
        const result = await buildGuardEvidenceIndexes([{ path: unicodePath, maxChars: fileBudget }], { indexMode: "auto", maxTotalChars: 8_000 });
        assertManifest(result, 1, 8_000);
        assert.equal(result.coverage.unreadAssets, 1);
        assert.equal(result.items[0].includedChars, 0);
    }
    const invalidInputs = await buildGuardEvidenceIndexes([
        { path: "" }, { path: "\0invalid" }, { path: 42 } as unknown as { path: string }, null as unknown as { path: string },
    ], { indexMode: "rebuild", maxTotalChars: 8_000 });
    assertManifest(invalidInputs, 4, 8_000);
    assert.equal(invalidInputs.coverage.unreadAssets, 4);
    const emptyResult = await buildGuardEvidenceIndexes(undefined, { maxTotalChars: 0 });
    assertManifest(emptyResult, 0, 0);
    assert.equal(emptyResult.coverage.sourceChars, 0);

    const legacySeed = await buildGuardEvidenceIndexes([{ path: rangePath }], { indexMode: "rebuild", maxTotalChars: 8_000 });
    const cachePath = legacySeed.items[0].cachePath!;
    const validCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    for (const legacy of [{ ...validCache, version: 1 }, { ...validCache, version: undefined }, { ...validCache, coverageGaps: undefined }]) {
        fs.writeFileSync(cachePath, JSON.stringify(legacy), "utf-8");
        const rejected = await buildGuardEvidenceIndexes([{ path: rangePath }], { indexMode: "reuse", maxTotalChars: 8_000 });
        assert.equal(rejected.coverage.unreadAssets, 1);
        assert.ok(rejected.coverage.coverageGaps.some(gap => gap.includes("未找到可复用索引缓存")));
    }
    fs.writeFileSync(cachePath, JSON.stringify(validCache), "utf-8");
    const structuredCache = {
        ...validCache, ingestMode: "structured_extract", parser: "sample-fixture", sourceReadStatus: "partial", readStatus: "partial", truncated: true,
        coverageGaps: ["structured_extract_sample: fixture samples only"], warnings: ["sampled paragraphs only", "warning two", "warning three", "LAST_WARNING_MUST_READ"],
    };
    fs.writeFileSync(cachePath, JSON.stringify(structuredCache), "utf-8");
    const sampledResult = await buildGuardEvidenceIndexes([{ path: rangePath }], { indexMode: "reuse", maxTotalChars: 8_000 });
    assert.equal(sampledResult.coverage.partialAssets, 1);
    assert.equal(sampledResult.coverage.truncated, true);
    assert.ok(sampledResult.coverage.coverageGaps.some(gap => gap.includes("structured_extract_sample:")));
    assert.ok(sampledResult.text.includes("LAST_WARNING_MUST_READ"));
    assert.equal(sampledResult.items[0].sourceChars, sourceBlock(sampledResult.items[0], 0).length);

    console.log(JSON.stringify({
        perFile: { sourceChars: textResult.coverage.sourceChars, includedChars: textResult.coverage.includedChars },
        multiFull: { sourceChars: multiFull.coverage.sourceChars, includedChars: multiFull.coverage.includedChars },
        multiLimited: { budget: oldBodyOnlyBudget, ...multiLimited.coverage },
    }));

    console.log("guard-evidence-index ok");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    if (previousDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = previousDataRoot;
    if (previousCliMode === undefined) delete process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE;
    else process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE = previousCliMode;
    if (previousDirectBytes === undefined) delete process.env.MEMORY_STORE_GUARD_EVIDENCE_DIRECT_TEXT_BYTES;
    else process.env.MEMORY_STORE_GUARD_EVIDENCE_DIRECT_TEXT_BYTES = previousDirectBytes;
    fs.rmSync(tmp, { recursive: true, force: true });
});

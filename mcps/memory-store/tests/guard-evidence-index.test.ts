import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
    buildGuardEvidenceIndexes,
    GUARD_EVIDENCE_INDEX_END,
    GUARD_EVIDENCE_INDEX_START,
} from "../src/guard-evidence-index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-evidence-index-"));
process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE = "off";

async function main() {
    const largeTextPath = path.join(tmp, "large-report.md");
    const repeated = Array.from({ length: 3000 }, (_, index) => `L${index + 1} npm run test:guard evidence artifact ${index}`).join("\n");
    fs.writeFileSync(largeTextPath, repeated, "utf-8");

    const textResult = await buildGuardEvidenceIndexes([
        { path: largeTextPath, label: "large report", role: "report", maxChars: 8_000 },
    ], { indexMode: "rebuild", maxTotalChars: 10_000, maxFileChars: 8_000 });

    assert.equal(textResult.items.length, 1);
    assert.equal(textResult.items[0].ok, true);
    assert.equal(textResult.items[0].ingestMode, "direct_text");
    assert.ok(textResult.items[0].artifactPath && fs.existsSync(textResult.items[0].artifactPath));
    const artifact = fs.readFileSync(textResult.items[0].artifactPath!, "utf-8");
    assert.ok(artifact.includes(GUARD_EVIDENCE_INDEX_START));
    assert.ok(artifact.includes(GUARD_EVIDENCE_INDEX_END));
    assert.ok(textResult.text.length <= 10_000);
    assert.ok(textResult.text.includes("large report"));
    assert.ok(textResult.text.includes("truncated") || textResult.items[0].warnings.length > 0);

    const cachedResult = await buildGuardEvidenceIndexes([
        { path: largeTextPath, label: "large report", role: "report", maxChars: 8_000 },
    ], { indexMode: "auto", maxTotalChars: 10_000, maxFileChars: 8_000 });
    assert.equal(cachedResult.items[0].ingestMode, "direct_text");
    assert.ok(cachedResult.items[0].cachePath && fs.existsSync(cachedResult.items[0].cachePath));

    const imagePath = path.join(tmp, "screenshot.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    const imageResult = await buildGuardEvidenceIndexes([
        { path: imagePath, label: "ui screenshot", role: "screenshot" },
    ], { indexMode: "rebuild", maxTotalChars: 8_000 });
    assert.equal(imageResult.items[0].kind, "image");
    assert.equal(imageResult.items[0].ingestMode, "image_metadata");
    assert.ok(imageResult.text.includes("不能声称已看见图片内容"));

    const missingResult = await buildGuardEvidenceIndexes([
        { path: path.join(tmp, "missing.pdf"), label: "missing pdf" },
    ], { indexMode: "rebuild", maxTotalChars: 8_000 });
    assert.equal(missingResult.items[0].ok, false);
    assert.equal(missingResult.items[0].ingestMode, "unreadable_stub");
    assert.ok(missingResult.text.includes("文件不存在"));

    const limitedResult = await buildGuardEvidenceIndexes([
        { path: largeTextPath, label: "first" },
        { path: largeTextPath, label: "second" },
    ], { indexMode: "rebuild", maxTotalChars: 2_000, maxFileChars: 1_200 });
    assert.ok(limitedResult.text.length <= 2_000);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("guard-evidence-index ok");
}

main().catch(error => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});

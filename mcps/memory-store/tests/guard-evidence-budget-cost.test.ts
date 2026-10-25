import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-evidence-cost-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_GUARD_EVIDENCE_CLI_MODE = "off";
const { buildGuardEvidenceIndexes } = await import("../src/guard-evidence-index.ts");

try {
    const shortPath = path.join(root, "short-visual.log");
    const longPath = path.join(root, "reference-history.log");
    fs.writeFileSync(shortPath, "visual verified\nEND_REQUIRED_VISUAL\n", "utf8");
    fs.writeFileSync(longPath, "reference material\n".repeat(1600), "utf8");

    const full = await buildGuardEvidenceIndexes([{ path: shortPath, label: "visual", role: "report" }], { maxTotalChars: 10000 });
    const source = full.items[0]!;
    const fullCost = source.sourceChars;
    const limited = await buildGuardEvidenceIndexes([{ path: shortPath, label: "visual", role: "report", maxChars: fullCost - 1 }], { maxTotalChars: 10000 });
    const budget = limited.items[0]!.budget;
    assert.ok(budget, "each asset reports the serialized body/metadata budget");
    assert.equal(budget.sourceBodyChars, source.text.length);
    assert.equal(budget.sourceMetadataChars, fullCost - source.text.length);
    assert.equal(budget.requiredChars, fullCost);
    assert.equal(budget.grantedChars, fullCost - 1);
    assert.equal(budget.shortfallChars, 1);
    assert.equal(budget.completeSourceKnown, true);
    assert.ok(full.text.includes("- role: report"));
    assert.notEqual(limited.items[0]!.readStatus, "complete");
    assert.ok(limited.items[0]!.includedChars <= fullCost - 1);

    const prioritized = await buildGuardEvidenceIndexes([
        { path: longPath, label: "old reference", role: "reference" },
        { path: shortPath, label: "required visual", role: "report" },
    ], { maxTotalChars: 2200 });
    assert.equal(prioritized.items[0]!.path, longPath, "returned items retain caller input order");
    assert.equal(prioritized.items[1]!.readStatus, "complete", "required short original precedes optional history allocation");
    assert.ok(prioritized.text.includes("END_REQUIRED_VISUAL"));
    assert.ok(prioritized.text.length <= 2200);
    assert.notEqual(prioritized.items[0]!.readStatus, "complete");
    assert.ok(prioritized.items[1]!.includedStart! < prioritized.items[0]!.includedStart!);
    for (const item of prioritized.items) {
        if (item.includedStart === undefined || item.includedEnd === undefined) continue;
        const block = prioritized.text.slice(item.includedStart, item.includedEnd);
        assert.equal(block.length, item.includedChars);
        assert.ok(block.includes(`- path: ${item.path}`), "priority allocation retains truthful source positions");
        assert.equal(item.budget!.sourceBodyChars + item.budget!.sourceMetadataChars, item.budget!.requiredChars);
    }

    const shortFirst = await buildGuardEvidenceIndexes([
        { path: longPath, label: "large required", role: "report" },
        { path: shortPath, label: "short required", role: "output" },
    ], { maxTotalChars: 2200 });
    assert.equal(shortFirst.items[1]!.readStatus, "complete", "short required logs remain whole before a large incomplete original");
    assert.ok(shortFirst.text.length <= 2200);
    assert.ok(shortFirst.items[1]!.includedStart! < shortFirst.items[0]!.includedStart!);

    const missing = await buildGuardEvidenceIndexes([{ path: path.join(root, "missing.log"), role: "report" }], { maxTotalChars: 4000 });
    assert.equal(missing.items[0]!.readStatus, "unread");
    assert.equal(missing.items[0]!.budget?.completeSourceKnown, false, "a missing source never claims a complete-source cost");
    console.log("guard evidence cost: PASS body/metadata/exact shortfall/required priority/stable input order/missing source");
} finally {
    fs.rmSync(root, { recursive: true });
}

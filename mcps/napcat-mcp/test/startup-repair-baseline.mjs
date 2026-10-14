import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function restoreFixtureBaseline(installedRoot, fixtureRoot) {
  const manifestPath = process.env.NAPCAT_INSTALLED_TEST_BASELINE_MANIFEST;
  if (!manifestPath) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, ""));
  assert.equal(path.resolve(manifest.targetRoot).toLowerCase(), path.resolve(installedRoot).toLowerCase());
  for (const [index, entry] of manifest.files.entries()) {
    if (entry.name === "desktop-launcher.ps1") continue;
    const destination = path.resolve(fixtureRoot, entry.name);
    assert.ok(destination.startsWith(`${path.resolve(fixtureRoot)}${path.sep}`));
    if (!entry.original.exists) {
      fs.rmSync(destination, { force: true });
      continue;
    }
    const original = fs.readFileSync(path.join(path.dirname(manifestPath), "original", `${index}.bin`));
    assert.equal(crypto.createHash("sha256").update(original).digest("hex"), entry.original.sha256);
    fs.writeFileSync(destination, original);
  }
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("built Python inspectors retain every same-directory helper", async () => {
    const source = fileURLToPath(new URL("../src/inspector/", import.meta.url));
    const destination = fileURLToPath(new URL("../dist/inspector/", import.meta.url));
    const filenames = (await fs.readdir(source)).filter(name => name.endsWith(".py"));
    assert.ok(filenames.includes("pptx_inspector.py"));
    assert.ok(filenames.includes("pdf_inspector.py"));
    assert.ok(filenames.includes("inspection_geometry.py"));
    for (const filename of filenames) {
        assert.deepEqual(await fs.readFile(path.join(destination, filename)), await fs.readFile(path.join(source, filename)), filename);
    }
});

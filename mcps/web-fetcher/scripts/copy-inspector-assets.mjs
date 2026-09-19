import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = fileURLToPath(new URL("../src/inspector/", import.meta.url));
const destination = fileURLToPath(new URL("../dist/inspector/", import.meta.url));
await fs.mkdir(destination, { recursive: true });
for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".py")) {
        await fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    }
}

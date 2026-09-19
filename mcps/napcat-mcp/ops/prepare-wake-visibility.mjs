import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WAKE_VISIBILITY_VERSION } from "../src/wake-visibility.mjs";

const replacements = [
  ['import { WebSocket, WebSocketServer } from "ws";', 'import { WebSocket, WebSocketServer } from "ws";\nimport { createWakeVisibilityAdapter } from "./wake-visibility.mjs";'],
  ['    this.journal = options.journal ?? null;', '    this.journal = options.journal ?? null;\n    this.wakeVisibility = createWakeVisibilityAdapter();'],
  ['      journal: this.journal?.status?.() ?? null,', '      journal: this.journal?.status?.() ?? null,\n      wakeVisibility: this.wakeVisibility.snapshot(),'],
  ['    let mutationAttempted = false;', '    let mutationAttempted = false;\n    let visibilityRegistration = null;'],
  ['      mutationAttempted = true;\n      const result = await this.#injectRequest(', '      mutationAttempted = true;\n      visibilityRegistration = this.wakeVisibility.registerWake({\n        threadId,\n        wakeId,\n        prompt,\n        messageVisibility,\n      });\n      const result = await this.#injectRequest('],
  ['      const outcomeUnknown = Boolean(error?.outcomeUnknown);', '      const outcomeUnknown = Boolean(error?.outcomeUnknown);\n      if (!outcomeUnknown) this.wakeVisibility.forgetWake(visibilityRegistration);'],
  ['      upstreamAlive: false,', '      upstreamAlive: false,\n      wakeVisibility: this.wakeVisibility.createView(),'],
  ['      if (client.downstream.readyState === this.WebSocketImpl.OPEN) {\n        this.#sendOrClose(client, client.downstream, data, isBinary, "upstream_to_downstream");', '      if (client.wakeVisibility.shouldSuppress(message)) return;\n      if (client.downstream.readyState === this.WebSocketImpl.OPEN) {\n        this.#sendOrClose(client, client.downstream, data, isBinary, "upstream_to_downstream");'],
  ['    client.closed = true;', '    client.closed = true;\n    client.wakeVisibility.close();'],
  ['    for (const client of [...this.clients]) this.#closeClient(client, "proxy_closed");', '    for (const client of [...this.clients]) this.#closeClient(client, "proxy_closed");\n    this.wakeVisibility.close();'],
];

export function patchWakeVisibility(source) {
  if (source.includes("createWakeVisibilityAdapter")) throw new Error("Visibility adapter already present; inspect its version instead of applying twice");
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  let candidate = source.replace(/\r\n/g, "\n");
  for (const [before, after] of replacements) {
    const position = candidate.indexOf(before);
    if (position < 0 || candidate.indexOf(before, position + before.length) >= 0) {
      throw new Error(`Expected one patch anchor: ${before.split("\n")[0]}`);
    }
    candidate = candidate.replace(before, after);
  }
  return lineEnding === "\n" ? candidate : candidate.replace(/\n/g, "\r\n");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function prepareWakeVisibility({ sourcePath, outputDirectory, expectedSha256 }) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? "")) throw new Error("An exact expected source SHA256 is required");
  const original = fs.readFileSync(sourcePath);
  if (sha256(original) !== expectedSha256.toLowerCase()) throw new Error("Source changed; no output created");
  const candidate = Buffer.from(patchWakeVisibility(original.toString("utf8")), "utf8");
  const adapter = fs.readFileSync(new URL("../src/wake-visibility.mjs", import.meta.url));
  const files = { "codex-app-server-proxy.mjs": candidate, "wake-visibility.mjs": adapter };
  const manifest = {
    schemaVersion: 1,
    component: "wake-visibility",
    version: WAKE_VISIBILITY_VERSION,
    sourceSha256: sha256(original),
    productionModified: false,
    files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  fs.mkdirSync(outputDirectory);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(outputDirectory, name), bytes, { flag: "wx" });
  fs.writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = new Map();
    const argumentsList = process.argv.slice(2);
    if (argumentsList.length !== 6) throw new Error("Use --source <file> --out <new-directory> --expected-sha256 <hash>");
    for (let index = 0; index < argumentsList.length; index += 2) {
      const name = argumentsList[index];
      if (!["--source", "--out", "--expected-sha256"].includes(name) || values.has(name)) throw new Error("Unknown or repeated option");
      values.set(name, argumentsList[index + 1]);
    }
    console.log(JSON.stringify(prepareWakeVisibility({
      sourcePath: values.get("--source"), outputDirectory: values.get("--out"), expectedSha256: values.get("--expected-sha256"),
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

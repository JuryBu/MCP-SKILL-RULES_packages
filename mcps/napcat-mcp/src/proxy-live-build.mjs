import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };

export async function buildProxyLiveBundle({ sourceRoot, destinationRoot, version, compiler, entryFile = "codex-app-server-proxy.mjs" }) {
  if (typeof compiler?.build !== "function" || typeof compiler?.transform !== "function") fail("LIVE_BUILD_COMPILER_REQUIRED");
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/u.test(version ?? "")) fail("LIVE_BUILD_VERSION_INVALID");
  if (!["codex-app-server-proxy.mjs", "proxy-live-parent-entry.mjs"].includes(entryFile)) fail("LIVE_BUILD_ENTRY_INVALID");
  const root = fs.realpathSync(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) fail("LIVE_BUILD_DESTINATION_EXISTS");
  const sources = new Map();
  const pending = entryFile === "proxy-live-parent-entry.mjs"
    ? [entryFile, "codex-model-stream-proxy-runner.mjs"] : [entryFile];
  let totalBytes = 0;
  while (pending.length) {
    const filename = pending.pop();
    if (sources.has(filename)) continue;
    if (!/^[a-zA-Z0-9_-]+\.mjs$/u.test(filename) || sources.size >= 127) fail("LIVE_BUILD_SOURCE_INVALID");
    const sourcePath = path.join(root, filename);
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(sourcePath) !== sourcePath) fail("LIVE_BUILD_SOURCE_IDENTITY_INVALID");
    const bytes = fs.readFileSync(sourcePath);
    totalBytes += bytes.length;
    if (bytes.length > 1024 * 1024 || totalBytes > 6 * 1024 * 1024) fail("LIVE_BUILD_SOURCE_LIMIT");
    sources.set(filename, { bytes, sourcePath, sha256: hash(bytes) });
    for (const match of bytes.toString("utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu)) {
      const dependency = match[1];
      if (dependency.startsWith("node:") || dependency === "ws") continue;
      if (!dependency.startsWith("./")) fail("LIVE_BUILD_DEPENDENCY_REFUSED");
      pending.push(dependency.slice(2));
    }
    for (const match of bytes.toString("utf8").matchAll(/\bnew\s+URL\s*\(\s*["'](\.\/[a-zA-Z0-9_-]+\.mjs)["']\s*,\s*import\.meta\.url\s*\)/gu)) {
      pending.push(match[1].slice(2));
    }
  }
  const result = await compiler.build({
    entryPoints: [path.join(root, entryFile)],
    bundle: true, write: false, platform: "node", format: "cjs", target: "node24",
    external: ["node:*", "ws"], legalComments: "none",
    plugins: [{ name: "pinned-live-source", setup(build) {
      build.onLoad({ filter: /\.mjs$/ }, async input => {
        const filename = path.basename(input.path);
        const source = sources.get(filename);
        if (!source || path.resolve(input.path) !== source.sourcePath) fail("LIVE_BUILD_UNPINNED_SOURCE");
        const transformed = await compiler.transform(source.bytes.toString("utf8"), {
          loader: "js", format: "esm", target: "node24",
          define: { "import.meta.url": JSON.stringify(pathToFileURL(path.join(destination, filename)).href) },
        });
        return { contents: transformed.code, loader: "js", resolveDir: root };
      });
    } }],
  });
  if (result.outputFiles?.length !== 1) fail("LIVE_BUILD_OUTPUT_INVALID");
  const compiled = result.outputFiles[0].contents;
  if (compiled.length > 1024 * 1024 || compiled.length + totalBytes > 8 * 1024 * 1024) fail("LIVE_BUILD_OUTPUT_LIMIT");
  for (const source of sources.values()) {
    if (hash(fs.readFileSync(source.sourcePath)) !== source.sha256) fail("LIVE_BUILD_SOURCE_CHANGED");
  }
  fs.mkdirSync(destination);
  const files = [];
  for (const [filename, source] of sources) {
    fs.writeFileSync(path.join(destination, filename), source.bytes, { flag: "wx" });
    files.push({ path: filename, sha256: source.sha256 });
  }
  fs.writeFileSync(path.join(destination, "proxy.cjs"), compiled, { flag: "wx" });
  files.push({ path: "proxy.cjs", sha256: hash(compiled) });
  const manifestPath = path.join(destination, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, stateSchema: "proxy-live-state-v1",
    format: "commonjs-bundle", version, entry: "proxy.cjs", files }), { flag: "wx" });
  return { manifestPath, manifestSha256: hash(fs.readFileSync(manifestPath)), sourceFiles: sources.size,
    compiledBytes: compiled.length, compilerVersion: compiler.version };
}

export function buildProxyParentLiveBundle(options) {
  return buildProxyLiveBundle({ ...options, entryFile: "proxy-live-parent-entry.mjs" });
}

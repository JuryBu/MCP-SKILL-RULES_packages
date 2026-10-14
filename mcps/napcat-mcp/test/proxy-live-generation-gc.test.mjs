import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProxyLiveCodeRuntime } from "../src/proxy-live-code-runtime.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const tick = () => new Promise(resolve => setImmediate(resolve));

class Original {
  status() { return { version: "original", closed: false }; }
  token() { return null; }
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-live-gc-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = new Original();
  target.clients = new Map([["owned", { connected: true }]]);
  const runtime = createProxyLiveCodeRuntime(target, { candidateRoot: root, instanceId: "owned-gc" });
  const command = extra => ({ instanceId: "owned-gc", expectedRevision: runtime.status().revision, ...extra });
  function bundle(version, source) {
    const directory = path.join(root, version);
    fs.mkdirSync(directory);
    const bytes = source ?? `const token = { version: ${JSON.stringify(version)} };
      exports.CodexAppServerProxy = class {
        static hotRuntimeSchema = "proxy-live-state-v1";
        status() { return { version: token.version, closed: false }; }
        token() { return token; }
      };`;
    fs.writeFileSync(path.join(directory, "proxy.cjs"), bytes);
    const manifestPath = path.join(directory, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, stateSchema: "proxy-live-state-v1",
      version, format: "commonjs-bundle", entry: "proxy.cjs", files: [{ path: "proxy.cjs", sha256: digest(bytes) }] }));
    return { manifestPath, manifestSha256: digest(fs.readFileSync(manifestPath)) };
  }
  return { root, target, runtime, command, bundle };
}

test("compiled generations keep only current, rollback and bounded preparations", async context => {
  const value = fixture(context);
  const clients = value.target.clients;
  for (let index = 0; index < 24; index++) {
    const version = `version-${index}`;
    const prepared = await value.runtime.prepare(value.command(value.bundle(version)));
    const unused = await value.runtime.prepare(value.command(value.bundle(`${version}-unused`)));
    const activated = value.runtime.activate(value.command({ preparationId: prepared.id }));
    assert.equal(value.target.status().version, version);
    assert.equal(activated.prepared.length, 0);
    assert.equal(activated.legacyImports, 0);
    assert.equal(value.target.clients, clients);
    assert.throws(() => value.runtime.activate(value.command({ preparationId: unused.id })), /PREPARATION_STALE/);
  }
  const restored = value.runtime.restore(value.command());
  assert.equal(value.target.status().version, "version-22");
  assert.equal(restored.prepared.length, 0);
  assert.equal(value.target.clients, clients);
});

test("retired compiled code loses its generation objects after collection", { skip: typeof globalThis.gc !== "function" }, async context => {
  const value = fixture(context);
  let retired;
  for (let index = 0; index < 8; index++) {
    const prepared = await value.runtime.prepare(value.command(value.bundle(`gc-${index}`)));
    value.runtime.activate(value.command({ preparationId: prepared.id }));
    if (index === 0) retired = new WeakRef(value.target.token());
  }
  await tick();
  globalThis.gc();
  await tick();
  assert.equal(retired.deref(), undefined);
  assert.equal(value.target.status().version, "gc-7");
  assert.equal(value.runtime.status().previous.version, "gc-6");
});

test("compiled imports reject unlisted external packages and changed bytes", async context => {
  const value = fixture(context);
  await assert.rejects(value.runtime.prepare(value.command(value.bundle("external", 'require("fs");'))), /EXTERNAL_DEPENDENCY_REFUSED/);
  const bundle = value.bundle("changed");
  const prepared = await value.runtime.prepare(value.command(bundle));
  fs.appendFileSync(path.join(path.dirname(bundle.manifestPath), "proxy.cjs"), "\n");
  assert.throws(() => value.runtime.activate(value.command({ preparationId: prepared.id })), /FILE_CHANGED/);
  assert.equal(value.target.status().version, "original");
});

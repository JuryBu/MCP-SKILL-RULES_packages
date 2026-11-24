import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executablePath = "C:\\synthetic\\antigravity\\resources\\bin\\language_server.exe";
let seq = 0;

async function setupFixture(context, rows) {
  const daemonDir = await mkdtemp(join(tmpdir(), "ag-hub-compat-"));
  context.after(() => rm(daemonDir, { recursive: true, force: true }));
  const stub = () => { throw new Error("use promisified"); };
  stub[promisify.custom] = () => {
    const child = new EventEmitter();
    const p = Promise.resolve({ stdout: JSON.stringify(rows) });
    p.child = child;
    queueMicrotask(() => child.emit("close", 0, null));
    return p;
  };
  const orig = childProcess.execFile;
  let mod;
  try {
    childProcess.execFile = stub;
    syncBuiltinESMExports();
    mod = await import(`../src/transports/antigravity-ls.mjs?hub_compat=${++seq}`);
  } finally {
    childProcess.execFile = orig;
    syncBuiltinESMExports();
  }
  return { mod, daemonDir };
}

test("2.34.0 hub mode resolves csrfToken by matching pid+httpPort and prioritizes httpPort while keeping all ls_ports alongside legacy CLI mode", async context => {
  const now = Date.now();
  const rows = [
    { pid: 101, csrf: "legacy-cli-token", created_ms: now, ports: [41001], host_pid: 100, host_ports: [41000] },
    { pid: 202, csrf: null, created_ms: now, ports: [50430, 50365, 50366], host_pid: 200, host_ports: [50356] },
  ];
  const { mod, daemonDir } = await setupFixture(context, rows);
  for (let i = 0; i < 25; i++) {
    await writeFile(join(daemonDir, `hub_${60000 + i}.json`), JSON.stringify({
      pid: 9999 + i, httpPort: 60000 + i, httpsPort: 59999 - i, lsVersion: "2.34.0", csrfToken: `stale-${i}`,
    }));
  }
  await writeFile(join(daemonDir, "hub_50366.json"), JSON.stringify({
    pid: 202, httpsPort: 50365, httpPort: 50366, lsVersion: "2.34.0", csrfToken: "hub-234-valid-token",
  }));

  const found = await mod.discoverAntigravityProcesses({ executablePath, daemonDir });
  assert.deepEqual(found, [
    { pid: 101, csrf: "legacy-cli-token", ports: [41001], host_pid: 100, host_ports: [41000] },
    { pid: 202, csrf: "hub-234-valid-token", ports: [50366, 50430, 50365], host_pid: 200, host_ports: [50356] },
  ]);
});

test("hub mode rejects wrong pid, stale pre-creation file, CRLF/non-ASCII/multi-byte >4096B/oversized >16KB/ambiguous-mtime files without poisoning healthy sibling", async context => {
  const createdMs = Date.now();
  const rows = [
    { pid: 301, csrf: null, created_ms: createdMs, ports: [51001] }, // wrong pid
    { pid: 302, csrf: null, created_ms: createdMs, ports: [51002] }, // stale file
    { pid: 303, csrf: null, created_ms: createdMs, ports: [51003] }, // CRLF injection
    { pid: 304, csrf: null, created_ms: createdMs, ports: [51004] }, // fallback scan healthy
    { pid: 305, csrf: null, created_ms: createdMs, ports: [51005] }, // 2000 CJK chars (6000 UTF-8 bytes) / non-ASCII
    { pid: 306, csrf: null, created_ms: createdMs, ports: [51006] }, // >16KB oversized file
    { pid: 307, csrf: null, created_ms: createdMs, ports: [51007, 51008] }, // ambiguous same mtimeMs
  ];
  const { mod, daemonDir } = await setupFixture(context, rows);

  await writeFile(join(daemonDir, "hub_51001.json"), JSON.stringify({ pid: 999, httpPort: 51001, csrfToken: "wrong-pid" }));
  const stalePath = join(daemonDir, "hub_51002.json");
  await writeFile(stalePath, JSON.stringify({ pid: 302, httpPort: 51002, csrfToken: "stale-token" }));
  const oldSec = (createdMs - 60000) / 1000;
  await utimes(stalePath, oldSec, oldSec);

  await writeFile(join(daemonDir, "hub_51003.json"), JSON.stringify({ pid: 303, httpPort: 51003, csrfToken: "bad\r\nheader:1" }));
  await writeFile(join(daemonDir, "hub_custom_304.json"), JSON.stringify({ pid: 304, httpPort: 51004, csrfToken: "fallback-valid-token" }));
  await writeFile(join(daemonDir, "hub_51005.json"), JSON.stringify({ pid: 305, httpPort: 51005, csrfToken: "汉".repeat(2000) }));
  await writeFile(join(daemonDir, "hub_51006.json"), JSON.stringify({ pid: 306, httpPort: 51006, csrfToken: "x".repeat(32), pad: "p".repeat(17000) }));

  const a1 = join(daemonDir, "hub_51007.json");
  const a2 = join(daemonDir, "hub_51008.json");
  await writeFile(a1, JSON.stringify({ pid: 307, httpPort: 51007, csrfToken: "ambig-1" }));
  await writeFile(a2, JSON.stringify({ pid: 307, httpPort: 51008, csrfToken: "ambig-2" }));
  const sameSec = createdMs / 1000;
  await utimes(a1, sameSec, sameSec);
  await utimes(a2, sameSec, sameSec);

  const found = await mod.discoverAntigravityProcesses({ executablePath, daemonDir });
  assert.deepEqual(found, [
    { pid: 304, csrf: "fallback-valid-token", ports: [51004] },
  ]);
});

test("non-antigravity custom executablePath does not implicitly scan default antigravity daemonDir", async context => {
  const rows = [{ pid: 888, csrf: null, created_ms: Date.now(), ports: [50366] }];
  const { mod } = await setupFixture(context, rows);
  const found = await mod.discoverAntigravityProcesses({ executablePath: "C:\\Windsurf\\language_server_windows_x64.exe" });
  assert.deepEqual(found, []);
});

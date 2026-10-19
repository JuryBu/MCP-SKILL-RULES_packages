const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [runId, directory, scenario, levelText = "0"] = process.argv.slice(2);
const level = Number(levelText);
const relativeDirectory = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(directory));
if (!/^[a-f0-9]{32}$/.test(runId) || !relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory) || !directory.includes(runId)) {
  throw new Error("Fixture must have an owned GUID in Temp");
}
fs.mkdirSync(directory, { recursive: true });

function startChild(nextLevel) {
  const child = spawn(process.execPath, [__filename, runId, directory, scenario, String(nextLevel)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

if (scenario.startsWith("entry_")) {
  const inherited = Object.fromEntries([
    "NAPCAT_QUICK_ACCOUNT", "NAPCAT_QUICK_PASSWORD", "NAPCAT_QUICK_PASSWORD_MD5",
  ].map((name) => [name, Object.hasOwn(process.env, name)]));
  fs.writeFileSync(path.join(directory, "environment.json"), JSON.stringify(inherited));
  if (scenario === "entry_no_qr") {
    const qrPath = path.join(directory, "runtime", "cache", "qrcode.png");
    fs.mkdirSync(path.dirname(qrPath), { recursive: true });
    fs.writeFileSync(qrPath, "fixture QR");
  }
  fs.writeFileSync(path.join(directory, "helper-ready"), String(process.pid));
  setTimeout(() => process.exit(0), 2500);
} else {
  if (level === 0) startChild(1);
  if (level === 1 && scenario !== "spawn_during_cleanup") startChild(2);
  fs.writeFileSync(path.join(directory, `level-${level}.json`), JSON.stringify({
    pid: process.pid,
    runId,
    level,
  }));
  let spawned = false;
  const timer = setInterval(() => {
    if (level === 0 && scenario === "root_exit" && fs.existsSync(path.join(directory, "root-exit.request"))) process.exit(0);
    if (level === 1 && scenario === "spawn_during_cleanup" && !spawned && fs.existsSync(path.join(directory, "spawn.request"))) {
      spawned = true;
      startChild(2);
    }
  }, 10);
  setTimeout(() => {
    clearInterval(timer);
    process.exit(0);
  }, 12000);
}

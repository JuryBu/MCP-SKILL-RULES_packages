import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createNapCatNotifier } from "../src/core.mjs";
import { loadOfflineRecoveryState } from "../src/napcat-offline-recovery.mjs";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

const NOW_MS = Date.parse("2026-11-24T16:55:00.000Z");
const MANUAL_HINT = {
  manualLoginRequired: true,
  offlineReason: "manual_quick_login_required",
  localRecoveryEntry: "restart-napcat-qr-login.ps1",
};

function snapshot(needsManual = true, updatedAt = new Date(NOW_MS).toISOString()) {
  return {
    updatedAt,
    autoOfflineRecovery: {
      needsManual,
      reason: "private fixture error",
      credential: "private fixture credential",
      recoveryEntry: "C:/private-fixture/recovery.ps1",
    },
    account: "private fixture account",
    machine: "private fixture machine",
  };
}

function recoveryHint(result) {
  return Object.fromEntries(Object.keys(MANUAL_HINT)
    .filter((key) => Object.hasOwn(result, key))
    .map((key) => [key, result[key]]));
}

async function createStatusFixture(context, { useDataRoot = false, override = false, useLocalhost = false, fetchImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-offline-status-"));
  const bindingPath = path.join(root, "binding.json");
  const statePath = path.join(root, "notifier-state", "dedupe.json");
  const dataRoot = path.join(root, "deployed-data");
  const siblingRuntimePath = path.join(path.dirname(statePath), "supervisor-runtime.json");
  const dataRootRuntimePath = path.join(dataRoot, "state", "supervisor-runtime.json");
  const overridePath = path.join(root, "fixture-runtime.json");
  const runtimePath = override ? overridePath : useDataRoot ? dataRootRuntimePath : siblingRuntimePath;
  const calls = [];
  const probe = { status: { online: false, good: true }, loginFails: false, disconnect: false, redirect: null };
  const server = http.createServer((request, response) => {
    const action = request.url;
    calls.push(action);
    request.resume();
    if (action === "/get_status" && probe.redirect) {
      response.writeHead(307, { Location: probe.redirect });
      response.end();
      return;
    }
    if (action === "/get_status" && probe.disconnect) {
      response.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (action === "/get_status") {
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: probe.status }));
    } else if (action === "/get_login_info" && !probe.loginFails) {
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 100001 } }));
    } else {
      response.statusCode = 503;
      response.end(JSON.stringify({ status: "failed", retcode: 1 }));
    }
  });
  context.after(async () => {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections?.();
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(bindingPath, JSON.stringify({ expectedSelfId: "100001" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  const notifier = createNapCatNotifier({
    cwd: root,
    env: {
      NAPCAT_HTTP_URL: useLocalhost ? baseUrl.replace("127.0.0.1", "localhost") : baseUrl,
      NAPCAT_ACCESS_TOKEN: "fixture-only-token",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: statePath,
      ...(useDataRoot ? { CODEX_TOOLKIT_NAPCAT_DATA_ROOT: dataRoot } : {}),
    },
    now: () => new Date(NOW_MS),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(override ? { supervisorRuntimeStatePath: overridePath } : {}),
  });
  function writeRuntime(value, filePath = runtimePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = typeof value === "string" ? value : JSON.stringify(value);
    fs.writeFileSync(filePath, content, "utf8");
    return content;
  }
  async function closeEndpoint() {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
  return { notifier, probe, calls, writeRuntime, statePath, runtimePath, siblingRuntimePath, closeEndpoint, baseUrl };
}

function readStatus(notifier, extra = {}) {
  return notifier.status({ include_group: false, ...extra });
}

test("offline status adds exactly the fixed hint without copying or writing state", async (context) => {
  const fixture = await createStatusFixture(context);
  const baseline = await readStatus(fixture.notifier);
  const original = fixture.writeRuntime(snapshot(true, new Date(NOW_MS - 130_000).toISOString()));
  const result = await readStatus(fixture.notifier);
  assert.equal(result.ready, false);
  assert.equal(result.reachable, true);
  assert.deepEqual(result, { ...baseline, ...MANUAL_HINT });
  assert.deepEqual(fixture.calls, ["/get_status", "/get_login_info", "/get_status", "/get_login_info"]);
  assert.equal(fs.readFileSync(fixture.runtimePath, "utf8"), original);
  assert.equal(fs.existsSync(fixture.statePath), false);
});

test("offline status survives a rejected login query without fabricating identity", async (context) => {
  const fixture = await createStatusFixture(context);
  fixture.writeRuntime(snapshot());
  fixture.probe.loginFails = true;
  const unavailable = await readStatus(fixture.notifier);
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.reachable, true);
  assert.deepEqual(unavailable.runtimeStatus, { online: false, good: true });
  assert.equal(Object.hasOwn(unavailable, "identity"), false);
  assert.equal(unavailable.error.code, "ONEBOT_HTTP_ERROR");
  assert.equal(unavailable.error.details.status, 503);
  assert.deepEqual(recoveryHint(unavailable), MANUAL_HINT);
  assert.deepEqual(fixture.calls, ["/get_status", "/get_login_info"]);
});

test("confirmed online status never adds manual login advice, even with bad health or login errors", async (context) => {
  const fixture = await createStatusFixture(context);
  fixture.writeRuntime(snapshot());
  fixture.probe.loginFails = true;
  for (const good of [false, true]) {
    fixture.probe.status = { online: true, good };
    const result = await readStatus(fixture.notifier);
    assert.equal(result.ready, false);
    assert.equal(result.reachable, true);
    assert.deepEqual(result.runtimeStatus, fixture.probe.status);
    assert.equal(Object.hasOwn(result, "identity"), false);
    assert.equal(result.error.code, "ONEBOT_HTTP_ERROR");
    assert.deepEqual(recoveryHint(result), {});
  }
  fixture.probe.loginFails = false;
  fixture.probe.status = { online: true, good: false };
  const unhealthy = await readStatus(fixture.notifier);
  assert.equal(unhealthy.ready, false);
  assert.equal(unhealthy.reachable, true);
  assert.equal(unhealthy.identity.actualSelfId, "100001");
  assert.equal(Object.hasOwn(unhealthy, "error"), false);
  assert.deepEqual(recoveryHint(unhealthy), {});
  fixture.probe.status = { online: true, good: true };
  const healthy = await readStatus(fixture.notifier);
  assert.equal(healthy.ready, true);
  assert.deepEqual(recoveryHint(healthy), {});
});

test("unknown, incomplete or unparseable OneBot status never becomes a cached offline diagnosis", async (context) => {
  const fixture = await createStatusFixture(context);
  fixture.writeRuntime(snapshot());
  fixture.probe.disconnect = true;
  const lost = await readStatus(fixture.notifier);
  assert.equal(lost.ready, false);
  assert.equal(lost.reachable, false);
  assert.equal(Object.hasOwn(lost, "runtimeStatus"), false);
  assert.equal(lost.error.code, "ONEBOT_NETWORK_ERROR");
  assert.deepEqual(recoveryHint(lost), {});
  assert.deepEqual(fixture.calls, ["/get_status"]);
  fixture.probe.disconnect = false;
  for (const status of [null, {}, { online: true }, { good: true }, { good: false }, { online: "false", good: 0 }]) {
    fixture.probe.status = status;
    const result = await readStatus(fixture.notifier);
    assert.equal(result.ready, false);
    assert.deepEqual(recoveryHint(result), {});
  }
});

test("a closed loopback endpoint shows a manual hint only with a fresh verified stop and active manual hold", async context => {
  const fixture = await createStatusFixture(context);
  await fixture.closeEndpoint();
  fixture.writeRuntime(snapshot());
  const refused = await readStatus(fixture.notifier);
  assert.equal(refused.error.code, "ONEBOT_NETWORK_ERROR");
  assert.equal(refused.reachable, false);
  assert.deepEqual(recoveryHint(refused), {});
  const value = snapshot();
  value.state = "running";
  value.login = { blocked: true };
  value.autoOfflineRecovery.manualAfterVerifiedStopAt = NOW_MS - 1000;
  fixture.writeRuntime(value);
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), {});
  const barrierFile = path.join(path.dirname(fixture.runtimePath), "napcat-offline-recovery.json");
  const barrier = { ...loadOfflineRecoveryState(), needsManual: true, manualAfterVerifiedStopAt: NOW_MS - 1000 };
  fixture.writeRuntime({ ...barrier, manualAfterVerifiedStopAt: NOW_MS - 1001 }, barrierFile);
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), {});
  fixture.writeRuntime(barrier, barrierFile);
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), MANUAL_HINT);
  for (const unsafe of [
    { ...value, state: "stopped" },
    { ...value, login: { blocked: false } },
    { ...value, updatedAt: new Date(NOW_MS - 151_000).toISOString() },
  ]) {
    fixture.writeRuntime(unsafe);
    assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), {});
  }
});

test("localhost dual-stack refusal is confirmed only when every connection was refused", async context => {
  const connectionError = (code, address, port) => Object.assign(new Error("fixture connection"), {
    code, syscall: "connect", address, port,
  });
  let failureMode = "refused";
  const fixture = await createStatusFixture(context, { useLocalhost: true, fetchImpl: async (url, options) => {
    const target = new URL(url);
    assert.equal(target.hostname, "localhost");
    assert.equal(options.redirect, "error");
    const port = Number(target.port);
    const ipv6 = connectionError(failureMode === "denied" ? "EACCES" : "ECONNREFUSED", "::1", port);
    const ipv4 = connectionError("ECONNREFUSED", failureMode === "wrong-address" ? "192.0.2.1" : "127.0.0.1",
      failureMode === "wrong-port" ? port + 1 : port);
    const errors = failureMode === "empty" ? [] : [ipv6, ipv4];
    throw new TypeError("fetch failed", { cause: new AggregateError(errors) });
  } });
  const stoppedAt = NOW_MS - 1000;
  const value = snapshot();
  value.state = "running";
  value.login = { blocked: true };
  value.autoOfflineRecovery.manualAfterVerifiedStopAt = stoppedAt;
  fixture.writeRuntime(value);
  fixture.writeRuntime({ ...loadOfflineRecoveryState(), needsManual: true, manualAfterVerifiedStopAt: stoppedAt },
    path.join(path.dirname(fixture.runtimePath), "napcat-offline-recovery.json"));
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), MANUAL_HINT);
  for (failureMode of ["denied", "wrong-port", "wrong-address", "empty"]) {
    const status = await readStatus(fixture.notifier);
    assert.deepEqual(recoveryHint(status), {}, failureMode);
    assert.equal(status.offlineRecoveryProbe, failureMode === "denied" ? "loopback_family_unverified" : undefined, failureMode);
  }
});

test("a redirect to a different closed port does not establish a direct OneBot refusal", async context => {
  const fixture = await createStatusFixture(context);
  const closed = await createStatusFixture(context);
  await closed.closeEndpoint();
  const stoppedAt = NOW_MS - 1000;
  const value = snapshot();
  value.state = "running";
  value.login = { blocked: true };
  value.autoOfflineRecovery.manualAfterVerifiedStopAt = stoppedAt;
  fixture.writeRuntime(value);
  fixture.writeRuntime({ ...loadOfflineRecoveryState(), needsManual: true, manualAfterVerifiedStopAt: stoppedAt },
    path.join(path.dirname(fixture.runtimePath), "napcat-offline-recovery.json"));
  fixture.probe.redirect = closed.baseUrl + "/get_status";
  const result = await readStatus(fixture.notifier);
  assert.deepEqual(recoveryHint(result), {});
  assert.deepEqual(fixture.calls, ["/get_status"]);
});

test("the native notice accepts only the same fresh verified stop when its loopback listener is gone",
  { skip: process.platform !== "win32" }, async context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-native-offline-notice-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const listener = http.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    const closed = once(listener, "close");
    listener.close();
    await closed;
    fs.mkdirSync(path.join(root, "state"));
    fs.writeFileSync(path.join(root, "binding.json"), JSON.stringify({
      expectedSelfId: "100001", controlPlane: { localMachine: "development" },
    }));
    fs.writeFileSync(path.join(root, "broker-private.env.json"), JSON.stringify({
      NAPCAT_HTTP_URL: `http://127.0.0.1:${port}`, NAPCAT_ACCESS_TOKEN: "fixture-only-token",
    }));
    const runner = path.join(root, "notice-probe.ps1");
    fs.writeFileSync(runner, [
      "param([string]$Root,[string]$Ops)",
      "$ErrorActionPreference='Stop'",
      ". (Join-Path $Ops 'restart-napcat-qr-login.ps1')",
      ". (Join-Path $Ops 'show-napcat-offline-notice.ps1')",
      "function Get-NapCatQrDesktopIdentity { @{ sid='fixture-sid'; sessionId=1; explorerId=200 } }",
      "$Config=Join-Path $Root 'interactive.json'",
      "@{schemaVersion=1; machineRole='development'; computerName=[Environment]::MachineName; userSid='fixture-sid'; offlineNoticeEnabled=$true; dataRoot=$Root; brokerRoot=$Root} | ConvertTo-Json -Compress | Set-Content -LiteralPath $Config -Encoding UTF8",
      "$At=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
      "$Key='napcat-offline-' + $At",
      "$StateDir=Join-Path $Root 'state'",
      "$Hold=@{schemaVersion=1; needsManual=$true; manualAfterVerifiedStopAt=($At-1000); noticeAttemptAt=$At; noticeAt=$null}",
      "$Runtime=@{state='running'; updatedAt=[DateTimeOffset]::UtcNow.ToString('o'); login=@{blocked=$true}; autoOfflineRecovery=$Hold; actions=@{offlineNotice=@{incidentKey=$Key}}}",
      "function Save-Stage {",
      "  $Hold | ConvertTo-Json -Depth 7 -Compress | Set-Content -LiteralPath (Join-Path $StateDir 'napcat-offline-recovery.json') -Encoding UTF8",
      "  $Runtime | ConvertTo-Json -Depth 7 -Compress | Set-Content -LiteralPath (Join-Path $StateDir 'supervisor-runtime.json') -Encoding UTF8",
      "}",
      "$script:Shown=0",
      "Save-Stage",
      "$Next=Invoke-NapCatOfflineNotice $Config $Key { $script:Shown++ }",
      "$Other=Invoke-NapCatOfflineNotice $Config ('napcat-offline-' + ($At+1)) { $script:Shown++ }",
      "$Hold.manualAfterVerifiedStopAt=$null",
      "Save-Stage",
      "$Unknown=Invoke-NapCatOfflineNotice $Config $Key { $script:Shown++ }",
      "$Hold.manualAfterVerifiedStopAt=$At-1000",
      "$Runtime.updatedAt=[DateTimeOffset]::UtcNow.AddMinutes(-3).ToString('o')",
      "Save-Stage",
      "$Expired=Invoke-NapCatOfflineNotice $Config $Key { $script:Shown++ }",
      "@{ same=$Next; other=$Other; unknown=$Unknown; stale=$Expired; displayed=$script:Shown } | ConvertTo-Json -Compress",
    ].join("\r\n"), "utf8");
    const configuredPowerShell = (process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH || process.env.NAPCAT_POWERSHELL_PATH || "").trim();
    let native;
    if (configuredPowerShell) {
      if (path.win32.basename(configuredPowerShell).toLowerCase() === "pwsh.exe") {
        const environment = { ...process.env };
        for (const key of Object.keys(environment)) {
          const lower = key.toLowerCase();
          if (lower === "psmodulepath" || lower === "psexecutionpolicypreference") delete environment[key];
        }
        native = { executable: configuredPowerShell, environment };
      } else {
        const base = windowsPowerShellEnvironment();
        const environment = { ...base.environment };
        for (const key of Object.keys(environment)) {
          if (key.toLowerCase() === "psexecutionpolicypreference") delete environment[key];
        }
        native = { executable: configuredPowerShell, environment };
      }
    } else {
      const base = windowsPowerShellEnvironment();
      const environment = { ...base.environment };
      for (const key of Object.keys(environment)) {
        if (key.toLowerCase() === "psexecutionpolicypreference") delete environment[key];
      }
      native = { executable: base.executable, environment };
    }
    const isPwsh = path.win32.basename(native.executable).toLowerCase() === "pwsh.exe";
    const result = await promisify(execFile)(native.executable, ["-NoLogo", "-NoProfile", "-NonInteractive",
      ...(isPwsh ? [] : ["-ExecutionPolicy", "Bypass"]),
      "-File", runner, "-Root", root, "-Ops", path.resolve("ops")], { env: native.environment, timeout: 26_000, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout), {
      same: "notice_returned", other: "notice_offline_unverified", stale: "notice_offline_unverified",
      unknown: "notice_offline_unverified", displayed: 1,
    });
  });

test("missing, corrupt, expired, future and non-manual snapshots add no hint", async (context) => {
  const fixture = await createStatusFixture(context);
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), {});
  const scenarios = {
    malformed: "{",
    expired: snapshot(true, new Date(NOW_MS - 150_001).toISOString()),
    future: snapshot(true, new Date(NOW_MS + 1).toISOString()),
    invalidTime: snapshot(true, "bad timestamp"),
    missingTime: { autoOfflineRecovery: { needsManual: true } },
    oldFormat: { updatedAt: snapshot().updatedAt, login: { blockedReason: { code: "NAPCAT_MANUAL_LOGIN_REQUIRED" } } },
    noManual: snapshot(false),
    wrongType: snapshot("true"),
  };
  for (const [label, value] of Object.entries(scenarios)) {
    fixture.writeRuntime(value);
    assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), {}, label);
  }
});

test("configured supervisor data root wins over unrelated state and ignores a tool argument path", async (context) => {
  const fixture = await createStatusFixture(context, { useDataRoot: true });
  fixture.writeRuntime(snapshot(), fixture.siblingRuntimePath);
  const callerPath = { supervisorRuntimeStatePath: fixture.siblingRuntimePath };
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier, callerPath)), {});
  fixture.writeRuntime(snapshot());
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), MANUAL_HINT);
});

test("the notifier can explicitly inject an isolated supervisor runtime path", async (context) => {
  const fixture = await createStatusFixture(context, { useDataRoot: true, override: true });
  fixture.writeRuntime(snapshot());
  assert.deepEqual(recoveryHint(await readStatus(fixture.notifier)), MANUAL_HINT);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { repairDesktopLauncher } from "../ops/build-startup-repair.mjs";

test("desktop recovery removes the emergency history trimming and fails managed readiness without a second start", () => {
  const source = `function Start-RequiredRuntime {
    try {
      $MpPath=Join-Path $Plan.dataRoot 'state/inner-managed'
      $reason='gate_resolved_unclean_exit';$backup='.crash-'
    } catch {}
    $StartModelArgs=@{DataRoot=$Plan.dataRoot}
    $AppDeadline=[DateTime]::UtcNow.AddSeconds(60)
    if($null -eq $ProxyStatus) {
      $StartAppArgs=@{DataRoot=$Plan.dataRoot}
    }
}`;
  const repaired = repairDesktopLauncher(source);
  assert.ok(!repaired.includes("gate_resolved_unclean_exit"));
  assert.ok(repaired.includes("$StartModelArgs="));
  const refusal = repaired.indexOf("$ModelStatus.mode -eq 'managed') {throw 'APP_SERVER_PROXY_NOT_READY'}");
  assert.ok(refusal > 0 && refusal < repaired.indexOf("$StartAppArgs="));
  assert.equal(repairDesktopLauncher(repaired), repaired);
});

test("desktop readiness accepts the verified parked status and removes the raw emergency bypass", () => {
  const source = `      $Parked=$false
      try {$Parked=([string](Get-Content -LiteralPath (Join-Path $Plan.dataRoot 'state\\codex-app-server-proxy-runtime.json') -Raw -Encoding UTF8|ConvertFrom-Json).state -ceq 'waiting_for_desktop')} catch {}
      if(-not $ModelStatus.healthy -and -not $Parked) {throw 'MODEL_PROXY_NOT_READY'}`;
  const repaired = repairDesktopLauncher(source);
  assert.ok(!repaired.includes('$Parked'));
  assert.ok(repaired.includes('if(-not $ModelStatus.healthy -and -not $ModelStatus.readyForDesktop)'));
  assert.equal(repairDesktopLauncher(repaired), repaired);
  assert.equal(repairDesktopLauncher("if(-not $ModelStatus.healthy) {throw 'MODEL_PROXY_NOT_READY'}"),
    "if(-not $ModelStatus.healthy -and -not $ModelStatus.readyForDesktop) {throw 'MODEL_PROXY_NOT_READY'}");
});

function Test-CodexManagedStartupReadiness {
  param($Startup, [string]$DataRoot, $RuntimeState, [int]$ControlPort, [string]$TokenFilePath)

  if (-not $Startup.innerManagedProfilePath) { return $true }
  $Profile = Get-CodexInnerManagedStartupProfile -Startup $Startup -DataRoot $DataRoot
  $ExpectedHashes = $Profile.initial.expectedHashes
  function Test-StartupWorkerHashes($ActualHashes) {
    foreach ($HashName in @('runner', 'core', 'helper', 'control')) {
      if ([string]$ExpectedHashes.$HashName -cnotmatch '^[a-f0-9]{64}$' -or
          $ActualHashes.$HashName -cne $ExpectedHashes.$HashName) { return $false }
    }
    return $true
  }
  $RegistryPath = Join-Path $Profile.stateRoot 'inner-candidate-approvals.json'
  $RegistryHash = $null
  $Selection = $null
  if (Test-Path -LiteralPath $RegistryPath -PathType Leaf) {
    Assert-CodexStartupPathWithoutReparsePoint -Path $RegistryPath
    if ((Get-Item -LiteralPath $RegistryPath).Length -gt 65536) { throw 'FULL_RUNTIME_STARTUP_REGISTRY_INVALID' }
    $RegistryHash = (Get-FileHash -LiteralPath $RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $Registry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Registry.schemaVersion -ne 1 -or $Registry.ownerId -cne $Profile.ownerId -or
        $Registry.nativeSourceId -cne $Profile.nativeSourceId) { throw 'FULL_RUNTIME_STARTUP_REGISTRY_INVALID' }
    $Selection = $Registry.selection
    if ($null -ne $Selection) {
      $Candidate = @($Registry.candidates | Where-Object { $_.id -ceq $Selection.candidateId })
      if ($Candidate.Count -ne 1 -or [string]$Selection.manifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
          [IO.Path]::GetFullPath([string]$Selection.manifestPath) -ine
          [IO.Path]::GetFullPath((Join-Path $Candidate[0].installationRoot 'src/manifest.json'))) { throw 'FULL_RUNTIME_STARTUP_SELECTION_INVALID' }
      Assert-CodexStartupPathWithoutReparsePoint -Path $Selection.manifestPath
      if ((Get-FileHash -LiteralPath $Selection.manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
          $Selection.manifestSha256) { throw 'FULL_RUNTIME_STARTUP_MANIFEST_CHANGED' }
      $ExpectedHashes = $Candidate[0].expectedHashes
    }
  }
  Assert-CodexStartupPathWithoutReparsePoint -Path $TokenFilePath
  if ((Get-FileHash -LiteralPath $TokenFilePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
      $Profile.controlTokenSha256) { throw 'FULL_RUNTIME_STARTUP_TOKEN_CHANGED' }
  $Headers = @{ Authorization = 'Bearer ' + [IO.File]::ReadAllText($TokenFilePath).Trim();
    'x-inner-owner-id' = [string]$Profile.ownerId; 'x-inner-native-source-id' = [string]$Profile.nativeSourceId;
    'x-inner-instance-token' = [string]$RuntimeState.instanceToken }
  try { $Full = Invoke-RestMethod -Uri "http://127.0.0.1:$ControlPort/v1/full-runtime" -Headers $Headers -TimeoutSec 1 }
  catch { return $false }
  if ($Full.instanceId -cne $RuntimeState.instanceToken) { throw 'FULL_RUNTIME_STARTUP_INSTANCE_CHANGED_PRESERVED' }
  if ($Full.failed -eq $true) { throw 'FULL_RUNTIME_STARTUP_FAILED_PRESERVED' }
  if ($Full.ok -ne $true -or $Full.busy -ne $false -or $Full.failed -ne $false -or
      $Full.candidateRegistrySha256 -cne $RegistryHash) { return $false }
  if ($null -ne $Selection) {
    if ($Full.selected.manifestSha256 -cne $Selection.manifestSha256) { return $false }
  } elseif ($Full.selected.id -cne 'original' -or $null -ne $Full.selected.manifestSha256) { return $false }
  if ($null -eq $Full.modelWorker) {
    if ($null -ne $Selection) { return $false }
  } elseif ([string]::IsNullOrWhiteSpace([string]$Full.modelWorker.workerId) -or
      -not (Test-StartupWorkerHashes $Full.modelWorker.sourceHashes)) { return $false }
  try {
    $Managed = Get-Content -LiteralPath $Profile.managedStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$Managed.livenessAt).TotalSeconds
  } catch { return $false }
  if ($Managed.pid -ne $RuntimeState.pid -or $Managed.instanceToken -cne $RuntimeState.instanceToken -or
      $Managed.ownerId -cne $Profile.ownerId -or $Managed.nativeSourceId -cne $Profile.nativeSourceId -or
      $Managed.state -cne 'running' -or $Age -lt -2 -or $Age -gt 15) { return $false }
  $InnerListener = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$Profile.ports.inner) -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $RuntimeState.pid })
  if ($InnerListener.Count -eq 0) { return $false }
  if ($RuntimeState.state -cne 'waiting_for_desktop') {
    try { $Inner = Invoke-RestMethod -Uri "http://127.0.0.1:$ControlPort/v1/inner/status" -Headers $Headers -TimeoutSec 1 }
    catch { return $false }
    if ($Inner.ok -ne $true -or $Inner.instanceToken -cne $RuntimeState.instanceToken -or
        $Inner.ownerId -cne $Profile.ownerId -or $Inner.nativeSourceId -cne $Profile.nativeSourceId -or
        $Inner.coordinator.running -ne $true -or $Inner.coordinator.nativeHealthy -ne $true -or
        ($null -ne $Full.modelWorker -and $Inner.selectedWorkerId -cne $Full.modelWorker.workerId) -or
        -not (Test-StartupWorkerHashes $Inner.selectedSourceHashes)) { return $false }
    $Worker = @($Inner.coordinator.workers | Where-Object { $_.workerId -ceq $Inner.selectedWorkerId -and $_.alive -eq $true })
    if ($Worker.Count -ne 1 -or -not (Test-StartupWorkerHashes $Worker[0].sourceHashes)) { return $false }
  } else {
    if ([string]::IsNullOrWhiteSpace([string]$Managed.coordinator.defaultWorkerId) -or
        ($null -ne $Full.modelWorker -and $Managed.coordinator.defaultWorkerId -cne $Full.modelWorker.workerId)) { return $false }
    $Worker = @($Managed.coordinator.workers | Where-Object { $_.workerId -ceq $Managed.coordinator.defaultWorkerId -and $_.alive -eq $true })
    if ($Worker.Count -ne 1 -or -not (Test-StartupWorkerHashes $Worker[0].sourceHashes)) { return $false }
  }
  $CurrentRegistryHash = if (Test-Path -LiteralPath $RegistryPath -PathType Leaf) {
    (Get-FileHash -LiteralPath $RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  } else { $null }
  return $CurrentRegistryHash -ceq $RegistryHash
}

[CmdletBinding()]
param(
  [ValidateSet('VerifyOnly', 'Apply', 'Recover')][string]$Mode = 'VerifyOnly',
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$ConfigSha256
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$Utf8 = New-Object Text.UTF8Encoding($false)
$Claim = $null
$RecoveryGate = $null
$Claimed = $false
$WriteAttempted = $false
$ExitCode = 0
$Result = [ordered]@{ schemaVersion = 1; mode = $Mode; status = 'refused'; productionWritten = $false; desktopReopened = $false; businessReady = $false; error = $null; startedAt = [DateTimeOffset]::UtcNow.ToString('o') }

function Plain-File([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':')) { throw 'OWNER_ABSOLUTE_FILE_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Path)
  $Item = Get-Item -LiteralPath $Full -Force
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Item.LinkType) { throw 'OWNER_LINKED_INPUT_REJECTED' }
  return $Full
}

function Sha([string]$Path) { return (Get-FileHash -LiteralPath (Plain-File $Path) -Algorithm SHA256).Hash.ToLowerInvariant() }
function Json([string]$Path) { $Full = Plain-File $Path; if ((Get-Item -LiteralPath $Full).Length -gt 1048576) { throw 'OWNER_JSON_TOO_LARGE' }; return Get-Content -LiteralPath $Full -Encoding UTF8 -Raw | ConvertFrom-Json }

function Write-NewJson([string]$Path, $Value) {
  $Stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $Bytes = $Utf8.GetBytes(($Value | ConvertTo-Json -Depth 20)); $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) } finally { $Stream.Dispose() }
}

function Save-Claim([string]$Phase) {
  if (-not $Claim) { return }
  $Intent.phase = $Phase
  $Bytes = $Utf8.GetBytes(($Intent | ConvertTo-Json -Depth 12))
  $Claim.Position = 0; $Claim.SetLength(0); $Claim.Write($Bytes, 0, $Bytes.Length); $Claim.Flush($true)
}

function Assert-IndependentTerminalOrigin([int]$InitialProcessId) {
  $ProcessId = $InitialProcessId
  $Seen = New-Object 'Collections.Generic.HashSet[int]'
  $ChildCreated = $null
  $SessionId = $null
  $ExplorerPath = [IO.Path]::Combine([Environment]::GetFolderPath('Windows'), 'explorer.exe')
  for ($Depth = 0; $Depth -lt 32 -and $ProcessId; $Depth++) {
    if (-not $Seen.Add($ProcessId)) { throw 'OWNER_INDEPENDENT_TERMINAL_REQUIRED' }
    $Matches = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
    if ($Matches.Count -ne 1) { throw 'OWNER_INDEPENDENT_TERMINAL_REQUIRED' }
    $Process = $Matches[0]
    if ([int]$Process.ProcessId -ne $ProcessId -or -not $Process.ExecutablePath -or -not $Process.CommandLine -or -not $Process.CreationDate -or $null -eq $Process.SessionId -or [string]$Process.CommandLine -match 'app-server|mcp-http-broker|sandbox-data|codex-command-runner|codex-windows-sandbox|WindowsJobRunner' -or [string]$Process.Name -match '^(ChatGPT|codex|codex-command-runner|codex-windows-sandbox-setup|WindowsJobRunner)\.exe$') { throw 'OWNER_INDEPENDENT_TERMINAL_REQUIRED' }
    $Created = ([DateTime]$Process.CreationDate).ToUniversalTime()
    if ($ChildCreated -and $Created -gt $ChildCreated) { throw 'OWNER_INDEPENDENT_TERMINAL_REQUIRED' }
    if ($null -eq $SessionId) { $SessionId = [int]$Process.SessionId }
    if ([int]$Process.SessionId -ne $SessionId) { throw 'OWNER_INDEPENDENT_TERMINAL_REQUIRED' }
    if ([string]$Process.Name -ieq 'explorer.exe' -and [string]$Process.ExecutablePath -ieq $ExplorerPath) {
      return [pscustomobject]@{ shellPid = $InitialProcessId; explorerPid = $ProcessId; sessionId = $SessionId; explorerCreatedUtc = $Created.ToString('o'); verifiedDepth = $Depth }
    }
    $ChildCreated = $Created
    $ProcessId = [int]$Process.ParentProcessId
  }
  throw 'OWNER_INDEPENDENT_TERMINAL_REQUIRED'
}

function Independent-Terminal {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop' -or (Get-ExecutionPolicy) -ne 'RemoteSigned' -or (Get-ExecutionPolicy -Scope Process) -ne 'Undefined') { throw 'OWNER_ORDINARY_WINDOWS_POWERSHELL_REQUIRED' }
  $Result.terminalOrigin = Assert-IndependentTerminalOrigin $PID
}

function Invoke-Parent([string]$Action, [string]$WindowPath = '', [string]$WindowSha = '') {
  Save-Claim $Action
  $Arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Config.parentPath, '-Action', $Action, '-PlanPath', $Config.planPath, '-PlanSha256', $Config.planSha256)
  if ($WindowPath) { $Arguments += @('-WindowPath', $WindowPath, '-WindowSha256', $WindowSha) }
  $Previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $Raw = @(& $Plan.powerShell.path @Arguments 2>&1); $Code = $LASTEXITCODE } finally { $ErrorActionPreference = $Previous }
  $Text = ($Raw | ForEach-Object { [string]$_ }) -join "`n"
  $Response = $null
  try { $Response = $Text | ConvertFrom-Json } catch { throw ('OWNER_PARENT_RESULT_UNKNOWN: ' + $Action) }
  $Result.parentResults += [pscustomobject]@{ action = $Action; exitCode = $Code; result = $Response }
  return [pscustomobject]@{ code = $Code; result = $Response }
}

function Observe-Desktop {
  Save-Claim 'ObserveDesktopExit'
  $ReadyPath = Join-Path $Root 'desktop-normal-observer-ready.json'
  $OutputPath = Join-Path $Root 'desktop-observer.stdout.json'
  $ErrorPath = Join-Path $Root 'desktop-observer.stderr.txt'
  foreach ($Path in @($ReadyPath, $OutputPath, $ErrorPath)) { if (Test-Path -LiteralPath $Path) { throw 'OWNER_OLD_OBSERVER_ARTIFACT_PRESERVED' } }
  $Arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Config.parentPath, '-Action', 'ObserveDesktopExit', '-PlanPath', $Config.planPath, '-PlanSha256', $Config.planSha256)
  $Quoted = @($Arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
  $Observer = Start-Process -FilePath $Plan.powerShell.path -ArgumentList $Quoted -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutputPath -RedirectStandardError $ErrorPath -PassThru
  [void]$Observer.Handle
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $ReadyPath)) {
    $Observer.Refresh()
    if ($Observer.HasExited -or [DateTimeOffset]::UtcNow -ge $Deadline) { throw 'OWNER_DESKTOP_OBSERVER_NOT_READY' }
    Start-Sleep -Milliseconds 100
  }
  $Ready = Json $ReadyPath
  if ($Ready.ownerId -cne $Plan.ownerId -or $Ready.planSha256 -cne $Config.planSha256 -or [int]$Ready.observerPid -ne $Observer.Id -or $Ready.handlesPinned -ne $true) { throw 'OWNER_DESKTOP_OBSERVER_BINDING_CHANGED' }
  Write-Host 'Now use the Codex application menu to Exit completely. This independent terminal continues afterwards.'
  $Observer.WaitForExit()
  $ExitCode = $Observer.ExitCode
  if ($null -eq $ExitCode) { throw 'OWNER_OBSERVER_EXIT_CODE_UNKNOWN' }
  $Response = Json $OutputPath
  $Result.parentResults += [pscustomobject]@{ action = 'ObserveDesktopExit'; exitCode = $ExitCode; result = $Response }
  return [pscustomobject]@{ code = $ExitCode; result = $Response }
}

function Update-ProductionWriteState {
  if (-not $WriteAttempted) { return }
  $Result.productionWritten = $null
  $Result.productionWriteState = 'unknown'
  try {
    $ContractPath = Join-Path $Plan.transaction.contractRoot 'transaction-contract.json'
    if ((Sha $ContractPath) -cne $Plan.transaction.contractSha256) { throw 'OWNER_TRANSACTION_CONTRACT_CHANGED' }
    $Contract = Json $ContractPath
    if ($Contract.ownerId -cne $Plan.ownerId -or $Contract.parentAttemptId -cne $Plan.attemptId) { throw 'OWNER_TRANSACTION_ATTEMPT_CHANGED' }
    $ReceiptPath = Join-Path $Plan.transaction.contractRoot 'transaction-attempt.json'
    if (-not (Test-Path -LiteralPath $ReceiptPath)) {
      $Preserved = @($Result.parentResults | Where-Object { $_.action -ceq 'ExecuteWindow' -and $_.result.status -ceq 'failed-original-preserved' -and $_.result.originalStateVerified -eq $true -and $_.result.productionModified -eq $false -and $_.result.preservedPlanSha256 -ceq $Config.planSha256 -and $_.result.preservedOwnerId -ceq $Plan.ownerId -and $_.result.preservedAttemptId -ceq $Plan.attemptId -and $_.result.preservedIdentity.instanceToken -ceq $Plan.stopIdentity.instanceToken })
      if ($Preserved.Count -eq 1) { $Result.productionWritten = $false; $Result.productionWriteState = 'not-written'; $Result.productionWriteEvidence = 'verified-original-preserved-parent' }
      return
    }
    $Receipt = Json $ReceiptPath
    if ($Receipt.schemaVersion -ne 1 -or $Receipt.ownerId -cne $Plan.ownerId -or $Receipt.contractSha256 -cne $Plan.transaction.contractSha256 -or $Receipt.windowSha256 -cne (Sha $WindowPath) -or $null -eq $Receipt.mayHaveWritten) { throw 'OWNER_TRANSACTION_RECEIPT_CHANGED' }
    $Result.productionWritten = $Receipt.mayHaveWritten -eq $true -or @($Receipt.written).Count -gt 0
    $Result.productionWriteState = if ($Result.productionWritten) { 'written' } else { 'not-written' }
    $Result.transactionReceiptPath = $ReceiptPath
    $Result.transactionReceiptSha256 = Sha $ReceiptPath
  } catch { $Result.productionWriteEvidenceError = $_.Exception.Message }
}

function Probe-And-Reopen {
  Save-Claim 'business-probe'
  $Previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $Raw = @(& $Plan.node.path $Config.probePath $Plan.installedRoot $Plan.dataRoot ([string]$Plan.startup.DownstreamPort) 2>&1); $Code = $LASTEXITCODE } finally { $ErrorActionPreference = $Previous }
  $Response = (($Raw | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
  if ($Code -ne 0 -or $Response.businessReady -ne $true -or $Response.modelRequests -ne 0 -or $Response.loopbackOnly -ne $true) { throw 'OWNER_READONLY_BUSINESS_NOT_READY' }
  $Result.businessReady = $true; $Result.business = $Response
  if ($Config.desktopReopenMode -ceq 'Manual') { $Result.desktopReopenRequired = $true; $Result.desktopDisplayVerified = $false; $Result.finalAcceptance = 'pending-manual-desktop-record-and-tool-check'; Write-Host 'Files and backend checked. Open Codex from the Windows Start menu now.'; return }
  Save-Claim 'normal-desktop-reopen'
  if ((Sha $Plan.desktop.executablePath) -cne $Plan.desktop.sha256) { throw 'OWNER_DESKTOP_BUILD_CHANGED' }
  $Existing = @(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -ieq $Plan.desktop.executablePath })
  if ($Existing.Count) { throw 'OWNER_DESKTOP_ALREADY_REOPENED' }
  $Desktop = Start-Process -FilePath $Plan.desktop.executablePath -WorkingDirectory (Split-Path -Parent $Plan.desktop.executablePath) -WindowStyle Normal -PassThru
  Start-Sleep -Seconds 3
  $Opened = @(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -ieq $Plan.desktop.executablePath })
  if (-not $Opened.Count) { throw 'OWNER_DESKTOP_REOPEN_PROCESS_NOT_OBSERVED' }
  $Result.desktopLaunchPid = $Desktop.Id; $Result.desktopReopened = $true
  $Result.desktopDisplayVerified = $false; $Result.finalAcceptance = 'pending-desktop-record-and-tool-check'
}

try {
  if ($ConfigSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $ConfigPath) -cne $ConfigSha256) { throw 'OWNER_CONFIG_SHA_MISMATCH' }
  $Config = Json $ConfigPath
  if ($Config.schemaVersion -ne 1 -or $Config.scope -cne 'outer-first-adoption-19+1' -or (Sha $PSCommandPath) -cne $Config.entrySha256 -or (Sha $Config.parentPath) -cne $Config.parentSha256 -or (Sha $Config.planPath) -cne $Config.planSha256 -or (Sha $Config.probePath) -cne $Config.probeSha256) { throw 'OWNER_FIXED_ENTRY_BINDING_CHANGED' }
  $Plan = Json $Config.planPath
  $Root = Split-Path -Parent $Config.planPath
  if (-not $Root.StartsWith([IO.Path]::GetTempPath().TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase) -or $Plan.sampleRoot -or $Plan.executionProfile -cne 'OwnerColdFirstAdoption' -or $Plan.scope -cne $Config.scope -or $Plan.ownerId -cne $Config.ownerId -or $Plan.inputs[0].path -ine $Config.parentPath -or $Plan.inputs[0].sha256 -cne $Config.parentSha256 -or $Plan.transaction.contractSha256 -cne $Config.contractSha256) { throw 'OWNER_EXACT_PREPARED_PLAN_REQUIRED' }
  $Result.planSha256 = $Config.planSha256; $Result.parentAttemptId = $Plan.attemptId; $Result.parentResults = @()
  if ($Mode -eq 'VerifyOnly') {
    $Checked = Invoke-Parent 'VerifyOnly'
    if ($Checked.code -ne 0 -or $Checked.result.status -cne 'verified-only') { throw 'OWNER_PREPARED_ENTRY_NOT_VERIFIED' }
    $Result.status = 'verified-only'
  } else {
    Independent-Terminal
    if ($Mode -eq 'Apply' -and [DateTimeOffset]::Parse($Config.expiresAt) -le [DateTimeOffset]::UtcNow) { throw 'OWNER_START_WINDOW_EXPIRED' }
    $GatePath = Join-Path $Root 'owner-operation.lock'
    $GateExists = Test-Path -LiteralPath $GatePath
    if ($GateExists) {
      $Gate = Json $GatePath
      if ($Gate.ownerId -cne $Plan.ownerId -or $Gate.planSha256 -cne $Config.planSha256 -or $Gate.parentAttemptId -cne $Plan.attemptId) { throw 'OWNER_FOREIGN_OPERATION_GATE_PRESERVED' }
    }
    $RecoveryGate = [IO.File]::Open($GatePath, $(if ($GateExists) { [IO.FileMode]::Open } else { [IO.FileMode]::CreateNew }), [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    if (-not $GateExists) { $Bytes = $Utf8.GetBytes(([ordered]@{ ownerId = $Plan.ownerId; planSha256 = $Config.planSha256; parentAttemptId = $Plan.attemptId } | ConvertTo-Json)); $RecoveryGate.Write($Bytes, 0, $Bytes.Length); $RecoveryGate.Flush($true) }
    $WindowPath = Join-Path $Root 'owner-window.json'
    if ($Mode -eq 'Recover') {
      if (@(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -ieq $Plan.desktop.executablePath }).Count) { throw 'OWNER_DESKTOP_STILL_RUNNING' }
      if (-not (Test-Path -LiteralPath $WindowPath)) {
        $OriginalIntent = Json (Join-Path $Root 'owner-execution-intent.json')
        if ($OriginalIntent.mode -cne 'Apply' -or $OriginalIntent.ownerId -cne $Plan.ownerId -or $OriginalIntent.planSha256 -cne $Config.planSha256 -or $OriginalIntent.parentAttemptId -cne $Plan.attemptId -or (Test-Path -LiteralPath (Join-Path $Root 'attempt.json')) -or (Test-Path -LiteralPath (Join-Path $Plan.transaction.contractRoot 'transaction-attempt.json'))) { throw 'OWNER_PREWRITE_RECOVERY_NOT_PROVEN' }
      }
    }
    $Expected = 'APPROVE ' + $(if ($Mode -eq 'Apply') { 'OuterFirstAdoption' } else { 'RecoverOuter' }) + ' ' + $Plan.attemptId + ' ' + $Config.planSha256
    if ($Config.desktopReopenMode -ceq 'Manual') { Write-Host 'This first adoption normally closes Codex. Reopen it yourself from the Windows Start menu after this terminal completes. Windows and the inner proxy remain running.' } else { Write-Host 'This first adoption normally closes and reopens Codex. Windows and the inner proxy remain running. A verified original proxy may replace only its own official backend after Desktop exits.' }
    Write-Host ('Type exactly: ' + $Expected)
    if ((Read-Host 'Independent Windows owner confirmation') -cne $Expected) { throw 'OWNER_CONFIRMATION_DECLINED' }
    $RecoveryId = [Guid]::NewGuid().ToString('N')
    $ClaimPath = Join-Path $Root $(if ($Mode -eq 'Apply') { 'owner-execution-intent.json' } else { 'owner-recovery-intent-' + $RecoveryId + '.json' })
    $Claim = [IO.File]::Open($ClaimPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    $Claimed = $true
    $Intent = [ordered]@{ schemaVersion = 1; mode = $Mode; ownerId = $Plan.ownerId; parentAttemptId = $Plan.attemptId; planSha256 = $Config.planSha256; configSha256 = $ConfigSha256; operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; confirmationMatched = $true; phase = 'confirmed'; startedAt = $Result.startedAt }
    Save-Claim 'confirmed'
    if ($Mode -eq 'Apply') {
      $Observed = Observe-Desktop
      if ($Observed.code -ne 0 -or $Observed.result.status -cne 'desktop-normal-exit-observed') { throw 'OWNER_NORMAL_DESKTOP_EXIT_REQUIRED' }
      $Contract = Json (Join-Path $Plan.transaction.contractRoot 'transaction-contract.json')
      $Window = [ordered]@{ schemaVersion = 1; mode = 'OWNER_APPROVED_PRODUCTION_WINDOW'; authorizedByOwner = $true; approvalRef = $Config.approvalRef; scope = $Plan.scope; ownerId = $Plan.ownerId; operatorSid = $Intent.operatorSid; planSha256 = $Config.planSha256; preparationSha256 = $Plan.preparationSha256; parentSha256 = $Config.parentSha256; contractSha256 = $Plan.transaction.contractSha256; entrySha256 = $Contract.entrySha256; installedRoot = $Plan.installedRoot; dataRoot = $Plan.dataRoot; stopIdentity = $Plan.stopIdentity; startsAt = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o'); expiresAt = $Config.expiresAt; executionProfile = 'OwnerColdFirstAdoption'; acceptsShortInterruption = $true; acceptsLegacyRequestCounterLimit = $true; acceptsOwnedDesktopEmptyRestart = $true; recoveryAfterExpiry = $true; desktopExitSha256 = $Observed.result.desktopExitSha256 }
      Write-NewJson $WindowPath $Window
      $WindowSha = Sha $WindowPath
      $WriteAttempted = $true
      $Result.productionWritten = $null
      $Applied = Invoke-Parent 'ExecuteWindow' $WindowPath $WindowSha
      Update-ProductionWriteState
      if ($Applied.result.status -eq 'recovery-required') { $Applied = Invoke-Parent 'RecoverWindow' $WindowPath $WindowSha; $ExitCode = 1 }
      if ($Applied.result.status -notin @('window-applied', 'failed-restored', 'window-restored', 'already-restored-verified', 'failed-original-preserved')) { throw ('OWNER_APPLY_OR_RECOVERY_INCOMPLETE: ' + $Applied.result.status + '/' + $Applied.result.error) }
      $Result.status = $Applied.result.status
      if ($Applied.code -ne 0 -or $Result.status -ne 'window-applied') { $ExitCode = 1 }
    } else {
      if (Test-Path -LiteralPath $WindowPath) {
        $WriteAttempted = $true
        $Result.productionWritten = $null
        $Recovered = Invoke-Parent 'RecoverWindow' $WindowPath (Sha $WindowPath)
        if ($Recovered.code -ne 0 -or $Recovered.result.status -notin @('window-restored', 'already-restored-verified')) { throw ('OWNER_RECOVERY_INCOMPLETE: ' + $Recovered.result.error) }
        $Result.status = $Recovered.result.status; $Result.productionWritten = $true
      } else {
        $Checked = Invoke-Parent 'VerifyOnly'
        if ($Checked.code -ne 0 -or $Checked.result.status -cne 'verified-only') { throw 'OWNER_PREWRITE_ORIGINAL_NOT_VERIFIED' }
        $Result.status = 'original-service-preserved-reopen'
      }
    }
    if ($Result.status -ceq 'failed-original-preserved' -and ($Result.productionWritten -ne $false -or $Result.productionWriteState -cne 'not-written' -or $Result.productionWriteEvidence -cne 'verified-original-preserved-parent' -or $Result.productionWriteEvidenceError)) { throw 'OWNER_ORIGINAL_PRESERVATION_PROOF_REQUIRED' }
    Probe-And-Reopen
    Save-Claim 'result-saved'
  }
} catch { $Result.error = $_.Exception.Message; $Result.status = 'preserved-requires-review'; $ExitCode = 1 }
finally {
  Update-ProductionWriteState
  $Result.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  if ($Claimed) {
    try { $Result.resultPath = Join-Path $Root $(if ($Mode -eq 'Apply') { 'owner-result.json' } else { 'owner-recovery-result-' + $RecoveryId + '.json' }); Write-NewJson $Result.resultPath $Result } catch { $Result.resultSaveError = $_.Exception.Message; $ExitCode = 1 }
  }
  if ($Claim) { $Claim.Dispose() }
  if ($RecoveryGate) { $RecoveryGate.Dispose() }
  $Result | ConvertTo-Json -Depth 20
}
if ($ExitCode) { exit $ExitCode }

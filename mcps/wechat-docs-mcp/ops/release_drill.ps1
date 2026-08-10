function New-DrillLayout {
  param([string]$CaseRoot, [string]$Shape, [string]$SourceManifestPath)
  $Service = Join-Path $CaseRoot "service"
  $Data = Join-Path $CaseRoot "data"
  $Broker = Join-Path $CaseRoot "broker"
  $OldReleaseId = "release-old"
  $CandidateId = "release-candidate"
  $OldRelease = Join-Path $Service "releases\$OldReleaseId"
  $Candidate = Join-Path $Service "releases\$CandidateId"
  New-Item -ItemType Directory -Path $OldRelease, $Candidate, (Join-Path $Service "pointers"), (Join-Path $Data "config"), (Join-Path $Data "state"), $Broker -Force | Out-Null
  Write-JsonAtomic -Path (Join-Path $OldRelease "service-manifest.json") -Value ([pscustomobject]@{ schemaVersion = 1; releaseId = $OldReleaseId; sourceCommit = "old-commit" })
  $Manifest = Read-Json $SourceManifestPath
  Set-JsonProperty -Object $Manifest -Name "releaseId" -Value $CandidateId
  Set-JsonProperty -Object $Manifest -Name "sourceCommit" -Value "candidate-commit"
  if ($Shape -eq "missing-validation") {
    $Manifest.PSObject.Properties.Remove("validation")
  } elseif ($Shape -eq "null-validation") {
    Set-JsonProperty -Object $Manifest -Name "validation" -Value $null
  } elseif ($Shape -eq "null-active-backend") {
    $Validation = Ensure-JsonObject -Parent $Manifest -Name "validation"
    Set-JsonProperty -Object $Validation -Name "activeBackend" -Value $null
  }
  Set-JsonProperty -Object $Manifest -Name "activated" -Value $false
  Set-JsonProperty -Object $Manifest -Name "currentSwitched" -Value $false
  Set-JsonProperty -Object $Manifest -Name "productionBrokerConnected" -Value $false
  Write-JsonAtomic -Path (Join-Path $Candidate "service-manifest.json") -Value $Manifest
  New-Item -ItemType Junction -Path (Join-Path $Service "current") -Target $OldRelease | Out-Null
  Write-JsonAtomic -Path (Join-Path $Service "pointers\active.json") -Value (New-ReleasePointer -ReleaseId $OldReleaseId -ReleasePath $OldRelease -SourceCommit "old-commit" -Activated $true -Reason "fixture")
  Write-JsonAtomic -Path (Join-Path $Service "pointers\candidate.json") -Value (New-ReleasePointer -ReleaseId $CandidateId -ReleasePath $Candidate -SourceCommit "candidate-commit" -Activated $false -Reason "fixture")
  Write-JsonAtomic -Path (Join-Path $Service "pointers\last-known-good.json") -Value (New-ReleasePointer -ReleaseId $OldReleaseId -ReleasePath $OldRelease -SourceCommit "old-commit" -Activated $true -Reason "fixture")
  Write-JsonAtomic -Path (Join-Path $Data "config\service-runtime.json") -Value ([pscustomobject]@{ schemaVersion = 1; releaseId = $OldReleaseId })
  Write-JsonAtomic -Path (Join-Path $Broker "broker-private.env.json") -Value ([pscustomobject]@{ CODEX_MCP_BROKER_CONTROL_TOKEN = "fixture-token"; WECHAT_DOCS_MCP_ROOT = (Join-Path $Service "current"); WECHAT_DOCS_MCP_PYTHON = "fixture-python" })
  Write-JsonAtomic -Path (Join-Path $Data "state\supervisor-runtime.json") -Value ([pscustomobject]@{ pid = 7001; healthy = $true; consecutiveFailures = 0; backendPid = 5100; backendGeneration = 3 })
  $FixtureStatePath = Join-Path $CaseRoot "fixture-health.json"
  Write-JsonAtomic -Path $FixtureStatePath -Value ([pscustomobject]@{
    brokerPid = 4242
    endpoints = [pscustomobject]@{
      "wechat-docs" = [pscustomobject]@{ healthy = $true; toolCount = $ExpectedCurrentToolCount; pid = 5100; generation = 3 }
      napcat = [pscustomobject]@{ healthy = $true; toolCount = 22; pid = 5200; generation = 2 }
    }
    supervisor = [pscustomobject]@{ pid = 7001; healthy = $true; consecutiveFailures = 0; backendPid = 5100; backendGeneration = 3 }
  })
  $LedgerPath = Join-Path $Data "state\events.sqlite3"
  & $ProbePython $ProbeScript create-fixture --ledger $LedgerPath --route-id "route-fixture" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Fixture ledger creation failed" }
  return [pscustomobject]@{ service = $Service; data = $Data; broker = $Broker; oldReleaseId = $OldReleaseId; candidateReleaseId = $CandidateId; fixtureStatePath = $FixtureStatePath }
}

function Invoke-Drill {
  if ([string]::IsNullOrWhiteSpace($CandidateManifestPath)) { throw "Drill requires CandidateManifestPath" }
  $CandidateSourceRoot = Split-Path -Parent (Get-FullPath $CandidateManifestPath)
  if ([string]::IsNullOrWhiteSpace($ProbePython)) { $script:ProbePython = Join-Path $CandidateSourceRoot "env\Scripts\python.exe" }
  if (-not (Test-Path -LiteralPath $ProbePython -PathType Leaf)) { throw "Candidate Python not found: $ProbePython" }
  $CandidatePackageInfo = Get-CandidatePackageInfo -PythonPath $ProbePython -ReleasePath $CandidateSourceRoot
  $CandidatePackage = [pscustomobject]@{ checked = $true; insideRelease = [bool]$CandidatePackageInfo.inside_release; toolCount = [int]$CandidatePackageInfo.tool_count }
  if ($CandidatePackage.insideRelease -ne $true -or $CandidatePackage.toolCount -ne $ExpectedToolCount) { throw "Candidate package readiness probe failed" }
  if ([string]::IsNullOrWhiteSpace($DrillRoot)) { $script:DrillRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wechat-docs-release-drill-" + [guid]::NewGuid().ToString("N")) }
  $Root = Get-FullPath $DrillRoot
  foreach ($ProtectedRoot in @((Get-FullPath $ServiceRoot), (Get-FullPath $DataRoot), (Get-FullPath $BrokerRoot))) {
    if ($Root -eq $ProtectedRoot -or $Root.StartsWith($ProtectedRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw "DrillRoot must not be inside a production root" }
  }
  if (Test-Path -LiteralPath $Root) { throw "DrillRoot already exists: $Root" }
  New-Item -ItemType Directory -Path $Root | Out-Null
  $Results = @()
  foreach ($Shape in @("missing-validation", "null-validation", "null-active-backend")) {
    $CaseRoot = Join-Path $Root $Shape
    $Layout = New-DrillLayout -CaseRoot $CaseRoot -Shape $Shape -SourceManifestPath $CandidateManifestPath
    $Context = Invoke-ReleaseSwitch -Mode Fixture -SwitchServiceRoot $Layout.service -SwitchDataRoot $Layout.data -SwitchBrokerRoot $Layout.broker -SwitchCandidateReleaseId $Layout.candidateReleaseId -SwitchExpectedCurrentReleaseId $Layout.oldReleaseId -SwitchRouteId "route-fixture" -SwitchProbePython $ProbePython -FixtureStatePath $Layout.fixtureStatePath
    $ActivatedManifest = Read-Json (Join-Path $Layout.service "current\service-manifest.json")
    $Rollback = Restore-ReleaseSwitch -Context $Context
    $Results += [pscustomobject]@{
      case = $Shape
      activationGeneration = [int]$ActivatedManifest.validation.activeBackend.generation
      activationToolCount = [int]$ActivatedManifest.validation.activeBackend.toolCount
      activeBackendPresent = ($null -ne $ActivatedManifest.validation.activeBackend)
      rollbackVerified = [bool]$Rollback.verified
      ledger = $Rollback.ledger
    }
  }
  $FailureRoot = Join-Path $Root "forced-health-failure"
  $FailureLayout = New-DrillLayout -CaseRoot $FailureRoot -Shape "missing-validation" -SourceManifestPath $CandidateManifestPath
  $FailureCaught = $false
  try {
    Invoke-ReleaseSwitch -Mode Fixture -SwitchServiceRoot $FailureLayout.service -SwitchDataRoot $FailureLayout.data -SwitchBrokerRoot $FailureLayout.broker -SwitchCandidateReleaseId $FailureLayout.candidateReleaseId -SwitchExpectedCurrentReleaseId $FailureLayout.oldReleaseId -SwitchRouteId "route-fixture" -SwitchProbePython $ProbePython -FixtureStatePath $FailureLayout.fixtureStatePath -FailFixtureHealth | Out-Null
  } catch {
    $FailureCaught = $_.Exception.Message -like "Activation failed after verified rollback:*"
  }
  $FailureRollback = Read-Json (Get-ChildItem -LiteralPath (Join-Path $FailureLayout.data "backups") -Directory | Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName "rollback-verification.json" })
  $FailureCurrent = Get-JunctionTarget (Join-Path $FailureLayout.service "current")
  $FailureVerified = $FailureCaught -and $FailureRollback.verified -eq $true -and (Split-Path -Leaf $FailureCurrent) -eq $FailureLayout.oldReleaseId
  $CandidatePackageReady = $CandidatePackage.checked -eq $true -and $CandidatePackage.insideRelease -eq $true -and $CandidatePackage.toolCount -eq $ExpectedToolCount
  $Summary = [pscustomobject]@{
    status = $(if ($FailureVerified -and $CandidatePackageReady -and @($Results | Where-Object { -not $_.rollbackVerified }).Count -eq 0) { "READY_FOR_ACTIVATION" } else { "DRILL_FAILED" })
    drillRoot = $Root
    candidatePackage = $CandidatePackage
    successfulCases = $Results
    forcedFailure = [pscustomobject]@{ caught = $FailureCaught; rollbackVerified = [bool]$FailureRollback.verified; currentReleaseId = Split-Path -Leaf $FailureCurrent }
    productionTouched = $false
  }
  Write-JsonAtomic -Path (Join-Path $Root "drill-summary.json") -Value $Summary
  return $Summary
}

[CmdletBinding()]
param(
  [ValidateSet('Adopt', 'Restore', 'Status')][string]$Action = 'Status',
  [ValidateSet('Production', 'TempFixture')][string]$Mode = 'Production',
  [Parameter(Mandatory = $true)][string]$OwnerManifestPath,
  [Parameter(Mandatory = $true)][string]$OwnerManifestSha256,
  [string]$OwnerConfirmation = '',
  [switch]$FixtureFailProbe,
  [switch]$FixtureDeferRestore,
  [switch]$FixtureRequireIndependentTerminal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$Utf8 = New-Object Text.UTF8Encoding($false)
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Leases = @(); $Journal = $null; $JournalHandle = $null; $Prepared = $false
$Result = [ordered]@{ schemaVersion = 1; action = $Action; mode = $Mode; status = 'REFUSED'; productionExecuted = $false; paidModelCalls = 0; error = $null }

function Fail([string]$Code) { throw $Code }
function Plain([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '[*?]') { Fail 'EXACT_ABSOLUTE_PATH_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Path)
  $Cursor = $Full
  while ($Cursor) {
    if ([IO.File]::Exists($Cursor) -or [IO.Directory]::Exists($Cursor)) {
      if (([IO.File]::GetAttributes($Cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'REPARSE_PATH_REFUSED' }
    }
    $Parent = [IO.Path]::GetDirectoryName($Cursor)
    if ($Parent -eq $Cursor) { break }; $Cursor = $Parent
  }
  if ([IO.File]::Exists($Full)) {
    foreach ($Stream in @(Get-Item -LiteralPath $Full -Stream * -Force -ErrorAction Stop)) {
      if ($Stream.Stream -notin @(':$DATA', '$DATA')) { Fail 'ADS_REFUSED' }
    }
  }
  return $Full
}
function Sha([string]$Path) { return (Get-FileHash -LiteralPath (Plain $Path) -Algorithm SHA256).Hash.ToLowerInvariant() }
function Pin($Definition) {
  $Path = Plain $Definition.path
  if ($Definition.sha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $Path) -cne $Definition.sha256) { Fail ('INPUT_SHA_DRIFT:' + $Path) }
  return $Path
}
function Within([string]$Root, [string]$Path) { return $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }
function Json([string]$Path) { return [IO.File]::ReadAllText((Plain $Path), $Utf8) | ConvertFrom-Json }
function AssertIndependentTerminal {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -cne 'Desktop' -or (Get-ExecutionPolicy -Scope Process) -ne 'Undefined' -or (Get-ExecutionPolicy) -eq 'Bypass') { Fail 'ORDINARY_WINDOWS_POWERSHELL_REQUIRED' }
  $ProcessId = $PID; $Seen = @{}; $ChildCreated = $null; $Session = $null
  for ($Depth = 0; $Depth -lt 32 -and $ProcessId; $Depth++) {
    if ($Seen.ContainsKey([string]$ProcessId)) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }; $Seen[[string]$ProcessId] = $true
    $Matches = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop)
    if ($Matches.Count -ne 1) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }; $Observed = $Matches[0]
    if (-not $Observed.ExecutablePath -or -not $Observed.CommandLine -or -not $Observed.CreationDate -or $null -eq $Observed.SessionId -or [string]$Observed.CommandLine -match 'app-server|mcp-http-broker|sandbox-data|codex-command-runner|codex-windows-sandbox|WindowsJobRunner' -or [string]$Observed.Name -match '^(ChatGPT|codex|WindowsJobRunner)\.exe$') { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Created = ([DateTime]$Observed.CreationDate).ToUniversalTime()
    if ($ChildCreated -and $Created -gt $ChildCreated) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ($null -eq $Session) { $Session = [int]$Observed.SessionId }; if ([int]$Observed.SessionId -ne $Session) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ([string]$Observed.Name -ieq 'explorer.exe' -and [string]$Observed.ExecutablePath -ieq (Join-Path $env:SystemRoot 'explorer.exe')) { return }
    $ChildCreated = $Created; $ProcessId = [int]$Observed.ParentProcessId
  }
  Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED'
}
function SaveJournal {
  $Bytes = $Utf8.GetBytes(($Journal | ConvertTo-Json -Depth 15)); $JournalHandle.Position = 0
  $JournalHandle.Write($Bytes, 0, $Bytes.Length); $JournalHandle.SetLength($Bytes.Length); $JournalHandle.Flush($true)
}
function Record([string]$Phase, $Evidence) {
  $Journal.phase = $Phase; $Journal.events += [pscustomobject]@{ atUtc = [DateTimeOffset]::UtcNow.ToString('o'); phase = $Phase; evidence = $Evidence }; SaveJournal
}
function FileTransaction([string]$Step) {
  if ($Step -eq 'Prepare') { $Entry = Pin $Spec.filesEntry }
  else { $Entry = Join-Path $Freeze.transactionRoot 'entry.ps1'; if ((Sha $Entry) -cne $Spec.filesEntry.sha256) { Fail 'SAVED_FILE_ENTRY_SHA_DRIFT' } }
  $Parameters = @{ Action = $Step; Mode = $Mode; TransactionRoot = $Freeze.transactionRoot; OwnerId = $Spec.ownerId; TransactionId = $Spec.transactionId }
  if ($Step -eq 'Prepare') { $Parameters.FreezeManifestPath = $FreezePath; $Parameters.FreezeManifestSha256 = $Spec.freezeManifest.sha256; $IdentityHash = $Spec.freezeManifest.sha256 }
  else { $Parameters.PlanSha256 = $Journal.planSha256; $IdentityHash = $Journal.planSha256 }
  $Parameters.OwnerConfirmation = $Spec.ownerId + '|' + $Spec.transactionId + '|' + $Step + '|' + $IdentityHash
  $Output = & $Entry @Parameters
  $Response = ($Output -join "`n") | ConvertFrom-Json
  if ($Step -ne 'Status' -and ($Response.error -or $Response.status -cin @('REFUSED', 'UNKNOWN', 'PARTIAL_APPLY', 'PARTIAL_RESTORE'))) { Fail ('FILE_TRANSACTION_' + $Response.status + ':' + $Response.error) }
  return $Response
}
function Observe($Identity, [switch]$MustLive) {
  if ($Identity.pid -le 0 -or -not $Identity.creationTimeUtc -or -not $Identity.executablePath) { Fail 'PROCESS_IDENTITY_UNKNOWN' }
  $Found = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Identity.pid) -ErrorAction Stop)
  if ($Found.Count -eq 0) { if ($MustLive) { Fail 'EXPECTED_PROCESS_MISSING' }; return $null }
  if ($Found.Count -ne 1 -or -not $Found[0].CreationDate -or -not $Found[0].ExecutablePath -or ([DateTime]$Found[0].CreationDate).ToUniversalTime().Ticks -ne [DateTimeOffset]::Parse($Identity.creationTimeUtc).UtcDateTime.Ticks -or [string]$Found[0].ExecutablePath -ine $Identity.executablePath) { Fail 'PID_REUSED_OR_IDENTITY_DRIFT' }
  return $Found[0]
}
function Tool([string]$Name, $Parameters, [string]$ExpectedSha) {
  $Definition = $Spec.tools.$Name; $Path = if ($Name -ceq 'stopOuter') { Join-Path $SupportRoot 'stop-codex-app-server-proxy.ps1' } else { Plain $Definition.path }
  if ((Sha $Path) -cne $ExpectedSha) { Fail ('TOOL_SHA_DRIFT:' + $Name) }
  $Output = & $Path @Parameters
  return (($Output -join "`n") | ConvertFrom-Json)
}
function StopNormal($MarkerState) {
  $Stopped = Tool 'stopOuter' @{ DataRoot = $Freeze.dataRoot; TimeoutSeconds = 20; ChildTimeoutSeconds = 60; StopMarkerProofPath = $MarkerState.proofPath; StopMarkerAttemptId = $MarkerState.attempt; StopMarkerOperationId = $MarkerState.operation } $Spec.tools.stopOuter.sha256
  if ($Stopped.stopped -ne $true -or $Stopped.clean -ne $true -or $Stopped.forced -ne $false -or $Stopped.childForced -ne $false) { Fail 'NORMAL_STOP_NOT_CLEAN' }
  Record 'NORMAL_STOP_PASSED' $Stopped
}
function Marker([string]$Component, [string]$Name) {
  $Path = Plain (Join-Path $Freeze.dataRoot ('state/' + $Name)); $Attempt = $Spec.transactionId + '-' + [guid]::NewGuid().ToString('N')
  $Lease = New-OwnedStopMarker -Path $Path -Component $Component -AttemptId $Attempt -LifetimeSeconds 600
  $Evidence = Assert-OwnedStopMarker -Lease $Lease -Path $Path -Component $Component -AttemptId $Attempt
  $ProofPath = Join-Path $Freeze.transactionRoot ($Attempt + '.proof.json')
  [IO.File]::WriteAllText($ProofPath, (Export-OwnedStopMarkerProof -Lease $Lease -Path $Path -Component $Component -AttemptId $Attempt), $Utf8)
  $State = [pscustomobject]@{ lease = $Lease; path = $Path; component = $Component; attempt = $Attempt; operation = $Evidence.OperationId; proofPath = $ProofPath }
  $script:Leases += $State; return $State
}
function Consume($Marker) {
  return Consume-OwnedStopMarker -Lease $Marker.lease -Path $Marker.path -Component $Marker.component -AttemptId $Marker.attempt -OperationId $Marker.operation
}
function StopOld {
  foreach ($Identity in @($Freeze.protectedProcesses)) { $null = Observe $Identity -MustLive }
  $Listeners = BoundListenerIdentities @($Freeze.protectedProcesses)
  Record 'STOP_OLD_INTENT' @{ roots = $Freeze.protectedProcesses; listeners = $Listeners }
  $Outer = Marker 'proxy' 'codex-app-server-proxy.stop'; $Inner = Marker 'inner' 'codex-model-stream-proxy.stop'
  $null = Assert-OwnedStopMarkerProof -ProofJson ([IO.File]::ReadAllText($Outer.proofPath)) -Path $Outer.path -Component $Outer.component -AttemptId $Outer.attempt -OperationId $Outer.operation
  $null = Assert-OwnedStopMarkerProof -ProofJson ([IO.File]::ReadAllText($Inner.proofPath)) -Path $Inner.path -Component $Inner.component -AttemptId $Inner.attempt -OperationId $Inner.operation
  StopNormal $Outer
  $Deadline = [DateTime]::UtcNow.AddSeconds(60)
  do { $Alive = @(@($Freeze.protectedProcesses) + @($Listeners) | Where-Object { $null -ne (Observe $_) }); if ($Alive.Count -eq 0) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $Deadline)
  if ($Alive.Count) { Fail 'OLD_PROTECTED_PROCESS_STILL_LIVE' }
  AssertPortsFree
  $Proofs = @((Consume $Inner), (Consume $Outer)); Record 'OLD_STOPPED_MARKERS_CONSUMED' $Proofs
}
function BoundListenerIdentities($Roots) {
  $Identities = @{}; $RootIds = @($Roots | ForEach-Object { [int]$_.pid })
  $Connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @($Journal.ports) })
  foreach ($Connection in $Connections) {
    $ProcessId = [int]$Connection.OwningProcess; if ($Identities.ContainsKey([string]$ProcessId)) { continue }
    $Observed = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop)
    if ($Observed.Count -ne 1 -or -not $Observed[0].CreationDate -or -not $Observed[0].ExecutablePath -or -not $Observed[0].CommandLine) { Fail 'BOUND_LISTENER_IDENTITY_UNKNOWN' }
    $First = $Observed[0]; $Seen = @{}; $Related = $false; $ChildCreated = $null
    for ($Depth = 0; $Depth -lt 8; $Depth++) {
      if ($Seen.ContainsKey([string]$ProcessId)) { Fail 'BOUND_LISTENER_PARENT_UNKNOWN' }; $Seen[[string]$ProcessId] = $true
      if ($ProcessId -in $RootIds) { $Root = @($Roots | Where-Object { $_.pid -eq $ProcessId })[0]; $null = Observe $Root -MustLive; $Related = $true; break }
      $Parent = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop)
      if ($Parent.Count -ne 1 -or -not $Parent[0].CreationDate -or $Parent[0].ParentProcessId -le 0) { Fail 'BOUND_LISTENER_PARENT_UNKNOWN' }
      $Created = ([DateTime]$Parent[0].CreationDate).ToUniversalTime(); if ($ChildCreated -and $Created -gt $ChildCreated) { Fail 'BOUND_LISTENER_PARENT_REUSED' }
      $ChildCreated = $Created; $ProcessId = [int]$Parent[0].ParentProcessId
    }
    if (-not $Related) { Fail 'BOUND_PORT_FOREIGN_OWNER' }
    $Identities[[string]$First.ProcessId] = [pscustomobject]@{ pid = [int]$First.ProcessId; creationTimeUtc = ([DateTime]$First.CreationDate).ToUniversalTime().ToString('o'); executablePath = [string]$First.ExecutablePath; port = [int]$Connection.LocalPort }
  }
  return @($Identities.Values)
}
function AssertPortsFree {
  $Listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in @($Journal.ports) })
  if ($Listeners.Count) { Fail 'BOUND_SERVICE_PORT_STILL_LISTENING' }
  Record 'BOUND_PORTS_RELEASED' $Journal.ports
}
function StartNormal([switch]$Old) {
  foreach ($Name in @('codex-app-server-proxy.stop', 'codex-model-stream-proxy.stop')) { if (Test-Path -LiteralPath (Join-Path $Freeze.dataRoot ('state/' + $Name))) { Fail 'STOP_REQUIREMENT_PRESERVED' } }
  if ($Old) {
    $InnerParameters = @{}; foreach ($Property in $Spec.oldInnerParameters.PSObject.Properties) { $InnerParameters[$Property.Name] = $Property.Value }; $InnerParameters.DataRoot = $Freeze.dataRoot
    Record 'START_OLD_INNER_INTENT' $InnerParameters
    $InnerStarted = Tool 'startInner' $InnerParameters $Journal.originalTools.startInner
    if ($InnerStarted.running -ne $true -or $InnerStarted.changed -ne $true) { Fail 'OLD_INNER_START_FAILED_OR_FOREIGN_INSTANCE' }
    Record 'OLD_INNER_RESTORED' $InnerStarted
    $Parameters = @{}; foreach ($Property in $Spec.oldOuterParameters.PSObject.Properties) { $Parameters[$Property.Name] = $Property.Value }; $Name = 'startOuter'; $Hash = $Journal.originalTools.startOuter
  }
  else {
    $Profile = Json (Join-Path $Freeze.dataRoot 'state/inner-managed/inner-managed-profile.json')
    $Parameters = @{ DownstreamPort = [int]$Profile.ports.downstream; ControlPort = [int]$Profile.ports.control; UpstreamPort = [int]$Profile.ports.upstream; ProbePort = [int]$Profile.ports.probe; RequireNoStopMarker = $true; ExpectedInstanceToken = $Journal.newInstanceToken; LaunchReceiptPath = $Journal.launchReceiptPath }; $Name = 'startOuter'; $Hash = $Spec.tools.startOuter.sha256
  }
  $Parameters.DataRoot = $Freeze.dataRoot; $Parameters.CodexExecutablePath = Pin $Spec.codexExecutable
  Record $(if ($Old) { 'START_OLD_INTENT' } else { 'START_MANAGED_INTENT' }) $Parameters
  $Started = Tool $Name $Parameters $Hash
  if ($Started.started -ne $true -or $Started.state -cne 'running') { Fail 'NORMAL_START_DID_NOT_CREATE_INSTANCE' }
  if ($Old) {
    Probe -Old
    Record 'OLD_SERVICES_RESTORED' @{ outer = $Started; inner = $InnerStarted }
  } else {
    $Runtime = Json (Join-Path $Freeze.dataRoot 'state/codex-app-server-proxy-runtime.json')
    $Observed = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Runtime.pid) -ErrorAction Stop)
    if ($Runtime.instanceToken -cne $Journal.newInstanceToken -or [int]$Started.pid -ne [int]$Runtime.pid -or $Observed.Count -ne 1 -or -not $Observed[0].CreationDate -or -not $Observed[0].ExecutablePath -or -not $Observed[0].CommandLine -or ([string]$Observed[0].CommandLine).IndexOf($Journal.newInstanceToken, [StringComparison]::Ordinal) -lt 0) { Fail 'NEW_LAUNCH_IDENTITY_UNKNOWN' }
    $Journal.newIdentity = [pscustomobject]@{ pid = [int]$Runtime.pid; creationTimeUtc = ([DateTime]$Observed[0].CreationDate).ToUniversalTime().ToString('o'); executablePath = [string]$Observed[0].ExecutablePath }
    Record 'MANAGED_STARTED' $Started
  }
}
function StopNew {
  $RuntimePath = Join-Path $Freeze.dataRoot 'state/codex-app-server-proxy-runtime.json'; $Runtime = Json $RuntimePath
  if ($Runtime.instanceToken -cne $Journal.newInstanceToken -or $Runtime.pid -le 0) { Fail 'NEW_INSTANCE_OWNERSHIP_UNKNOWN' }
  if (-not $Journal.newIdentity) { Fail 'NEW_LAUNCH_NOT_ACCEPTED_PRESERVE_UNKNOWN' }
  $Identity = $Journal.newIdentity; $Observed = Observe $Identity -MustLive
  if ([int]$Runtime.pid -ne [int]$Identity.pid -or -not $Observed.CommandLine -or ([string]$Observed.CommandLine).IndexOf($Journal.newInstanceToken, [StringComparison]::Ordinal) -lt 0) { Fail 'NEW_INSTANCE_PROCESS_IDENTITY_UNKNOWN' }
  $Listeners = BoundListenerIdentities @($Identity)
  Record 'STOP_NEW_INTENT' @{ root = $Identity; listeners = $Listeners }; $null = Observe $Identity -MustLive
  $Outer = Marker 'proxy' 'codex-app-server-proxy.stop'
  $null = Assert-OwnedStopMarkerProof -ProofJson ([IO.File]::ReadAllText($Outer.proofPath)) -Path $Outer.path -Component $Outer.component -AttemptId $Outer.attempt -OperationId $Outer.operation
  StopNormal $Outer
  $Deadline = [DateTime]::UtcNow.AddSeconds(60)
  do { $Alive = @(@($Identity) + @($Listeners) | Where-Object { $null -ne (Observe $_) }); if ($Alive.Count -eq 0) { break }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $Deadline)
  if ($Alive.Count) { Fail 'NEW_INSTANCE_DID_NOT_STOP_CLEANLY' }
  AssertPortsFree
  Record 'NEW_STOPPED_MARKER_CONSUMED' (Consume $Outer)
}
function Probe([switch]$Old) {
  if ($FixtureFailProbe -and -not $Old) { Fail 'FIXTURE_CANDIDATE_PROBE_FAILURE' }
  $Port = if ($Old) { [int]$Spec.oldOuterParameters.DownstreamPort } else { $Profile = Json (Join-Path $Freeze.dataRoot 'state/inner-managed/inner-managed-profile.json'); [int]$Profile.ports.downstream }
  $Socket = New-Object Net.WebSockets.ClientWebSocket; $Cancellation = New-Object Threading.CancellationTokenSource
  $Cancellation.CancelAfter(15000)
  try {
    $null = $Socket.ConnectAsync([Uri]('ws://127.0.0.1:' + $Port), $Cancellation.Token).GetAwaiter().GetResult()
    $Answers = @{}
    foreach ($Request in @(@{ id = 1; method = 'initialize'; params = @{ clientInfo = @{ name = 'inner_first_adoption_owner'; version = '1.0.0' }; capabilities = @{ experimentalApi = $true } } }, @{ method = 'initialized'; params = @{} }, @{ id = 2; method = 'thread/list'; params = @{ limit = 1 } })) {
      $Bytes = $Utf8.GetBytes(($Request | ConvertTo-Json -Depth 8 -Compress)); $null = $Socket.SendAsync([ArraySegment[byte]]::new($Bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $Cancellation.Token).GetAwaiter().GetResult()
      if (-not $Request.ContainsKey('id')) { continue }
      do {
        $Message = New-Object IO.MemoryStream
        try {
          do { $Buffer = New-Object byte[] 8192; $Part = $Socket.ReceiveAsync([ArraySegment[byte]]::new($Buffer), $Cancellation.Token).GetAwaiter().GetResult(); if ($Part.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text) { Fail 'PROBE_NON_TEXT_OR_CLOSED' }; $Message.Write($Buffer, 0, $Part.Count); if ($Message.Length -gt 1048576) { Fail 'PROBE_RESPONSE_TOO_LARGE' } } while (-not $Part.EndOfMessage)
          $Answer = $Utf8.GetString($Message.ToArray()) | ConvertFrom-Json
        } finally { $Message.Dispose() }
      } while (-not $Answer.PSObject.Properties['id'] -or $Answer.id -ne $Request.id)
      if ($Answer.PSObject.Properties['error'] -or -not $Answer.PSObject.Properties['result']) { Fail 'PROBE_RPC_FAILED' }; $Answers[[string]$Request.id] = $Answer.result
    }
    if (-not $Answers['1'].userAgent -or -not $Answers['2'].PSObject.Properties['data']) { Fail 'PROBE_RESULT_SHAPE_REQUIRED' }
    Record $(if ($Old) { 'OLD_INITIALIZE_THREAD_LIST_PASSED' } else { 'INITIALIZE_THREAD_LIST_PASSED' }) $Answers
  } finally { $Socket.Abort(); $Socket.Dispose(); $Cancellation.Dispose() }
}

try {
  if ($Mode -eq 'Production' -or $FixtureRequireIndependentTerminal) { AssertIndependentTerminal }
  if ($Mode -eq 'Production' -and ($FixtureFailProbe -or $FixtureDeferRestore -or $FixtureRequireIndependentTerminal)) { Fail 'PRODUCTION_FAULT_INJECTION_FORBIDDEN' }
  if ($FixtureDeferRestore -and -not $FixtureFailProbe) { Fail 'FIXTURE_DEFER_REQUIRES_PROBE_FAILURE' }
  if ($OwnerManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $OwnerManifestPath) -cne $OwnerManifestSha256) { Fail 'OWNER_MANIFEST_SHA_REQUIRED' }
  $Spec = Json $OwnerManifestPath
  if ($Spec.schemaVersion -ne 1 -or $Spec.scope -cne 'inner-first-adoption-owner-v1' -or $Spec.mode -cne $Mode -or $Spec.operatorSid -cne $Sid -or -not $Spec.ownerId -or -not $Spec.transactionId) { Fail 'OWNER_MANIFEST_IDENTITY_REQUIRED' }
  if ($Action -ne 'Status' -and $OwnerConfirmation -cne ($Spec.ownerId + '|' + $Spec.transactionId + '|' + $Action + '|' + $OwnerManifestSha256)) { Fail 'EXACT_OWNER_CONFIRMATION_REQUIRED' }
  $TransactionRoot = Plain $Spec.transactionRoot
  if ($Action -eq 'Adopt') { $FreezePath = Pin $Spec.freezeManifest; $null = Pin $Spec.filesEntry }
  else { $FreezePath = Join-Path $TransactionRoot 'owner-freeze.json'; if ((Sha $FreezePath) -cne $Spec.freezeManifest.sha256) { Fail 'SAVED_FREEZE_SHA_DRIFT' } }
  $Freeze = Json $FreezePath; $Freeze | Add-Member -NotePropertyName transactionRoot -NotePropertyValue $TransactionRoot
  if ($Freeze.ownerId -cne $Spec.ownerId -or $Freeze.transactionId -cne $Spec.transactionId -or $Freeze.mode -cne $Mode -or $Freeze.operatorSid -cne $Sid) { Fail 'FILE_MANIFEST_OWNER_BINDING_REQUIRED' }
  $DeclaredSupportRoot = Join-Path (Split-Path (Plain $Spec.freezeManifest.path) -Parent) 'owner-support'
  if ((Plain $Spec.normalToolSupport.root) -ine $DeclaredSupportRoot -or @($Spec.normalToolSupport.files).Count -ne 3) { Fail 'EXACT_OWNER_SUPPORT_REQUIRED' }
  $SupportNames = @('owned-stop-marker.ps1', 'stop-codex-app-server-proxy.ps1', 'resolve-napcat-data-root.ps1')
  if (@($Spec.normalToolSupport.files.name | Select-Object -Unique).Count -ne 3) { Fail 'EXACT_OWNER_SUPPORT_REQUIRED' }
  $SupportRoot = if ($Action -eq 'Adopt') { $DeclaredSupportRoot } else { Join-Path $TransactionRoot 'owner-support' }
  foreach ($Definition in @($Spec.normalToolSupport.files)) {
    if ($Definition.name -cnotin $SupportNames) { Fail 'EXACT_OWNER_SUPPORT_REQUIRED' }
    $null = Pin @{ path = (Join-Path $SupportRoot $Definition.name); sha256 = $Definition.sha256 }
  }
  foreach ($Name in @('marker', 'stopOuter')) {
    $FileName = if ($Name -ceq 'marker') { $SupportNames[0] } else { $SupportNames[1] }
    $Definition = @($Spec.normalToolSupport.files | Where-Object { $_.name -ceq $FileName })[0]
    if ((Plain $Spec.tools.$Name.path) -ine (Join-Path $DeclaredSupportRoot $FileName) -or $Spec.tools.$Name.sha256 -cne $Definition.sha256) { Fail 'EXACT_OWNER_SUPPORT_TOOL_REQUIRED' }
  }
  foreach ($Name in @('startOuter', 'startInner')) {
    $FileName = if ($Name -ceq 'startOuter') { 'start-codex-app-server-proxy.ps1' } else { 'start-codex-model-stream-proxy.ps1' }
    if ((Plain $Spec.tools.$Name.path) -ine (Join-Path $Freeze.installedRoot ('ops/' + $FileName))) { Fail 'FIXED_INSTALLED_NORMAL_TOOL_REQUIRED' }
  }
  $MarkerEntry = Join-Path $SupportRoot 'owned-stop-marker.ps1'
  if ($Mode -eq 'Production') { if (@($Spec.desktopProcesses).Count -lt 1) { Fail 'EXACT_DESKTOP_IDENTITIES_REQUIRED' }; if ($Action -eq 'Adopt') { foreach ($Desktop in @($Spec.desktopProcesses)) { $null = Observe $Desktop -MustLive } } }
  foreach ($Name in @('oldOuterParameters', 'oldInnerParameters')) {
    $Allowed = if ($Name -eq 'oldOuterParameters') { @('DownstreamPort','ControlPort','UpstreamPort','ProbePort','ResumeTimeoutMs','StartTimeoutMs','StartupTimeoutSeconds','RequestMetadataEnabled') } else { @('Port','FirstProgressTimeoutSeconds','ProgressIdleTimeoutSeconds','CompactionAttemptTimeoutSeconds','MaxConsecutiveAttempts','MaxBufferedRequestMiB','MaxDecodedRequestMiB','UpstreamOrigin','StartupTimeoutSeconds','MaintenanceToken') }
    foreach ($Property in $Spec.$Name.PSObject.Properties) { if ($Property.Name -cnotin $Allowed) { Fail 'NORMAL_PARAMETER_ALLOWLIST_REQUIRED' } }
  }
  if ($Mode -eq 'TempFixture') {
    $FixtureRoot = Plain $Spec.fixtureRoot
    if (-not (Within ([IO.Path]::GetTempPath()) $FixtureRoot)) { Fail 'OWNED_TEMP_FIXTURE_REQUIRED' }
    $FixtureOwner = Json (Join-Path $FixtureRoot '.inner-first-adoption-owner-fixture.json')
    if ($FixtureOwner.ownerId -cne $Spec.ownerId -or $FixtureOwner.transactionId -cne $Spec.transactionId -or $FixtureOwner.operatorSid -cne $Sid) { Fail 'FIXTURE_OWNER_CONFLICT' }
    foreach ($Path in @($Freeze.dataRoot, $Freeze.installedRoot, $Freeze.candidateRoot, $Freeze.transactionRoot, $MarkerEntry, $Spec.tools.stopOuter.path, $Spec.tools.startOuter.path, $Spec.tools.startInner.path)) { if (-not (Within $FixtureRoot (Plain $Path))) { Fail 'FIXTURE_TARGET_ESCAPE' } }
    if ($Spec.PSObject.Properties['fixtureHome']) { $env:CODEX_HOME = Plain $Spec.fixtureHome; if (-not (Within $FixtureRoot $env:CODEX_HOME)) { Fail 'FIXTURE_HOME_ESCAPE' } }
  }
  . $MarkerEntry
  $JournalPath = Join-Path $Freeze.transactionRoot 'owner-receipt.json'
  if ($Action -eq 'Adopt') {
    foreach ($Name in @('stopOuter','startOuter','startInner')) { $Path = Plain $Spec.tools.$Name.path; if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail 'NORMAL_TOOL_MISSING' } }
    $OriginalTools = @{}
    foreach ($Name in @('startOuter', 'startInner')) { $OriginalTools[$Name] = Sha $Spec.tools.$Name.path; if ($OriginalTools[$Name] -cne $Spec.tools.$Name.originalSha256) { Fail 'ORIGINAL_NORMAL_TOOL_SHA_DRIFT' } }
    $Response = FileTransaction 'Prepare'; $Prepared = $true
    $JournalHandle = [IO.File]::Open($JournalPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $LaunchRoot = Join-Path ([IO.Path]::GetTempPath()) ('inner-first-adoption-owner-launch-' + [guid]::NewGuid().ToString('N')); [IO.Directory]::CreateDirectory($LaunchRoot) | Out-Null
    $Profile = Json (Join-Path $Freeze.candidateRoot 'state/inner-managed/inner-managed-profile.json')
    $Ports = @('control','downstream','upstream','probe','inner' | ForEach-Object { [int]$Profile.ports.$_ })
    if (@($Ports | Select-Object -Unique).Count -ne 5 -or @($Ports | Where-Object { $_ -lt 1 -or $_ -gt 65535 }).Count) { Fail 'EXACT_FIVE_DISTINCT_PROFILE_PORTS_REQUIRED' }
    if ($Spec.oldOuterParameters.ControlPort -ne $Profile.ports.control -or $Spec.oldOuterParameters.DownstreamPort -ne $Profile.ports.downstream -or $Spec.oldOuterParameters.UpstreamPort -ne $Profile.ports.upstream -or $Spec.oldOuterParameters.ProbePort -ne $Profile.ports.probe -or $Spec.oldInnerParameters.Port -ne $Profile.ports.inner) { Fail 'OLD_NEW_PORT_MAPPING_MISMATCH' }
    $Journal = [pscustomobject]@{ ownerManifestSha256 = $OwnerManifestSha256; ownerId = $Spec.ownerId; transactionId = $Spec.transactionId; operatorSid = $Sid; ownerEntrySha256 = (Sha $PSCommandPath); planSha256 = $Response.planSha256; originalTools = $OriginalTools; ports = $Ports; newIdentity = $null; newInstanceToken = [guid]::NewGuid().ToString(); launchReceiptPath = (Join-Path $LaunchRoot 'launch.json'); phase = 'PREPARED'; events = @() }
    SaveJournal; Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $Freeze.transactionRoot 'owner-entry.ps1') -ErrorAction Stop
    Copy-Item -LiteralPath $OwnerManifestPath -Destination (Join-Path $Freeze.transactionRoot 'owner-manifest.json') -ErrorAction Stop
    Copy-Item -LiteralPath $FreezePath -Destination (Join-Path $Freeze.transactionRoot 'owner-freeze.json') -ErrorAction Stop
    $SavedSupport = Join-Path $Freeze.transactionRoot 'owner-support'; [IO.Directory]::CreateDirectory($SavedSupport) | Out-Null
    foreach ($Definition in @($Spec.normalToolSupport.files)) {
      $Source = Pin @{ path = (Join-Path $SupportRoot $Definition.name); sha256 = $Definition.sha256 }
      $Target = Join-Path $SavedSupport $Definition.name; Copy-Item -LiteralPath $Source -Destination $Target -ErrorAction Stop
      $null = Pin @{ path = $Target; sha256 = $Definition.sha256 }
    }
    if ($Mode -eq 'Production') {
      $Prompt = Read-Host 'Exit Codex completely using its application menu, then type CLOSE-CODEX'; if ($Prompt -cne 'CLOSE-CODEX') { Fail 'MANUAL_NORMAL_CLOSE_CONFIRMATION_REQUIRED' }
      foreach ($Desktop in @($Spec.desktopProcesses)) { if ($null -ne (Observe $Desktop)) { Fail 'DESKTOP_STILL_RUNNING' } }
    }
    StopOld; Record 'APPLY_INTENT' $null; Record 'APPLIED' (FileTransaction 'Apply')
    StartNormal; Probe; Record 'READY_FOR_MANUAL_DESKTOP_OPEN' $null; $Result.status = 'READY_FOR_MANUAL_DESKTOP_OPEN'
  } else {
    $Journal = Json $JournalPath
    if ($Journal.ownerManifestSha256 -cne $OwnerManifestSha256 -or $Journal.ownerId -cne $Spec.ownerId -or $Journal.transactionId -cne $Spec.transactionId -or $Journal.operatorSid -cne $Sid -or $Journal.ownerEntrySha256 -cne (Sha $PSCommandPath)) { Fail 'OWNER_RECEIPT_IDENTITY_DRIFT' }
    if ($Action -eq 'Status') { $Result.status = $Journal.phase }
    else {
      $JournalHandle = [IO.File]::Open($JournalPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      if ($Journal.phase -ceq 'OLD_SERVICES_RESTORED') { $Result.status = 'OLD_SERVICES_RESTORED'; $Result['alreadyConsumed'] = $true }
      elseif ($Journal.phase -cin @('APPLIED','MANAGED_STARTED','INITIALIZE_THREAD_LIST_PASSED','READY_FOR_MANUAL_DESKTOP_OPEN','OLD_STOPPED_MARKERS_CONSUMED','APPLY_INTENT')) {
        $FileStatus = FileTransaction 'Status'; if ($FileStatus.status -cin @('UNKNOWN','REFUSED')) { Fail 'FILE_TRANSACTION_UNKNOWN_NO_REPLAY' }
        if ($Journal.newIdentity) { StopNew }; Record 'FILES_RESTORED' (FileTransaction 'Restore'); StartNormal -Old; $Result.status = 'OLD_SERVICES_RESTORED'
      } else { Fail 'OWNER_STATE_UNKNOWN_NO_REPLAY' }
    }
  }
  $Result.productionExecuted = ($Mode -eq 'Production' -and $Action -ne 'Status')
} catch {
  $Result.error = $_.Exception.Message
  if ($FixtureDeferRestore -and $Result.error -ceq 'FIXTURE_CANDIDATE_PROBE_FAILURE') { $Result.status = 'FAILED_CANDIDATE_INDEPENDENT_RESTORE_REQUIRED' }
  elseif ($Journal -and $JournalHandle -and $Action -eq 'Adopt' -and $Journal.phase -cin @('APPLY_INTENT','APPLIED','MANAGED_STARTED','INITIALIZE_THREAD_LIST_PASSED','START_MANAGED_INTENT')) {
    try { $FileStatus = FileTransaction 'Status'; if ($FileStatus.status -cin @('UNKNOWN','REFUSED')) { Fail 'FILE_TRANSACTION_UNKNOWN_NO_REPLAY' }; if ($Journal.newIdentity) { StopNew } elseif ($Journal.phase -ceq 'START_MANAGED_INTENT') { Fail 'NEW_LAUNCH_NOT_ACCEPTED_PRESERVE_UNKNOWN' }; Record 'FILES_RESTORED' (FileTransaction 'Restore'); StartNormal -Old; $Result.status = 'FAILED_CANDIDATE_OLD_SERVICES_RESTORED' }
    catch { $Result.status = 'UNKNOWN_PRESERVED'; $Result['recoveryError'] = $_.Exception.Message }
  } elseif ($Journal) { $Result.status = 'UNKNOWN_PRESERVED' }
} finally {
  foreach ($MarkerState in $Leases) { if ($MarkerState.lease.State -eq 'Held') { try { $null = Close-OwnedStopMarker -Lease $MarkerState.lease } catch { $Result['markerCleanupError'] = $_.Exception.Message } } }
  if ($JournalHandle) { $JournalHandle.Dispose() }
}
$Result['finishedAtUtc'] = [DateTimeOffset]::UtcNow.ToString('o'); $Result['receiptPath'] = if ($Prepared -or $Journal) { $JournalPath } else { $null }
$Result | ConvertTo-Json -Depth 8
if ($Result.error) { exit 1 }

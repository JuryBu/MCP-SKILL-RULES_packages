Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "Absolute path required: $Path" }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-Within([string]$Path, [string]$Root) {
  $fullPath = Get-FullPath $Path
  $fullRoot = Get-FullPath $Root
  return $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparse([string]$Path) {
  $current = Get-FullPath $Path
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Reparse point rejected: $current"
      }
    }
    $parent = Split-Path -Parent $current
    if ($parent -eq $current) { break }
    $current = $parent
  }
}

function Resolve-Child([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative)) { throw 'Relative file path required' }
  foreach ($segment in ($Relative -split '[/\\]')) {
    if (-not $segment -or $segment -in @('.', '..') -or $segment -match '[<>:"|?*\x00-\x1f]' -or $segment -match '[. ]$' -or $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
      throw "Invalid path segment: $Relative"
    }
  }
  $resolved = Get-FullPath (Join-Path $Root $Relative)
  if (-not (Test-Within $resolved $Root)) { throw "Path escapes root: $Relative" }
  Assert-NoReparse $resolved
  return $resolved
}

function Get-BytesHash([byte[]]$Bytes) {
  $provider = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($provider.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $provider.Dispose() }
}

function Get-Digest([string]$Path) {
  Assert-NoReparse $Path
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Not a regular file: $Path" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-FrozenJson([string]$Path, [string]$ExpectedHash) {
  if ($ExpectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Expected SHA256 must be an explicit 64 digit hex value' }
  Assert-NoReparse $Path
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ((Get-BytesHash $bytes) -ne $ExpectedHash) { throw "SHA256 mismatch: $Path" }
  $json = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff)
  if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return ($json | ConvertFrom-Json -DateKind String) }
  return ($json | ConvertFrom-Json)
}

function Get-FileSetUtcTicks($Value) {
  if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime.Ticks }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { throw 'Timestamp must include a time zone' }
    return $Value.ToUniversalTime().Ticks
  }
  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T.*(?:[zZ]|[+-]\d{2}:\d{2})$') { throw 'Timestamp must include a time zone' }
  $stamp = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$stamp)) { throw 'Invalid timestamp' }
  return $stamp.UtcDateTime.Ticks
}

function Write-JsonFile([string]$Path, $Value) {
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 16), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Get-FileSetProcessIdentity([int]$ProcessId) {
  if ($ProcessId -le 0) { throw 'Invalid observed process ID' }
  try { $observed = Get-Process -Id $ProcessId -ErrorAction Stop }
  catch {
    if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
    throw 'Fresh process observation failed'
  }
  try { return [pscustomobject]@{processId=$observed.Id;createdAtUtc=$observed.StartTime.ToUniversalTime().ToString('o');executablePath=$observed.MainModule.FileName} }
  finally { $observed.Dispose() }
}

function Assert-Gate([string]$Mode, [string]$ShadowRoot, [string[]]$Roots, [string]$ManifestHash, [string]$GatePath, [string]$GateHash, [switch]$ForRestore) {
  if ($Mode -eq 'Shadow') {
    $temporaryRoot = Get-FullPath ([IO.Path]::GetTempPath())
    if (-not (Test-Within $ShadowRoot $temporaryRoot)) { throw 'ShadowRoot must be a dedicated directory under system TEMP' }
    Assert-NoReparse $ShadowRoot
    foreach ($root in $Roots) {
      if (-not (Test-Within $root $ShadowRoot)) { throw "Shadow target outside ShadowRoot: $root" }
    }
    return
  }
  if (-not $GatePath -or -not $GateHash) { throw 'LiveFiles requires a separately verified maintenance gate receipt and its SHA256' }
  $gate = Read-FrozenJson $GatePath $GateHash
  if ($gate.schemaVersion -ne 1 -or $gate.manifestSha256 -ne $ManifestHash -or $gate.writerQuiescenceVerified -ne $true -or $gate.protectedProcessesVerified -ne $true) {
    throw 'Maintenance gate has not verified writer quiescence and protected processes for this manifest'
  }
  $expiry = Get-FileSetUtcTicks $gate.expiresAtUtc
  if ((-not $ForRestore -and $expiry -le [DateTimeOffset]::UtcNow.UtcDateTime.Ticks) -or $expiry -gt [DateTimeOffset]::UtcNow.AddMinutes(10).UtcDateTime.Ticks) { throw 'Maintenance gate expired or exceeds ten minutes' }
  if ([string]::IsNullOrWhiteSpace([string]$gate.ownerId)) { throw 'Maintenance gate owner required' }
  $markerPath = Get-FullPath ([string]$gate.ownMarkerPath)
  $marker = Read-FrozenJson $markerPath ([string]$gate.ownMarkerSha256)
  if ($marker.ownerId -cne $gate.ownerId -or $marker.manifestSha256 -ne $ManifestHash) { throw 'Maintenance marker owner or manifest mismatch' }
  if ($null -ne (Get-FileSetProcessIdentity ([int]$gate.supervisor.processId))) { throw 'Supervisor has not exited' }
  $runtimePath = Get-FullPath ([string]$gate.supervisor.runtimeStatePath)
  Assert-NoReparse $runtimePath
  $runtime = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($runtime.schemaVersion -ne 1 -or [int]$runtime.pid -le 0 -or [string]::IsNullOrWhiteSpace([string]$runtime.state)) { throw 'Invalid supervisor runtime state' }
  if ($null -ne (Get-FileSetProcessIdentity ([int]$runtime.pid))) { throw 'Current runtime supervisor has not exited' }
  $lockPath = Get-FullPath ([string]$gate.supervisor.lockPath)
  Assert-NoReparse $lockPath
  if (Test-Path -LiteralPath $lockPath) {
    try {
      $lockProbe = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    } catch { throw 'Supervisor lock is not released' }
    try {
      $lockReader = New-Object IO.StreamReader($lockProbe, [Text.Encoding]::UTF8)
      $lockState = $lockReader.ReadToEnd() | ConvertFrom-Json
      if ([int]$lockState.pid -le 0 -or [string]::IsNullOrWhiteSpace([string]$lockState.token) -or [string]::IsNullOrWhiteSpace([string]$lockState.startedAt)) { throw 'Invalid supervisor lock metadata' }
      if ($null -ne (Get-FileSetProcessIdentity ([int]$lockState.pid))) { throw 'Supervisor lock owner has not exited' }
    } finally { $lockProbe.Dispose() }
  }
  if (@($gate.protectedProcesses).Count -eq 0) { throw 'Protected process identities required' }
  $protectedIds = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($expected in @($gate.protectedProcesses)) {
    if (-not $protectedIds.Add([int]$expected.processId)) { throw 'Duplicate protected process ID' }
    $current = Get-FileSetProcessIdentity ([int]$expected.processId)
    if ($null -eq $current -or
      (Get-FileSetUtcTicks $current.createdAtUtc) -ne (Get-FileSetUtcTicks $expected.createdAtUtc) -or
      (Get-FullPath $current.executablePath) -ine (Get-FullPath $expected.executablePath)) { throw 'Protected process identity changed' }
  }
}

function Get-RootMutex([string[]]$Roots) {
  return New-Object Threading.Mutex($false, 'Global\NapCatFrozenFileSet-v1')
}

function Enter-RootMutex($Mutex) {
  try { return $Mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { return $true }
}

function Set-AtomicFile([string]$Source, [string]$Destination, [string]$ExpectedHash) {
  Assert-NoReparse $Destination
  $temporary = Join-Path (Split-Path -Parent $Destination) ('.napcat-fileset-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::Copy($Source, $temporary, $false)
    if ((Get-Digest $temporary) -ne $ExpectedHash) { throw "Staged hash mismatch: $Destination" }
    if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($temporary, $Destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $Destination) }
    if ((Get-Digest $Destination) -ne $ExpectedHash) { throw "Written hash mismatch: $Destination" }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

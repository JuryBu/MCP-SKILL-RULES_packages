function Get-NapCatOwnershipSnapshot {
  $Records = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,ExecutablePath)
  foreach ($Record in $Records) {
    if ($Record.CreationDate -is [DateTime]) { $Record.CreationDate = $Record.CreationDate.ToUniversalTime().ToString('o') }
    if ([string]$Record.Name -notmatch '^(qq|qqnt|qqex)(\.exe)?$') { continue }
    $State = 'unknown'
    $Modules = @()
    $Handle = $null
    try {
      $Handle = Get-Process -Id $Record.ProcessId -ErrorAction Stop
      $Before = $Handle.StartTime.ToUniversalTime()
      if (-not (Test-NapCatCreationTime $Before ([string]$Record.CreationDate))) { throw 'Process identity changed' }
      $ProcessModules = $Handle.Modules
      if ($null -eq $ProcessModules) { throw 'Module inventory unavailable' }
      $Modules = @(foreach ($Module in $ProcessModules) {
        if ($null -eq $Module -or [string]::IsNullOrWhiteSpace([string]$Module.FileName)) { throw 'Incomplete module inventory' }
        [string]$Module.FileName
      })
      if ($Modules.Count -eq 0) { throw 'Empty module inventory' }
      $Handle.Refresh()
      if ($Handle.HasExited -or $Handle.StartTime.ToUniversalTime() -ne $Before) { throw 'Process identity changed' }
      $State = 'ok'
    } catch { $State = 'unknown' }
    finally { if ($null -ne $Handle) { $Handle.Dispose() } }
    $Record | Add-Member -NotePropertyName ModulePaths -NotePropertyValue $Modules
    $Record | Add-Member -NotePropertyName ModuleScanState -NotePropertyValue $State
  }
  return $Records
}

function Test-NapCatCreationTime {
  param([DateTime]$StartTime, $CreationDate)
  try {
    $Observed = Get-NapCatIdentityBirth ([pscustomobject]@{ CreationDate = $CreationDate })
    $Expected = Get-NapCatIdentityBirth ([pscustomobject]@{ CreationDate = $StartTime.ToUniversalTime() })
    return -not [double]::IsNaN($Observed) -and $Observed -eq $Expected
  } catch { return $false }
}

function Stop-NapCatVerifiedProcesses {
  param([object[]]$Processes, [string]$NapCatRoot)
  $Fresh = Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $NapCatRoot
  if ($Fresh.unknown.Count -gt 0) { throw '[NAPCAT_PROCESS_SCAN_UNKNOWN] Preserve processes with unknown ownership' }
  $ByPid = @{}
  foreach ($Record in $Fresh.owned) { $ByPid[[int]$Record.ProcessId] = $Record }
  $ExpectedIds = @($Processes | ForEach-Object { [int]$_.ProcessId })
  foreach ($Record in $Fresh.owned) {
    if ([int]$Record.ProcessId -notin $ExpectedIds) { throw '[NAPCAT_PROCESS_IDENTITY_CHANGED] New owned process appeared; obtain a new snapshot' }
  }
  $Handles = @()
  $Stopped = @()
  try {
    foreach ($Expected in $Processes) {
      $Current = $ByPid[[int]$Expected.ProcessId]
      if ($null -eq $Current) { throw '[NAPCAT_PROCESS_IDENTITY_CHANGED] Ownership changed' }
      foreach ($Property in @('ProcessId','ParentProcessId','Name','CommandLine','ExecutablePath')) {
        if ([string]$Current.$Property -cne [string]$Expected.$Property) { throw '[NAPCAT_PROCESS_IDENTITY_CHANGED] Snapshot identity changed' }
      }
      $CurrentBirth = Get-NapCatIdentityBirth $Current
      $ExpectedBirth = Get-NapCatIdentityBirth $Expected
      if ([double]::IsNaN($ExpectedBirth) -or $CurrentBirth -ne $ExpectedBirth) { throw '[NAPCAT_PROCESS_IDENTITY_CHANGED] Snapshot creation time changed' }
      if ([string]::IsNullOrWhiteSpace([string]$Current.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$Current.CreationDate)) { throw '[NAPCAT_PROCESS_SCAN_UNKNOWN] Missing stop identity' }
      $Process = [Diagnostics.Process]::GetProcessById([int]$Current.ProcessId)
      try {
        $Handle = $Process.SafeHandle
        if ($Handle.IsInvalid -or $Handle.IsClosed -or $Process.HasExited -or -not (Test-NapCatCreationTime $Process.StartTime ([string]$Current.CreationDate))) { throw '[NAPCAT_PROCESS_IDENTITY_CHANGED] Stop handle identity changed' }
        $Handles += [pscustomobject]@{ process=$Process; handle=$Handle; started=$Process.StartTime; processId=[int]$Current.ProcessId }
      } catch { $Process.Dispose(); throw }
    }
    foreach ($Record in $Handles) {
      if ($Record.process.HasExited) { continue }
      if ($Record.handle.IsInvalid -or $Record.handle.IsClosed -or -not [object]::ReferenceEquals($Record.handle,$Record.process.SafeHandle) -or $Record.process.StartTime -ne $Record.started) { throw '[NAPCAT_PROCESS_IDENTITY_CHANGED] Retained handle changed' }
      $Record.process.Kill()
      if (-not $Record.process.WaitForExit(3000)) { throw '[NAPCAT_PROCESS_CLEANUP_UNVERIFIED] Process has not exited' }
      $Stopped += $Record.processId
    }
    $Remaining = Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $NapCatRoot
    if ($Remaining.owned.Count -gt 0 -or $Remaining.unknown.Count -gt 0) { throw '[NAPCAT_PROCESS_CLEANUP_UNVERIFIED] Owned or unknown processes remain after stop' }
    return [pscustomobject]@{ stopped=$true; rootProcessIds=@($Stopped) }
  } finally {
    foreach ($Record in $Handles) { $Record.process.Dispose() }
  }
}

function ConvertTo-NapCatIdentityPath {
  param([string]$Value)
  return $Value.Trim().Replace('\', '/').TrimEnd('/').ToLowerInvariant()
}

function Test-NapCatIdentityPath {
  param([string]$Command, [string]$Target)
  $Needle = ConvertTo-NapCatIdentityPath $Target
  if (-not $Needle) { return $false }
  return $Command -match ('(?:^|["''\s=])' + [regex]::Escape($Needle) + '(?=$|["''\s<>])')
}

function ConvertTo-NapCatCanonicalPath {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  if (($Value -replace '^[a-zA-Z]:', '') -match '["<>|?*:\x00-\x1f]') { return '' }
  try { return ConvertTo-NapCatIdentityPath ([IO.Path]::GetFullPath($Value)) }
  catch { return '' }
}

function Get-NapCatCommandEntry {
  param([string]$Command)
  if ($Command -match '^(?:"([^"]+)"|(\S+))(?:\s+(.*))?$') {
    return [pscustomobject]@{ executable = $(if ($Matches[1]) { $Matches[1] } else { $Matches[2] }); arguments = [string]$Matches[3] }
  }
  return [pscustomobject]@{ executable = ''; arguments = '' }
}

function Get-NapCatIdentityBirth {
  param($Record)
  $DateValue = $Record.CreationDate
  if ($DateValue -is [DateTime]) {
    if ($DateValue.Kind -eq [DateTimeKind]::Unspecified) { return [double]::NaN }
    $Value = $DateValue.ToUniversalTime().ToString('o')
  } elseif ($DateValue -is [DateTimeOffset]) {
    $Value = $DateValue.ToUniversalTime().ToString('o')
  } else { $Value = [string]$DateValue }
  if ($Value -match '^/Date\((\d+)(?:[+-]\d+)?\)/$') { return [long]$Matches[1] * 1000 }
  if ($Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') { return [double]::NaN }
  try {
    $Ticks = [DateTimeOffset]::Parse($Value).UtcDateTime.Ticks - [DateTime]::Parse('1970-01-01T00:00:00Z').ToUniversalTime().Ticks
    $Remainder = [long]0
    return [Math]::DivRem([long]$Ticks, [long]10, [ref]$Remainder)
  } catch { return [double]::NaN }
}

function Test-NapCatIdentityLink {
  param($Record, $Parent)
  if ($null -eq $Parent -or $Record.ProcessId -eq $Parent.ProcessId) { return $false }
  $ChildBirth = Get-NapCatIdentityBirth $Record
  $ParentBirth = Get-NapCatIdentityBirth $Parent
  return (-not [double]::IsNaN($ChildBirth)) -and (-not [double]::IsNaN($ParentBirth)) -and $ParentBirth -le $ChildBirth
}

function Get-NapCatProcessClassification {
  param([object[]]$Processes, [string]$NapCatRoot)
  $Root = ConvertTo-NapCatCanonicalPath $NapCatRoot
  if (-not [string]::IsNullOrWhiteSpace($NapCatRoot) -and -not $Root) { throw '[NAPCAT_PROCESS_SCAN_UNKNOWN] Invalid NapCat root' }
  $Owned = @{}
  $Ordinary = @{}
  $Uncertain = @{}
  $ByPid = @{}
  foreach ($Record in $Processes) {
    if ([string]::IsNullOrWhiteSpace([string]$Record.Name)) { throw '[NAPCAT_PROCESS_SCAN_UNKNOWN] Missing process names' }
    $ByPid[[int]$Record.ProcessId] = $Record
  }
  foreach ($Record in $Processes) {
    $Name = [string]$Record.Name
    $Command = ConvertTo-NapCatIdentityPath ([string]$Record.CommandLine)
    $Executable = ConvertTo-NapCatCanonicalPath ([string]$Record.ExecutablePath)
    $PathUnknown = $Name -match '^(qq|qqnt|qqex|cmd|node|napcatwinbootmain|powershell|pwsh)(\.exe)?$' -and -not [string]::IsNullOrWhiteSpace([string]$Record.ExecutablePath) -and -not $Executable
    $MatchesRoot = $false
    if ($Root) {
      if ($Name -match '^napcatwinbootmain\.exe$') {
        $CommandEntry = (Get-NapCatCommandEntry $Command).executable
        $CommandExecutable = ConvertTo-NapCatCanonicalPath $CommandEntry
        if ($CommandEntry -and -not $CommandExecutable) { $PathUnknown = $true }
        $MatchesRoot = $Executable -eq "$Root/napcatwinbootmain.exe" -or ([string]::IsNullOrWhiteSpace([string]$Record.ExecutablePath) -and $CommandExecutable -eq "$Root/napcatwinbootmain.exe")
      } elseif ($Name -match '^cmd(\.exe)?$') {
        $ArgumentsText = (Get-NapCatCommandEntry $Command).arguments
        if ($ArgumentsText -match '^(?:(?:/d|/s|/q)\s+)*\/[ck]\s+(?:call\s+)?(.+)$') {
          $RawInvocation = $Matches[1]
          $InvocationEntry = (Get-NapCatCommandEntry ($RawInvocation -replace '^"+', '"')).executable
          if ($InvocationEntry) {
            $CanonicalEntry = ConvertTo-NapCatCanonicalPath $InvocationEntry
            if (-not $CanonicalEntry) { $PathUnknown = $true }
            if ($CanonicalEntry -in @("$Root/launcher-user.bat", "$Root/napcat.bat", "$Root/napcatwinbootmain.exe")) { $MatchesRoot = $true }
          }
        }
      } elseif ($Name -match '^node(\.exe)?$') {
        $ArgumentsText = (Get-NapCatCommandEntry $Command).arguments
        while ($ArgumentsText -match '^--(?:inspect(?:-brk)?(?:=\S+)?|no-warnings|trace-warnings|enable-source-maps)(?:\s|$)') {
          $ArgumentsText = (Get-NapCatCommandEntry $ArgumentsText).arguments
        }
        $Entry = (Get-NapCatCommandEntry $ArgumentsText).executable
        $EntryPath = ConvertTo-NapCatCanonicalPath $Entry
        if ($Entry -and -not $EntryPath) { $PathUnknown = $true }
        foreach ($Entry in @('index.js','napcat.mjs','napcat/napcat.mjs')) {
          if ($EntryPath -eq "$Root/$Entry") { $MatchesRoot = $true }
        }
      } elseif ($Name -match '^(powershell|pwsh)(\.exe)?$') {
        $MatchesRoot = ($Command -match '(?:^|\s)-(?:file|f)\s+"?[^"\r\n]*/start-napcat-login\.ps1(?:["\s]|$)') -and ($Command -notmatch '(?:^|\s)-(?:command|c|encodedcommand|enc|e)(?:\s|$)') -and (Test-NapCatIdentityPath $Command $Root)
      }
      if ($Name -match '^(qq|qqnt|qqex)(\.exe)?$' -and $Record.ModuleScanState -eq 'ok') {
        foreach ($Module in @($Record.ModulePaths)) {
          $ModulePath = ConvertTo-NapCatCanonicalPath ([string]$Module)
          if (-not [string]::IsNullOrWhiteSpace([string]$Module) -and -not $ModulePath) { $PathUnknown = $true }
          if ($ModulePath -eq "$Root/napcatwinboothook.dll") { $MatchesRoot = $true }
        }
      }
    }
    if ($MatchesRoot) { $Owned[[int]$Record.ProcessId] = $true }
    elseif ($PathUnknown) { $Uncertain[[int]$Record.ProcessId] = $true }
    elseif ($Name -match '^napcatwinbootmain\.exe$' -and ((-not $Executable) -or (-not $Command))) { $Uncertain[[int]$Record.ProcessId] = $true }
  }
  $Changed = $true
  while ($Changed) {
    $Changed = $false
    foreach ($Record in $Processes) {
      if (-not $Owned.ContainsKey([int]$Record.ProcessId) -and -not $Uncertain.ContainsKey([int]$Record.ProcessId) -and $Uncertain.ContainsKey([int]$Record.ParentProcessId) -and [string]$Record.Name -match '^(qq|qqnt|qqex|cmd|node|napcatwinbootmain)(\.exe)?$') {
        $Uncertain[[int]$Record.ProcessId] = $true
        $Changed = $true
      }
      if (-not $Owned.ContainsKey([int]$Record.ProcessId) -and [string]$Record.Name -match '^(qq|qqnt|qqex|cmd|node|napcatwinbootmain)(\.exe)?$' -and $Owned.ContainsKey([int]$Record.ParentProcessId) -and (Test-NapCatIdentityLink $Record $ByPid[[int]$Record.ParentProcessId])) {
        $Owned[[int]$Record.ProcessId] = $true
        $Changed = $true
      }
    }
  }
  foreach ($Record in $Processes) {
    if ([string]$Record.Name -match '^(qq|qqnt|qqex)(\.exe)?$' -and -not $Owned.ContainsKey([int]$Record.ProcessId) -and $Record.ModuleScanState -eq 'ok' -and -not [string]::IsNullOrWhiteSpace([string]$Record.CommandLine) -and [string]$Record.CommandLine -notmatch '\s--type(?:=|\s)' -and -not [double]::IsNaN((Get-NapCatIdentityBirth $Record)) -and -not $Uncertain.ContainsKey([int]$Record.ProcessId) -and [string]$Record.CommandLine -notmatch '(?:^|\s)-q(?:\s|$)|loadnapcat|napcatwinboothook') {
      $Ordinary[[int]$Record.ProcessId] = $true
    }
  }
  $Changed = $true
  while ($Changed) {
    $Changed = $false
    foreach ($Record in $Processes) {
      if (-not $Ordinary.ContainsKey([int]$Record.ProcessId) -and -not $Owned.ContainsKey([int]$Record.ProcessId) -and -not $Uncertain.ContainsKey([int]$Record.ProcessId) -and [string]$Record.Name -match '^(qq|qqnt|qqex)(\.exe)?$' -and $Ordinary.ContainsKey([int]$Record.ParentProcessId) -and (Test-NapCatIdentityLink $Record $ByPid[[int]$Record.ParentProcessId]) -and $Record.ModuleScanState -eq 'ok') {
        $Ordinary[[int]$Record.ProcessId] = $true
        $Changed = $true
      }
    }
  }
  return [pscustomobject]@{
    owned = @($Processes | Where-Object { $Owned.ContainsKey([int]$_.ProcessId) })
    ordinary = @($Processes | Where-Object { $Ordinary.ContainsKey([int]$_.ProcessId) })
    unknown = @($Processes | Where-Object { $Uncertain.ContainsKey([int]$_.ProcessId) -or ([string]$_.Name -match '^(qq|qqnt|qqex)(\.exe)?$' -and -not $Owned.ContainsKey([int]$_.ProcessId) -and -not $Ordinary.ContainsKey([int]$_.ProcessId)) })
  }
}

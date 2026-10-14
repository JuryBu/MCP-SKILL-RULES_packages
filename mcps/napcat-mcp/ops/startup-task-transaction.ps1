function Get-StartupTaskXmlKey([string]$Xml,[switch]$IgnoreEnabled) {
  $Document=[xml]$Xml
  if ($Document.DocumentElement.LocalName -cne 'Task') {throw 'TASK_XML_ROOT_INVALID'}
  function NodeKey($Node) {
    if ($Node.NodeType -eq [Xml.XmlNodeType]::Element) {
      if ($IgnoreEnabled -and $Node.LocalName -ceq 'Enabled' -and $Node.ParentNode.LocalName -ceq 'Settings') {return ''}
      $Attributes=@($Node.Attributes | Where-Object {$_.Prefix -cne 'xmlns' -and $_.Name -cne 'xmlns'} | Sort-Object Name | ForEach-Object {$_.LocalName+'='+$_.Value})
      $Children=@($Node.ChildNodes | ForEach-Object {NodeKey $_})
      return ('<'+$Node.LocalName+' '+($Attributes -join '|')+'>'+($Children -join '')+'</'+$Node.LocalName+'>')
    }
    if ($Node.NodeType -in @([Xml.XmlNodeType]::Text,[Xml.XmlNodeType]::CDATA)) {return $Node.Value.Trim()}
    return ''
  }
  return NodeKey $Document.DocumentElement
}
function Assert-StartupTaskInputs($Settings) {
  $Binding=$Settings.taskUpgrade
  if (-not $Binding -or $Binding.taskName -cne 'CodexNapCatSupervisor') {throw 'TASK_UPGRADE_BINDING_REQUIRED'}
  foreach ($Phase in @('original','candidate')) {
    if ((Sha $Binding.($Phase+'XmlPath')) -cne $Binding.($Phase+'XmlSha256')) {throw 'TASK_XML_INPUT_CHANGED'}
  }
  $Original=[xml][IO.File]::ReadAllText($Binding.originalXmlPath)
  $Candidate=[xml][IO.File]::ReadAllText($Binding.candidateXmlPath)
  $Candidate.Task.Actions.InnerXml=$Original.Task.Actions.InnerXml
  if ((Get-StartupTaskXmlKey $Original.OuterXml -IgnoreEnabled) -cne (Get-StartupTaskXmlKey $Candidate.OuterXml -IgnoreEnabled)) {throw 'TASK_NON_ACTION_CONFIGURATION_CHANGED'}
  if (@($Original.Task.Actions.ChildNodes | Where-Object NodeType -eq Element).Count -ne 1) {throw 'TASK_ORIGINAL_ACTION_COUNT_CHANGED'}
  $Proposed=[xml][IO.File]::ReadAllText($Binding.candidateXmlPath)
  if (@($Proposed.Task.Actions.ChildNodes | Where-Object NodeType -eq Element).Count -ne 1) {throw 'TASK_CANDIDATE_ACTION_COUNT_CHANGED'}
  if ($Binding.action -and ($Proposed.Task.Actions.Exec.Command -cne $Binding.action.execute -or $Proposed.Task.Actions.Exec.Arguments -cne $Binding.action.arguments -or $Proposed.Task.Actions.Exec.WorkingDirectory -cne $Binding.action.workingDirectory)) {throw 'TASK_PLAN_ACTION_BINDING_CHANGED'}
}
function Get-StartupTaskLive($Settings) {
  Assert-StartupTaskInputs $Settings
  if ($Settings.mode -ceq 'TempFixture') {
    $Root=FixtureRootIdentity ([string]$Settings.fixtureRoot)
    $Marker=Get-Content -LiteralPath (Join-Path $Root 'owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Marker.ownerId -cne 'startup-repair-20261012' -or (FixtureRootIdentity $Marker.fixtureRoot) -ine $Root) {throw 'TASK_FIXTURE_OWNER_CHANGED'}
    foreach ($Path in @($Settings.taskUpgrade.fixtureXmlPath,$Settings.taskUpgrade.fixtureStatePath,$Settings.taskUpgrade.fixtureLogPath)) {
      if (-not (FixtureRootIdentity $Path).StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'TASK_FIXTURE_PATH_ESCAPE'}
    }
    $State=Get-Content -LiteralPath $Settings.taskUpgrade.fixtureStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [pscustomobject]@{xml=[IO.File]::ReadAllText($Settings.taskUpgrade.fixtureXmlPath);enabled=[bool]$State.enabled;state=$State.state;securityDescriptor=$State.securityDescriptor}
  }
  if ($Settings.mode -cne 'ManualProduction') {throw 'TASK_MODE_INVALID'}
  $Task=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  $Scheduler=New-Object -ComObject 'Schedule.Service'
  $Scheduler.Connect()
  $Registered=$Scheduler.GetFolder('\').GetTask('CodexNapCatSupervisor')
  return [pscustomobject]@{xml=(Export-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\');enabled=[bool]$Task.Settings.Enabled;state=[string]$Task.State;securityDescriptor=$Registered.GetSecurityDescriptor(7)}
}
function Assert-StartupTaskSecurityDescriptor([string]$Expected,[string]$Actual) {
  if ($Expected -ceq $Actual) {return}
  try {
    $ExpectedDescriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Expected)
    $ActualDescriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Actual)
    if (-not $ExpectedDescriptor.Owner -or -not $ActualDescriptor.Owner -or -not $ExpectedDescriptor.Group -or -not $ActualDescriptor.Group -or $ExpectedDescriptor.Owner.Value -cne $ActualDescriptor.Owner.Value -or $ExpectedDescriptor.Group.Value -cne $ActualDescriptor.Group.Value) {throw 'changed'}
    $Parts=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
    if ($ExpectedDescriptor.GetSddlForm($Parts) -ceq $ActualDescriptor.GetSddlForm($Parts)) {return}
    $AutoInherited=[int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
    $ExpectedFlags=[int]$ExpectedDescriptor.ControlFlags
    $ActualFlags=[int]$ActualDescriptor.ControlFlags
    $DifferentFlags=$ExpectedFlags -bxor $ActualFlags
    if (($DifferentFlags -band (-bnot $AutoInherited)) -ne 0 -or ($DifferentFlags -ne 0 -and (($ExpectedFlags -band $AutoInherited) -ne 0 -or ($ActualFlags -band $AutoInherited) -eq 0))) {throw 'changed'}
    if ($ExpectedDescriptor.SystemAcl -or $ActualDescriptor.SystemAcl -or -not $ExpectedDescriptor.DiscretionaryAcl -or -not $ActualDescriptor.DiscretionaryAcl -or $ExpectedDescriptor.DiscretionaryAcl.Count -ne $ActualDescriptor.DiscretionaryAcl.Count -or $ExpectedDescriptor.DiscretionaryAcl.Revision -ne $ActualDescriptor.DiscretionaryAcl.Revision) {throw 'changed'}
    $ExpectedAces=@($ExpectedDescriptor.DiscretionaryAcl)
    $ActualAces=@($ActualDescriptor.DiscretionaryAcl)
    foreach ($Ace in @($ExpectedAces)+@($ActualAces)) {
      if ($Ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) {throw 'changed'}
    }
    $Inherited=[int][Security.AccessControl.AceFlags]::Inherited
    $CanonicalAces=@($ExpectedAces | Where-Object {([int]$_.AceFlags -band $Inherited) -eq 0})+@($ExpectedAces | Where-Object {([int]$_.AceFlags -band $Inherited) -ne 0})
    for ($Index=0;$Index -lt $CanonicalAces.Count;$Index++) {
      $ExpectedBytes=New-Object byte[] $CanonicalAces[$Index].BinaryLength
      $ActualBytes=New-Object byte[] $ActualAces[$Index].BinaryLength
      $CanonicalAces[$Index].GetBinaryForm($ExpectedBytes,0)
      $ActualAces[$Index].GetBinaryForm($ActualBytes,0)
      if ([BitConverter]::ToString($ExpectedBytes) -cne [BitConverter]::ToString($ActualBytes)) {throw 'changed'}
    }
  } catch {throw 'TASK_SECURITY_DESCRIPTOR_CHANGED'}
}
function Get-StartupTaskPhase($Settings) {
  $Live=Get-StartupTaskLive $Settings
  $Key=Get-StartupTaskXmlKey $Live.xml -IgnoreEnabled
  $Phase=$null
  foreach ($Name in @('original','candidate')) {
    if ($Key -ceq (Get-StartupTaskXmlKey ([IO.File]::ReadAllText($Settings.taskUpgrade.($Name+'XmlPath'))) -IgnoreEnabled)) {$Phase=$Name;break}
  }
  if (-not $Phase) {throw 'TASK_CURRENT_DEFINITION_UNKNOWN'}
  if ($Settings.taskUpgrade.securityDescriptor) {Assert-StartupTaskSecurityDescriptor $Settings.taskUpgrade.securityDescriptor $Live.securityDescriptor}
  return [pscustomobject]@{phase=$Phase;enabled=$Live.enabled;state=$Live.state;xml=$Live.xml}
}
function Set-StartupTaskPhase($Settings,[ValidateSet('original','candidate')][string]$Phase) {
  $Current=Get-StartupTaskPhase $Settings
  if ($Current.enabled -or $Current.state -ceq 'Running') {throw 'TASK_MUST_BE_DISABLED_AND_STOPPED'}
  if ($Phase -ceq 'candidate') {
    foreach ($Pin in $Settings.taskUpgrade.postInstallPins) {if ((Sha $Pin.path) -cne $Pin.sha256) {throw ('TASK_POST_INSTALL_DEPENDENCY_CHANGED:'+$Pin.path)}}
  }
  $Document=[xml][IO.File]::ReadAllText($Settings.taskUpgrade.($Phase+'XmlPath'))
  $Enabled=$Document.Task.Settings.SelectSingleNode('*[local-name()="Enabled"]')
  if (-not $Enabled) {$Enabled=$Document.CreateElement('Enabled',$Document.Task.NamespaceURI);$Document.Task.Settings.AppendChild($Enabled) | Out-Null}
  $Enabled.InnerText='false'
  if ($Settings.mode -ceq 'TempFixture') {
    [IO.File]::WriteAllText($Settings.taskUpgrade.fixtureXmlPath,$Document.OuterXml,[Text.UTF8Encoding]::new($false))
    [IO.File]::AppendAllText($Settings.taskUpgrade.fixtureLogPath,('TASK_'+$Phase.ToUpperInvariant()+'_DISABLED'+[Environment]::NewLine))
  } else {
    Register-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' -Xml $Document.OuterXml -Force | Out-Null
    $Scheduler=New-Object -ComObject 'Schedule.Service'
    $Scheduler.Connect()
    $Scheduler.GetFolder('\').GetTask('CodexNapCatSupervisor').SetSecurityDescriptor($Settings.taskUpgrade.securityDescriptor,0x10)
  }
  $Verified=Get-StartupTaskPhase $Settings
  if ($Verified.phase -cne $Phase -or $Verified.enabled -or $Verified.state -ceq 'Running') {throw 'TASK_DISABLED_DEFINITION_NOT_VERIFIED'}
  return $Verified
}
function Disable-StartupTask($Settings) {
  $Current=Get-StartupTaskPhase $Settings
  if ($Settings.mode -ceq 'TempFixture') {
    $State=Get-Content -LiteralPath $Settings.taskUpgrade.fixtureStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $State.enabled=$false
    [IO.File]::WriteAllText($Settings.taskUpgrade.fixtureStatePath,($State | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    [IO.File]::AppendAllText($Settings.taskUpgrade.fixtureLogPath,('TASK_DISABLED'+[Environment]::NewLine))
  } else {Disable-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' | Out-Null}
  return Get-StartupTaskPhase $Settings
}
function Restore-StartupTaskEnabled($Settings,[string]$ExpectedPhase) {
  $Current=Get-StartupTaskPhase $Settings
  if ($Current.phase -cne $ExpectedPhase -or $Current.enabled -or $Current.state -ceq 'Running') {throw 'TASK_ENABLE_PHASE_CHANGED'}
  $Manifest=Get-Content -LiteralPath $Settings.manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($Entry in $Manifest.files) {
    $Exists=Test-Path -LiteralPath $Entry.targetPath -PathType Leaf
    $ExpectedExists=if($ExpectedPhase -ceq 'original'){[bool]$Entry.original.exists}else{$true}
    $ExpectedSha=if($ExpectedPhase -ceq 'original'){$Entry.original.sha256}else{$Entry.candidateSha256}
    if ($Exists -ne $ExpectedExists -or ($Exists -and (Sha $Entry.targetPath) -cne $ExpectedSha)) {throw 'TASK_ENABLE_FILE_PHASE_INCOMPLETE'}
  }
  if ($Settings.mode -ceq 'TempFixture') {
    $State=Get-Content -LiteralPath $Settings.taskUpgrade.fixtureStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $State.enabled=[bool]$Settings.originalWatchdogEnabled
    [IO.File]::WriteAllText($Settings.taskUpgrade.fixtureStatePath,($State | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    [IO.File]::AppendAllText($Settings.taskUpgrade.fixtureLogPath,('TASK_ENABLE_'+$ExpectedPhase.ToUpperInvariant()+[Environment]::NewLine))
  } elseif ($Settings.originalWatchdogEnabled) {
    Enable-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' | Out-Null
  }
  $Verified=Get-StartupTaskPhase $Settings
  if ($Verified.enabled -ne [bool]$Settings.originalWatchdogEnabled) {throw 'TASK_ENABLED_STATE_NOT_RESTORED'}
  return $Verified
}

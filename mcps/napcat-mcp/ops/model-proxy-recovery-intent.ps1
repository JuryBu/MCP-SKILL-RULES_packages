Add-Type -AssemblyName System.Security
if(-not ('NapcatRecoveryNative' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NapcatRecoveryNative {
  [StructLayout(LayoutKind.Sequential)] public struct Information {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);
  [DllImport("advapi32.dll", EntryPoint="SetFileSecurityW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetFileSecurity(string path, uint information, byte[] descriptor);
  public static string Identity(string path) {
    using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      Information information;
      if (!GetFileInformationByHandle(stream.SafeFileHandle, out information)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (information.Links != 1) throw new IOException("File link count must be one");
      return information.Volume.ToString("x8") + ":" + information.IndexHigh.ToString("x8") + information.IndexLow.ToString("x8");
    }
  }
}
'@
}
function Set-ExactAcl([string]$Path,[string]$Sddl){
  Assert-SafePath $Path
  $Security=[Security.AccessControl.FileSecurity]::new()
  $Security.SetSecurityDescriptorSddlForm($Sddl)
  [uint32]$Information=4
  if($Security.AreAccessRulesProtected){$Information=$Information -bor [uint32]2147483648}else{$Information=$Information -bor [uint32]536870912}
  if(-not [NapcatRecoveryNative]::SetFileSecurity($Path,$Information,$Security.GetSecurityDescriptorBinaryForm())){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
  if((Normalize-Acl (Get-Acl -LiteralPath $Path).Sddl) -cne (Normalize-Acl $Sddl)){throw 'Exact ACL verification failed'}
}
function File-Identity([string]$Path){Assert-SafePath $Path;[NapcatRecoveryNative]::Identity($Path)}
function Flush-NewFile([string]$Path,[byte[]]$Bytes){
  Assert-SafePath $Path
  $Stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$Stream.Write($Bytes,0,$Bytes.Length);$Stream.Flush($true)}finally{$Stream.Dispose()}
}
function Hmac-Text([string]$Text){
  $Hmac=[Security.Cryptography.HMACSHA256]::new($script:RecoveryKey)
  try{([BitConverter]::ToString($Hmac.ComputeHash($Utf8.GetBytes($Text)))).Replace('-','').ToLowerInvariant()}finally{$Hmac.Dispose()}
}
function Initialize-RecoveryKey {
  $KeyPath=Join-Path $BackupRoot 'recovery-key.dpapi'
  $Key=New-Object byte[] 32
  $Random=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$Random.GetBytes($Key)}finally{$Random.Dispose()}
  $Protected=[Security.Cryptography.ProtectedData]::Protect($Key,$Utf8.GetBytes('napcat-recovery-intent-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  Flush-NewFile $KeyPath $Protected
  $script:RecoveryKey=$Key
}
function Authenticate-Plan {
  $KeyPath=Join-Path $BackupRoot 'recovery-key.dpapi'
  Assert-SafePath $KeyPath
  $script:RecoveryKey=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyPath),$Utf8.GetBytes('napcat-recovery-intent-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  if((Hash-File $KeyPath) -cne $Plan.recoveryKeyHash -or (Normalize-Acl (Get-Acl -LiteralPath $KeyPath).Sddl) -cne (Normalize-Acl $Plan.recoveryKeySddl)){throw 'Recovery key identity or ACL changed'}
  $PlanAuth=Join-Path $BackupRoot 'plan-auth.hmac'
  Assert-SafePath $PlanAuth
  if([IO.File]::ReadAllText($PlanAuth) -cne (Hmac-Text ([IO.File]::ReadAllText($PlanPath)))){throw 'Prepared plan authentication failed'}
  $script:PlanSha=Hash-File $PlanPath
}
function Intent-Path([string]$Phase,$Entry){Join-Path $BackupRoot ('intent-'+$Phase+'-'+[IO.Path]::GetFileName($Entry.relative)+'.json')}
function Fault-Acl([string]$Sddl){
  $Security=[Security.AccessControl.FileSecurity]::new()
  $Security.SetSecurityDescriptorSddlForm($Sddl)
  $Security.SetAccessRuleProtection((-not $Security.AreAccessRulesProtected),$true)
  $Security.Sddl
}
function Read-Intent([string]$Phase,$Entry){
  $Path=Intent-Path $Phase $Entry
  Assert-SafePath $Path
  if(-not(Test-Path -LiteralPath $Path)){return $null}
  $Envelope=Get-Content -LiteralPath $Path -Encoding UTF8 -Raw|ConvertFrom-Json
  if($Envelope.mac -cne (Hmac-Text $Envelope.payload)){throw 'Recovery intent authentication failed'}
  $Intent=$Envelope.payload|ConvertFrom-Json
  $Target=Join-Path $CodeRoot $Entry.relative
  $Backup=Join-Path $BackupRoot $Entry.relative
  if($Intent.schema -ne 1 -or $Intent.planSha -cne $script:PlanSha -or $Intent.phase -cne $Phase -or $Intent.target -cne $Target -or $Intent.backup -cne $Backup -or $Intent.backupIdentity -cne $Entry.backupIdentity -or $Intent.token -cne $script:IntentLeaseToken -or $Intent.originalHash -cne $Entry.previous -or $Intent.candidateHash -cne $Entry.candidate -or $Intent.originalIdentity -cne $Entry.originalIdentity -or $Intent.expectedAcl -cne (Normalize-Acl $Entry.sddl)){throw 'Recovery intent binding mismatch'}
  $AuthorizedHash=if($Phase -ceq 'restore'){$Entry.previous}else{$Entry.candidate}
  if($Intent.replacementHash -cne $AuthorizedHash){throw 'Intent does not authorize these replacement bytes'}
  if($Intent.faultAcl){
    $TempPrefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(-not $CodeRoot.StartsWith($TempPrefix,[StringComparison]::OrdinalIgnoreCase) -or -not $Intent.fixtureFault -or $Intent.faultAcl -cne (Normalize-Acl (Fault-Acl $Entry.sddl))){throw 'Unrecognized planned ACL state'}
  }
  $ExpectedDirectory=if($Phase -ceq 'quarantine'){$BackupRoot}else{[IO.Path]::GetDirectoryName($Target)}
  if([IO.Path]::GetDirectoryName($Intent.staging) -cne $ExpectedDirectory){throw 'Recovery staging scope mismatch'}
  return $Intent
}
function Write-Intent([string]$Phase,$Entry,[string]$Staging,[string]$ObjectIdentity,[string]$Hash,[string]$PreviousIdentity,[bool]$Fault){
  if($InjectIntentWriteFailure -and [IO.Path]::GetFileName($Entry.relative) -ceq 'request-wait-budget.mjs'){throw 'INJECTED_INTENT_WRITE_FAILURE'}
  $Intent=[ordered]@{schema=1;planSha=$script:PlanSha;phase=$Phase;target=(Join-Path $CodeRoot $Entry.relative);backup=(Join-Path $BackupRoot $Entry.relative);backupIdentity=$Entry.backupIdentity;token=$script:IntentLeaseToken;originalHash=$Entry.previous;candidateHash=$Entry.candidate;originalIdentity=$Entry.originalIdentity;expectedAcl=(Normalize-Acl $Entry.sddl);staging=$Staging;objectIdentity=$ObjectIdentity;replacementHash=$Hash;previousIdentity=$PreviousIdentity;fixtureFault=$Fault;faultAcl=$(if($Fault){Normalize-Acl (Fault-Acl $Entry.sddl)}else{$null})}
  $Payload=$Intent|ConvertTo-Json -Depth 8 -Compress
  $Envelope=@{payload=$Payload;mac=(Hmac-Text $Payload)}|ConvertTo-Json -Depth 4 -Compress
  Flush-NewFile (Intent-Path $Phase $Entry) ($Utf8.GetBytes($Envelope))
  $Verified=Read-Intent $Phase $Entry
  if($Verified.objectIdentity -cne $ObjectIdentity -or $Verified.replacementHash -cne $Hash){throw 'Durable intent readback failed'}
  return $Verified
}
function Assert-RecoveryTarget($Entry){
  $Target=Join-Path $CodeRoot $Entry.relative
  $ApplyIntent=Read-Intent 'apply' $Entry
  $RestoreIntent=Read-Intent 'restore' $Entry
  $QuarantineIntent=Read-Intent 'quarantine' $Entry
  if(-not(Test-Path -LiteralPath $Target)){
    if(-not $Entry.existed){
      if($QuarantineIntent -and (-not(Test-Path -LiteralPath $QuarantineIntent.staging) -or (File-Identity $QuarantineIntent.staging) -cne $QuarantineIntent.objectIdentity -or (Hash-File $QuarantineIntent.staging) -cne $QuarantineIntent.replacementHash -or (Normalize-Acl (Get-Acl -LiteralPath $QuarantineIntent.staging).Sddl) -cnotin @($QuarantineIntent.expectedAcl,$QuarantineIntent.faultAcl))){throw 'Quarantined object changed'}
      return
    }
    throw 'Unknown missing original target; no signed replacement object'
  }
  $Identity=File-Identity $Target
  $Hash=Hash-File $Target
  $Acl=Normalize-Acl (Get-Acl -LiteralPath $Target).Sddl
  if($Entry.existed -and $Identity -ceq $Entry.originalIdentity -and $Hash -ceq $Entry.previous -and $Acl -ceq (Normalize-Acl $Entry.sddl)){return}
  foreach($Intent in @($RestoreIntent,$ApplyIntent)){
    if($Intent -and $Identity -ceq $Intent.objectIdentity -and $Hash -ceq $Intent.replacementHash -and $Acl -cin @($Intent.expectedAcl,$Intent.faultAcl)){return}
  }
  throw 'Unknown target object, bytes or ACL; refusing recovery'
}
function Replacement-Checkpoint([string]$Phase,$Entry){
  $Leaf=[IO.Path]::GetFileName($Entry.relative)
  $Pause=($Phase -ceq 'apply' -and $Leaf -ceq $InjectPauseAfterApplyLeaf) -or ($Phase -ceq 'restore' -and $InjectPauseDuringRestoreCore -and $Leaf -ceq 'codex-model-stream-proxy.mjs')
  if($Pause){
    $Checkpoint=Join-Path $BackupRoot ('checkpoint-'+$Phase+'-'+$Leaf+'.json')
    $Continue=Join-Path $BackupRoot ('continue-'+$Phase+'-'+$Leaf)
    Flush-NewFile $Checkpoint ($Utf8.GetBytes((@{pid=$PID;phase=$Phase;target=(Join-Path $CodeRoot $Entry.relative);beforePostRecord=$true}|ConvertTo-Json -Compress)))
    while(-not(Test-Path -LiteralPath $Continue)){Start-Sleep -Milliseconds 100}
  }
}
function Replace-WithIntent([string]$Phase,$Entry,[string]$Source){
  $Target=Join-Path $CodeRoot $Entry.relative
  $Intent=Read-Intent $Phase $Entry
  if($Intent -and (Test-Path -LiteralPath $Target) -and (File-Identity $Target) -ceq $Intent.objectIdentity){
    Assert-RecoveryTarget $Entry
    if((Hash-File $Target) -cne $Intent.replacementHash){throw 'Committed replacement bytes changed'}
    Set-ExactAcl $Target $Entry.sddl
    return
  }
  if($Intent){
    if(-not(Test-Path -LiteralPath $Intent.staging) -or (File-Identity $Intent.staging) -cne $Intent.objectIdentity -or (Hash-File $Intent.staging) -cne $Intent.replacementHash -or (Normalize-Acl (Get-Acl -LiteralPath $Intent.staging).Sddl) -cne $Intent.expectedAcl){throw 'Pending staging object changed'}
    if((Test-Path -LiteralPath $Target) -and (File-Identity $Target) -cne $Intent.previousIdentity){throw 'Pending replacement predecessor changed'}
    $Staging=$Intent.staging
  }else{
    $Intent=Prepare-ReplacementIntent $Phase $Entry $Source
    $Staging=$Intent.staging
  }
  Assert-SafePath $Target
  Assert-SafePath $Staging
  if((File-Identity $Staging) -cne $Intent.objectIdentity -or (Hash-File $Staging) -cne $Intent.replacementHash -or (Normalize-Acl (Get-Acl -LiteralPath $Staging).Sddl) -cne $Intent.expectedAcl){throw 'Staging changed before replacement'}
  if($Phase -ceq 'restore' -and (Test-Path -LiteralPath $Target)){
    Assert-RecoveryTarget $Entry
    Set-ExactAcl $Target $Entry.sddl
  }
  if(Test-Path -LiteralPath $Target){[IO.File]::Replace($Staging,$Target,[NullString]::Value,$false)}else{[IO.File]::Move($Staging,$Target)}
  if((File-Identity $Target) -cne $Intent.objectIdentity -or (Hash-File $Target) -cne $Intent.replacementHash){throw 'Replacement object verification failed'}
  if($Intent.faultAcl){Set-ExactAcl $Target (Fault-Acl $Entry.sddl)}
  Replacement-Checkpoint $Phase $Entry
  if($Phase -ceq 'apply' -and $Intent.fixtureFault){throw 'INJECTED_PREDECLARED_POST_REPLACE_ACL_STATE'}
  if((Normalize-Acl (Get-Acl -LiteralPath $Target).Sddl) -cne $Intent.expectedAcl){throw 'Post replacement ACL mismatch'}
}
function Prepare-ReplacementIntent([string]$Phase,$Entry,[string]$Source){
  $Target=Join-Path $CodeRoot $Entry.relative
  $Intent=Read-Intent $Phase $Entry
  if(-not $Intent){
    $Staging=$Target+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    Assert-SafePath $Source
    Flush-NewFile $Staging ([IO.File]::ReadAllBytes($Source))
    Set-ExactAcl $Staging $Entry.sddl
    $AuthorizedHash=if($Phase -ceq 'restore'){$Entry.previous}else{$Entry.candidate}
    if((Hash-File $Staging) -cne $AuthorizedHash){Remove-Item -LiteralPath $Staging -Force;throw 'Staging bytes differ from authorized plan'}
    $PreviousIdentity=if(Test-Path -LiteralPath $Target){File-Identity $Target}else{$null}
    $Leaf=[IO.Path]::GetFileName($Entry.relative)
    $Fault=($Phase -ceq 'apply' -and $Leaf -ceq $InjectPauseAfterApplyLeaf) -or ($Phase -ceq 'restore' -and $InjectPauseDuringRestoreCore -and $Leaf -ceq 'codex-model-stream-proxy.mjs')
    try{$Intent=Write-Intent $Phase $Entry $Staging (File-Identity $Staging) (Hash-File $Staging) $PreviousIdentity $Fault}catch{Assert-SafePath $Staging;Remove-Item -LiteralPath $Staging -Force;throw}
  }
  return $Intent
}
function Assert-AllRecoveryTargets {
  foreach($Entry in $Plan.files){
    Assert-RecoveryTarget $Entry
    if($Entry.existed -and ((File-Identity (Join-Path $BackupRoot $Entry.relative)) -cne $Entry.backupIdentity -or (Hash-File (Join-Path $BackupRoot $Entry.relative)) -cne $Entry.previous)){throw 'Recovery backup changed'}
    foreach($Phase in @('apply','restore')){
      $Intent=Read-Intent $Phase $Entry
      if(-not $Intent){continue}
      $Target=Join-Path $CodeRoot $Entry.relative
      if((Test-Path -LiteralPath $Target) -and (File-Identity $Target) -ceq $Intent.objectIdentity){continue}
      if($Phase -ceq 'apply' -and (Read-Intent 'restore' $Entry)){continue}
      if($Phase -ceq 'apply' -and -not $Entry.existed -and (Read-Intent 'quarantine' $Entry)){continue}
      if(-not(Test-Path -LiteralPath $Intent.staging) -or (File-Identity $Intent.staging) -cne $Intent.objectIdentity -or (Hash-File $Intent.staging) -cne $Intent.replacementHash -or (Normalize-Acl (Get-Acl -LiteralPath $Intent.staging).Sddl) -cne $Intent.expectedAcl){throw 'Unknown pending staging object, bytes or ACL'}
    }
  }
}


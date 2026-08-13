[CmdletBinding()]
param(
    [switch]$IncludeNapCat,
    [switch]$IncludeWechatDocs
)

$ErrorActionPreference = "Stop"

function Enable-CommentedMcpBlock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $commentedBlock = @(
        "# [mcp_servers.$Name]",
        "# url = `"$Url`"",
        "# enabled = true"
    ) -join "`n"
    $activeBlock = @(
        "[mcp_servers.$Name]",
        "url = `"$Url`"",
        "enabled = true"
    ) -join "`n"
    $normalized = $Content -replace "`r`n", "`n"
    if (-not $normalized.Contains($commentedBlock)) {
        throw "Codex config template is missing the expected optional MCP block: $Name"
    }
    return $normalized.Replace($commentedBlock, $activeBlock)
}

$codexDir = Join-Path $env:USERPROFILE ".codex"
$configPath = Join-Path $codexDir "config.toml"
$backupDir = Join-Path $codexDir "backups"
$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $toolkitRoot "install\CodexConfigHelpers.ps1")
$templatePath = Join-Path $toolkitRoot "templates\config.codex.toml"

New-Item -ItemType Directory -Force -Path $codexDir, $backupDir | Out-Null

if (Test-Path -LiteralPath $configPath) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupDir "config.toml.before-portable-toolkit-$stamp") -Force
    $current = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw
} else {
    $current = ""
}

$template = Get-Content -LiteralPath $templatePath -Encoding UTF8 -Raw
$port = if ($env:CODEX_MCP_BROKER_PORT) { $env:CODEX_MCP_BROKER_PORT } else { "14588" }
$template = $template.Replace("127.0.0.1:14588", "127.0.0.1:$port")
if ($env:EXA_MCP_REMOTE_URL -or $env:CODEX_TOOLKIT_EXA_MCP_REMOTE_URL) {
    $template = Enable-CommentedMcpBlock -Content $template -Name "exa" -Url "http://127.0.0.1:$port/exa/mcp"
}
if ($IncludeNapCat) {
    $template = Enable-CommentedMcpBlock -Content $template -Name "napcat" -Url "http://127.0.0.1:$port/napcat/mcp"
}
if ($IncludeWechatDocs) {
    $template = Enable-CommentedMcpBlock -Content $template -Name "wechat-docs" -Url "http://127.0.0.1:$port/wechat-docs/mcp"
}
$begin = "# BEGIN PORTABLE CODEX TOOLKIT MCP"
$end = "# END PORTABLE CODEX TOOLKIT MCP"
$block = "$begin`r`n$template`r`n$end"

$legacyBegin = "# BEGIN " + "K" + "AGE CODEX TOOLKIT MCP"
$legacyEnd = "# END " + "K" + "AGE CODEX TOOLKIT MCP"
$legacyPattern = "(?s)\r?\n?" + [regex]::Escape($legacyBegin) + ".*?" + [regex]::Escape($legacyEnd) + "\r?\n?"
$current = [regex]::Replace($current, $legacyPattern, "").TrimEnd()
$pattern = "(?s)\r?\n?# BEGIN PORTABLE CODEX TOOLKIT MCP.*?# END PORTABLE CODEX TOOLKIT MCP\r?\n?"
$clean = [regex]::Replace($current, $pattern, "").TrimEnd()
$clean = Set-CodexProjectDocMaxBytes -Content $clean -MinimumBytes 65536
$managedServerNames = @("memory-store", "web-fetcher", "sandbox", "playwright", "sequential-thinking")
if ($env:EXA_MCP_REMOTE_URL -or $env:CODEX_TOOLKIT_EXA_MCP_REMOTE_URL) { $managedServerNames += "exa" }
if ($IncludeNapCat) { $managedServerNames += "napcat" }
if ($IncludeWechatDocs) { $managedServerNames += "wechat-docs" }
$duplicates = @($managedServerNames | Where-Object {
    $clean -match "(?m)^\s*\[mcp_servers\." + [regex]::Escape($_) + "\]\s*$"
})
if ($duplicates.Count -gt 0) {
    throw "Existing Codex config already defines toolkit MCP tables: $($duplicates -join ', '). No changes were written; merge those tables manually or remove the duplicates, then rerun."
}
$next = if ($clean.Length -gt 0) { "$clean`r`n`r`n$block`r`n" } else { "$block`r`n" }

Set-Content -LiteralPath $configPath -Value $next -Encoding UTF8 -NoNewline
Write-Output "Updated Codex config: $configPath"
Write-Output "Ensured project_doc_max_bytes is at least 65536."
if ($IncludeNapCat) { Write-Output "Enabled Codex MCP endpoint: napcat" }
if ($IncludeWechatDocs) { Write-Output "Enabled Codex MCP endpoint: wechat-docs" }
Write-Output "Restart Codex after applying this config."

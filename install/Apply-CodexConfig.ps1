$ErrorActionPreference = "Stop"

$codexDir = Join-Path $env:USERPROFILE ".codex"
$configPath = Join-Path $codexDir "config.toml"
$backupDir = Join-Path $codexDir "backups"
$templatePath = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "templates\config.codex.toml"

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
    $template = $template.Replace("# [mcp_servers.exa]", "[mcp_servers.exa]")
    $template = $template.Replace("# url = `"http://127.0.0.1:$port/exa/mcp`"", "url = `"http://127.0.0.1:$port/exa/mcp`"")
    $template = $template.Replace("# enabled = true", "enabled = true")
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
$managedServerNames = @("memory-store", "web-fetcher", "sandbox", "playwright", "sequential-thinking")
if ($env:EXA_MCP_REMOTE_URL -or $env:CODEX_TOOLKIT_EXA_MCP_REMOTE_URL) { $managedServerNames += "exa" }
$duplicates = @($managedServerNames | Where-Object {
    $clean -match "(?m)^\s*\[mcp_servers\." + [regex]::Escape($_) + "\]\s*$"
})
if ($duplicates.Count -gt 0) {
    throw "Existing Codex config already defines toolkit MCP tables: $($duplicates -join ', '). No changes were written; merge those tables manually or remove the duplicates, then rerun."
}
$next = if ($clean.Length -gt 0) { "$clean`r`n`r`n$block`r`n" } else { "$block`r`n" }

Set-Content -LiteralPath $configPath -Value $next -Encoding UTF8
Write-Output "Updated Codex config: $configPath"
Write-Output "Restart Codex after applying this config."


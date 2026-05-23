param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sourcePath = Join-Path $toolkitRoot "rules\codex\system-prompt.template.md"
$promptDir = Join-Path $env:USERPROFILE ".codex\prompts"
$targetPath = Join-Path $promptDir "system-prompt.md"

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing source template: $sourcePath"
}

New-Item -ItemType Directory -Force -Path $promptDir | Out-Null

if ((Test-Path -LiteralPath $targetPath) -and -not $Force) {
    Write-Output "System prompt already exists: $targetPath"
    Write-Output "Use -Force to overwrite, or merge rules\codex\system-prompt.template.md manually."
    exit 0
}

if (Test-Path -LiteralPath $targetPath) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $targetPath -Destination (Join-Path $promptDir "system-prompt.before-portable-toolkit-$stamp.md") -Force
}

Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
Write-Output "Installed system prompt template: $targetPath"
Write-Output "Add this top-level line to %USERPROFILE%\.codex\config.toml if it is not already present:"
Write-Output 'model_instructions_file = "~/.codex/prompts/system-prompt.md"'



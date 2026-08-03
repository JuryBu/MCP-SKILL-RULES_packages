function Set-CodexProjectDocMaxBytes {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$Content = "",
        [long]$MinimumBytes = 65536
    )

    if ($MinimumBytes -lt 32768) {
        throw "MinimumBytes must be at least 32768."
    }

    $normalized = $Content -replace "\r?\n", "`r`n"
    $firstTable = [regex]::Match($normalized, "(?m)^\s*\[")
    $root = if ($firstTable.Success) { $normalized.Substring(0, $firstTable.Index) } else { $normalized }
    $tables = if ($firstTable.Success) { $normalized.Substring($firstTable.Index) } else { "" }
    $namedMatches = [regex]::Matches($root, "(?m)^\s*project_doc_max_bytes\s*=.*$")

    if ($namedMatches.Count -gt 1) {
        throw "Codex config contains multiple top-level project_doc_max_bytes settings."
    }

    if ($namedMatches.Count -eq 1) {
        $numericMatch = [regex]::Match(
            $namedMatches[0].Value,
            "^(\s*)project_doc_max_bytes\s*=\s*([+-]?[0-9](?:_?[0-9])*)(\s*(?:#.*)?)$"
        )
        if (-not $numericMatch.Success) {
            throw "Top-level project_doc_max_bytes must be an integer."
        }

        $currentBytes = [long]($numericMatch.Groups[2].Value.Replace("_", ""))
        if ($currentBytes -lt $MinimumBytes) {
            $replacement = (
                $numericMatch.Groups[1].Value +
                "project_doc_max_bytes = $MinimumBytes" +
                $numericMatch.Groups[3].Value
            )
            $match = $namedMatches[0]
            $root = $root.Remove($match.Index, $match.Length).Insert($match.Index, $replacement)
        }
    } else {
        $trimmedRoot = $root.TrimEnd()
        $root = if ($trimmedRoot.Length -gt 0) {
            "$trimmedRoot`r`nproject_doc_max_bytes = $MinimumBytes`r`n"
        } else {
            "project_doc_max_bytes = $MinimumBytes`r`n"
        }
        if ($tables.Length -gt 0) {
            $root += "`r`n"
        }
    }

    return ($root + $tables).TrimEnd() + "`r`n"
}

function Set-CodexModelInstructionsFile {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$Content = "",
        [string]$InstructionPath = "~/.codex/prompts/system-prompt.md"
    )

    $normalized = $Content -replace "\r?\n", "`r`n"
    $firstTable = [regex]::Match($normalized, "(?m)^\s*\[")
    $root = if ($firstTable.Success) { $normalized.Substring(0, $firstTable.Index) } else { $normalized }
    $tables = if ($firstTable.Success) { $normalized.Substring($firstTable.Index) } else { "" }
    $matches = [regex]::Matches($root, "(?m)^\s*model_instructions_file\s*=.*$")

    if ($matches.Count -gt 1) {
        throw "Codex config contains multiple top-level model_instructions_file settings."
    }

    $canonical = 'model_instructions_file = "' + $InstructionPath + '"'
    if ($matches.Count -eq 1) {
        $match = $matches[0]
        $root = $root.Remove($match.Index, $match.Length).Insert($match.Index, $canonical)
    } else {
        $trimmedRoot = $root.TrimEnd()
        $root = if ($trimmedRoot.Length -gt 0) {
            "$trimmedRoot`r`n$canonical`r`n"
        } else {
            "$canonical`r`n"
        }
        if ($tables.Length -gt 0) {
            $root += "`r`n"
        }
    }

    return ($root + $tables).TrimEnd() + "`r`n"
}

function Set-CodexTomlTableValues {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$Content = "",
        [Parameter(Mandatory = $true)]
        [string]$TableName,
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Values
    )

    $normalized = $Content -replace "\r?\n", "`r`n"
    $headerPattern = "(?m)^\s*\[" + [regex]::Escape($TableName) + "\]\s*(?:#.*)?$"
    $headers = [regex]::Matches($normalized, $headerPattern)
    if ($headers.Count -gt 1) {
        throw "Codex config contains multiple [$TableName] tables."
    }

    if ($headers.Count -eq 0) {
        $tableLines = @("[$TableName]")
        foreach ($entry in $Values.GetEnumerator()) {
            $tableLines += "$($entry.Key) = $($entry.Value)"
        }
        $prefix = $normalized.TrimEnd()
        if ($prefix.Length -gt 0) {
            return "$prefix`r`n`r`n$($tableLines -join "`r`n")`r`n"
        }
        return "$($tableLines -join "`r`n")`r`n"
    }

    $header = $headers[0]
    $tableHeaderRegex = [regex]::new("(?m)^\s*\[")
    $nextHeader = $tableHeaderRegex.Match($normalized, $header.Index + $header.Length)
    $blockEnd = if ($nextHeader.Success) { $nextHeader.Index } else { $normalized.Length }
    $block = $normalized.Substring($header.Index, $blockEnd - $header.Index)
    $missingLines = @()

    foreach ($entry in $Values.GetEnumerator()) {
        $keyPattern = "(?m)^(\s*)" + [regex]::Escape([string]$entry.Key) + "\s*=.*?(\s*(?:#.*)?)$"
        $keyMatches = [regex]::Matches($block, $keyPattern)
        if ($keyMatches.Count -gt 1) {
            throw "Codex config contains multiple $($entry.Key) settings in [$TableName]."
        }
        if ($keyMatches.Count -eq 1) {
            $keyMatch = $keyMatches[0]
            $replacement = $keyMatch.Groups[1].Value + "$($entry.Key) = $($entry.Value)" + $keyMatch.Groups[2].Value
            $block = $block.Remove($keyMatch.Index, $keyMatch.Length).Insert($keyMatch.Index, $replacement)
        } else {
            $missingLines += "$($entry.Key) = $($entry.Value)"
        }
    }

    if ($missingLines.Count -gt 0) {
        $block = $block.TrimEnd() + "`r`n" + ($missingLines -join "`r`n") + "`r`n"
        if ($blockEnd -lt $normalized.Length) {
            $block += "`r`n"
        }
    }

    $normalized = $normalized.Remove($header.Index, $blockEnd - $header.Index).Insert($header.Index, $block)
    return $normalized.TrimEnd() + "`r`n"
}

function Set-CodexRecommendedDesktopFeatures {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$Content = ""
    )

    $next = Set-CodexTomlTableValues -Content $Content -TableName "features" -Values ([ordered]@{
        default_mode_request_user_input = "true"
        concurrent_reasoning_summaries = "true"
        prevent_idle_sleep = "true"
    })
    return Set-CodexTomlTableValues -Content $next -TableName "features.current_time_reminder" -Values ([ordered]@{
        enabled = "true"
        reminder_interval_seconds = "120"
        clock_source = '"system"'
        delivery_mode = '"after_user_or_tool_output"'
        sleep_tool = "false"
    })
}

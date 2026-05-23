import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface NativeWindowInfo {
    handle: number;
    title: string;
    className: string;
    processId: number;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface NativeInspectResult {
    source: "native-window";
    window: NativeWindowInfo | null;
    elements: Array<{
        name: string;
        automationId: string;
        controlType: string;
        className: string;
        enabled: boolean;
        offscreen: boolean;
        bounds: { x: number; y: number; width: number; height: number };
        patterns: string[];
    }>;
    metadata: {
        backend: "windows-uia";
        partial: boolean;
        note: string;
    };
}

export interface NativeInteractionResult {
    ok: boolean;
    action: string;
    message: string;
    target?: unknown;
    backendUsed?: string;
    fallbackUsed?: string;
}

function psString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function runPowerShellJson<T>(script: string, timeout = 15_000): Promise<T> {
    const utf8Script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${script}
`;
    const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", utf8Script],
        {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout,
            windowsHide: true,
        },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
        throw new Error(`PowerShell returned no JSON${stderr ? `: ${stderr.trim()}` : ""}`);
    }
    try {
        return JSON.parse(trimmed) as T;
    } catch (error) {
        throw new Error(`PowerShell JSON parse failed: ${error instanceof Error ? error.message : String(error)}\n${trimmed.slice(0, 1000)}`);
    }
}

const user32Type = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NativeWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
`;

function windowEnumerationScript(processId?: number): string {
    const pidFilter = processId && Number.isFinite(processId) ? `[uint32]${processId}` : "$null";
    return `
${user32Type}
$wantedPid = ${pidFilter}
$items = New-Object System.Collections.ArrayList
$callback = [NativeWin32+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$lparam)
  if (-not [NativeWin32]::IsWindowVisible($hwnd)) { return $true }
  $titleBuilder = New-Object System.Text.StringBuilder 1024
  [void][NativeWin32]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
  $title = $titleBuilder.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  [uint32]$procId = 0
  [void][NativeWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if ($wantedPid -ne $null -and $procId -ne $wantedPid) { return $true }
  $classBuilder = New-Object System.Text.StringBuilder 256
  [void][NativeWin32]::GetClassName($hwnd, $classBuilder, $classBuilder.Capacity)
  $rect = New-Object NativeWin32+RECT
  [void][NativeWin32]::GetWindowRect($hwnd, [ref]$rect)
  [void]$items.Add([pscustomobject]@{
    handle = $hwnd.ToInt64()
    title = $title
    className = $classBuilder.ToString()
    processId = [int]$procId
    bounds = [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = [Math]::Max(0, $rect.Right - $rect.Left)
      height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    }
  })
  return $true
}
[void][NativeWin32]::EnumWindows($callback, [IntPtr]::Zero)
$items | ConvertTo-Json -Depth 6
`;
}

export async function listNativeWindows(processId?: number): Promise<NativeWindowInfo[]> {
    const result = await runPowerShellJson<NativeWindowInfo[] | NativeWindowInfo | null>(windowEnumerationScript(processId));
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
}

export async function inspectNativeWindow(handle: number, maxElements = 120): Promise<NativeInspectResult> {
    const script = `
${user32Type}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$handle = [IntPtr]${Math.trunc(handle)}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($root -eq $null) {
  [pscustomobject]@{
    source = "native-window"
    window = $null
    elements = @()
    metadata = [pscustomobject]@{ backend = "windows-uia"; partial = $true; note = "AutomationElement.FromHandle returned null" }
  } | ConvertTo-Json -Depth 8
  exit 0
}
$rect = $root.Current.BoundingRectangle
$window = [pscustomobject]@{
  handle = $handle.ToInt64()
  title = $root.Current.Name
  className = $root.Current.ClassName
  processId = $root.Current.ProcessId
  bounds = [pscustomobject]@{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height }
}
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$items = New-Object System.Collections.ArrayList
$limit = [Math]::Min($all.Count, ${Math.max(1, Math.trunc(maxElements))})
for ($i = 0; $i -lt $limit; $i++) {
  $el = $all.Item($i)
  $r = $el.Current.BoundingRectangle
  $patterns = @()
  foreach ($p in @(
    [System.Windows.Automation.InvokePattern]::Pattern,
    [System.Windows.Automation.ValuePattern]::Pattern,
    [System.Windows.Automation.TextPattern]::Pattern,
    [System.Windows.Automation.SelectionItemPattern]::Pattern,
    [System.Windows.Automation.TogglePattern]::Pattern,
    [System.Windows.Automation.ExpandCollapsePattern]::Pattern
  )) {
    $obj = $null
    if ($el.TryGetCurrentPattern($p, [ref]$obj)) { $patterns += $p.ProgrammaticName }
  }
  [void]$items.Add([pscustomobject]@{
    name = $el.Current.Name
    automationId = $el.Current.AutomationId
    controlType = $el.Current.ControlType.ProgrammaticName
    className = $el.Current.ClassName
    enabled = $el.Current.IsEnabled
    offscreen = $el.Current.IsOffscreen
    bounds = [pscustomobject]@{ x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height }
    patterns = $patterns
  })
}
[pscustomobject]@{
  source = "native-window"
  window = $window
  elements = $items
  metadata = [pscustomobject]@{
    backend = "windows-uia"
    partial = ($all.Count -gt $limit)
    note = "Windows UI Automation exposes native controls when the target app implements accessibility peers."
  }
} | ConvertTo-Json -Depth 10
`;
    return await runPowerShellJson<NativeInspectResult>(script, 20_000);
}

export async function screenshotNativeWindow(handle: number, outputPath: string): Promise<{ path: string; method: string; ok: boolean }> {
    const script = `
${user32Type}
Add-Type -AssemblyName System.Drawing
$handle = [IntPtr]${Math.trunc(handle)}
$out = ${psString(outputPath)}
$rect = New-Object NativeWin32+RECT
if (-not [NativeWin32]::GetWindowRect($handle, [ref]$rect)) { throw "GetWindowRect failed" }
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$printed = [NativeWin32]::PrintWindow($handle, $hdc, 0)
$graphics.ReleaseHdc($hdc)
if (-not $printed) {
  $graphics.Dispose()
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
}
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[pscustomobject]@{ path = $out; method = $(if ($printed) { "PrintWindow" } else { "CopyFromScreen" }); ok = (Test-Path $out) } | ConvertTo-Json -Depth 3
`;
    return await runPowerShellJson<{ path: string; method: string; ok: boolean }>(script, 20_000);
}

export async function interactNativeWindow(params: {
    handle: number;
    action: "click" | "type" | "press";
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    name?: string;
    automationId?: string;
}): Promise<NativeInteractionResult> {
    const targetFilters: string[] = [];
    if (params.automationId) {
        targetFilters.push(`$el.Current.AutomationId -eq ${psString(params.automationId)}`);
    }
    if (params.name) {
        targetFilters.push(`$el.Current.Name -like ${psString(`*${params.name}*`)}`);
    }
    const targetCondition = targetFilters.length > 0 ? targetFilters.join(" -and ") : "$false";
    const text = params.text ?? "";
    const key = params.key ?? "";
    const script = `
${user32Type}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$handle = [IntPtr]${Math.trunc(params.handle)}
[void][NativeWin32]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 120
$action = ${psString(params.action)}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$target = $null
if ($root -ne $null) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    if (${targetCondition}) { $target = $el; break }
  }
  if ($target -eq $null -and $action -eq "type") {
    foreach ($el in $all) {
      $valueProbe = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valueProbe)) { $target = $el; break }
      if ($el.Current.ControlType.ProgrammaticName -match "Edit|Document") { $target = $el; break }
    }
  }
}
if ($target -ne $null) {
  if ($action -eq "click") {
    $invoke = $null
    if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
      $invoke.Invoke()
      [pscustomobject]@{ ok = $true; action = $action; message = "Invoked target through UI Automation"; target = $target.Current.Name; backendUsed = "windows-uia"; fallbackUsed = $null } | ConvertTo-Json -Depth 4
      exit 0
    }
    $target.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    [pscustomobject]@{ ok = $true; action = $action; message = "Focused target and sent ENTER"; target = $target.Current.Name; backendUsed = "windows-uia"; fallbackUsed = "sendkeys" } | ConvertTo-Json -Depth 4
    exit 0
  }
  if ($action -eq "type") {
    $value = $null
    if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
      $value.SetValue(${psString(text)})
      [pscustomobject]@{ ok = $true; action = $action; message = "Set target value through UI Automation"; target = $target.Current.Name; backendUsed = "windows-uia"; fallbackUsed = $null } | ConvertTo-Json -Depth 4
      exit 0
    }
    $target.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait(${psString(text)})
    [pscustomobject]@{ ok = $true; action = $action; message = "Focused target and sent text"; target = $target.Current.Name; backendUsed = "windows-uia"; fallbackUsed = "sendkeys" } | ConvertTo-Json -Depth 4
    exit 0
  }
}
if ($action -eq "type" -and $root -ne $null) {
  $root.SetFocus()
  [System.Windows.Forms.SendKeys]::SendWait(${psString(text)})
  [pscustomobject]@{ ok = $true; action = $action; message = "Focused root window and sent text"; target = $root.Current.Name; backendUsed = "windows-uia"; fallbackUsed = "sendkeys-root" } | ConvertTo-Json -Depth 4
  exit 0
}
if ($action -eq "click" -and ${Number.isFinite(params.x) && Number.isFinite(params.y) ? "$true" : "$false"}) {
  [NativeWin32]::SetCursorPos(${Math.trunc(params.x ?? 0)}, ${Math.trunc(params.y ?? 0)})
  [NativeWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [NativeWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  [pscustomobject]@{ ok = $true; action = $action; message = "Clicked absolute screen coordinates"; target = $null; backendUsed = "user32"; fallbackUsed = "coordinate-click" } | ConvertTo-Json -Depth 4
  exit 0
}
if ($action -eq "press") {
  [System.Windows.Forms.SendKeys]::SendWait(${psString(key)})
  [pscustomobject]@{ ok = $true; action = $action; message = "Sent key sequence"; target = $null; backendUsed = "sendkeys"; fallbackUsed = "sendkeys" } | ConvertTo-Json -Depth 4
  exit 0
}
[pscustomobject]@{ ok = $false; action = $action; message = "No matching native target and no coordinate fallback"; target = $null; backendUsed = "windows-uia"; fallbackUsed = $null } | ConvertTo-Json -Depth 4
`;
    return await runPowerShellJson<NativeInteractionResult>(script, 20_000);
}

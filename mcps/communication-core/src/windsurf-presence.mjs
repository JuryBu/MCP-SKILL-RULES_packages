import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoreError } from "./contracts.mjs";

const executeFile = promisify(execFile);
const SCRIPT = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $items=@(Get-CimInstance Win32_Process -Filter \"Name='Windsurf.exe' OR Name='language_server_windows_x64.exe'\" | Where-Object {$_.Name -eq 'Windsurf.exe' -or $_.ExecutablePath -like '*Windsurf*' -or $_.CommandLine -like '*windsurf*'}); [PSCustomObject]@{count=$items.Count} | ConvertTo-Json -Compress";

export function createWindsurfPresenceReader({ execute = executeFile } = {}) {
  if (typeof execute !== "function") throw new CoreError("invalid_config", "WSF进程状态读取器配置无效");
  return {
    source: "windsurf_process_presence_without_ls_attachment",
    configured_delivery_modes: { next_model_boundary: false, when_idle: false },
    async getHostStatus(target, { signal } = {}) {
      signal?.throwIfAborted();
      try {
        const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
          signal, windowsHide: true, timeout: 8000, maxBuffer: 32768, encoding: "utf8",
        });
        signal?.throwIfAborted();
        const value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
        if (!Number.isSafeInteger(value?.count) || value.count < 0 || value.count > 256) throw new Error();
        return value.count === 0 ? { host_online: false, code: "ls_process_not_found" }
          : { host_online: "unknown", code: "ls_host_unavailable" };
      } catch {
        throw new CoreError("ls_discovery_failed", "WSF进程状态读取尚未取得准确结果");
      }
    },
    async describeConversation() {
      return { conversation_exists: "unknown", conversation_running: "unknown", code: "ls_target_unavailable" };
    },
  };
}

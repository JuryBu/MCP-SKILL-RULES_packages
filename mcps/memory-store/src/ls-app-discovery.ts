import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LsProcessInfo } from "./ls-rpc.js";

export interface AppLsProcessSnapshot {
    pid: number;
    name: string;
    executablePath: string;
    ports: number[];
}

export function validateAppLsHub(hub: any, fileName: string, processes: AppLsProcessSnapshot[]): LsProcessInfo | null {
    const { pid, httpPort, csrfToken } = hub ?? {};
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null;
    if (fileName !== `hub_${httpPort}.json` || typeof csrfToken !== "string" || !csrfToken.trim() || /[\r\n]/u.test(csrfToken)) return null;
    const processInfo = processes.find(entry => entry.pid === pid && /^language_server(?:_windows_x64)?\.exe$/iu.test(entry.name)
        && /(?:^|[\\/])\.?antigravity(?:[-_. ][^\\/]*)?(?:[\\/]|$)/iu.test(entry.executablePath) && entry.ports.includes(httpPort));
    return processInfo ? { pid, csrfToken, workspaceId: "", ports: [httpPort], transport: "app" } : null;
}

export function discoverAppLsProcesses(): LsProcessInfo[] {
    if (process.platform !== "win32") return [];
    const directory = path.join(os.homedir(), ".gemini", "antigravity", "daemon");
    try {
        const files = fs.readdirSync(directory).filter(name => /^hub_\d+\.json$/u.test(name));
        if (!files.length) return [];
        const script = [
            "$ProgressPreference='SilentlyContinue'",
            "$items=@(Get-CimInstance Win32_Process -Filter \"Name='language_server.exe' OR Name='language_server_windows_x64.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {",
            "if ($_.ExecutablePath -match 'Antigravity') { $processId=$_.ProcessId; $ports=@(Get-NetTCPConnection -OwningProcess $processId -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') } | Select-Object -ExpandProperty LocalPort); [PSCustomObject]@{pid=$processId;name=$_.Name;executablePath=$_.ExecutablePath;ports=$ports} }",
            "}); ConvertTo-Json -InputObject $items -Compress -Depth 4",
        ].join("\n");
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 7000, windowsHide: true });
        const processes: AppLsProcessSnapshot[] = JSON.parse(output.replace(/^\uFEFF/u, ""));
        const results = files.flatMap(fileName => {
            try {
                const hub = JSON.parse(fs.readFileSync(path.join(directory, fileName), "utf8").replace(/^\uFEFF/u, ""));
                const validated = validateAppLsHub(hub, fileName, processes);
                return validated ? [validated] : [];
            } catch { return []; }
        });
        return results.filter((entry, index) => results.findIndex(other => other.pid === entry.pid && other.ports[0] === entry.ports[0]) === index);
    } catch { return []; }
}

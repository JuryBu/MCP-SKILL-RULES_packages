import path from "node:path";

const qqName = /^(?:qq|qqnt|qqex)(?:\.exe)?$/i;
const treeName = /^(?:qq|qqnt|qqex|cmd|node|napcatwinbootmain)(?:\.exe)?$/i;
const normalizePath = (value) => String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const canonicalPath = (value) => {
  const input = String(value ?? "");
  if (!input.trim() || /["<>|?*:\x00-\x1f]/.test(input.replace(/^[a-z]:/i, ""))) return "";
  return normalizePath(path.win32.normalize(input));
};
const field = (record, upper, lower) => record?.[upper] ?? record?.[lower];
const pidOf = (record) => Number(field(record, "ProcessId", "processId") ?? record?.pid);
const parentOf = (record) => Number(field(record, "ParentProcessId", "parentProcessId") ?? record?.parentPid);

function birth(record) {
  const value = field(record, "CreationDate", "creationDate");
  const dotnet = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(String(value));
  if (dotnet) return BigInt(dotnet[1]) * 1000n;
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(value));
  if (!iso) return null;
  const milliseconds = Date.parse(iso[1] + iso[3]);
  return Number.isFinite(milliseconds)
    ? BigInt(milliseconds) * 1000n + BigInt((iso[2] ?? "").padEnd(6, "0").slice(0, 6))
    : null;
}

function containsPath(command, target) {
  const escaped = normalizePath(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(escaped && new RegExp(`(?:^|["'\\s=])${escaped}(?=$|["'\\s<>])`, "i").test(command));
}

function commandEntry(command) {
  const match = /^(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/.exec(command);
  return { executable: match?.[1] ?? match?.[2] ?? "", arguments: match?.[3] ?? "" };
}

function ownRoot(record, root, markUnknown) {
  if (!root) return false;
  const name = String(field(record, "Name", "name") ?? "");
  const command = normalizePath(field(record, "CommandLine", "commandLine"));
  const rawExecutable = String(field(record, "ExecutablePath", "executablePath") ?? "");
  const entryPath = (value) => {
    const result = canonicalPath(value);
    if (String(value ?? "").trim() && !result) markUnknown();
    return result;
  };
  const executable = canonicalPath(rawExecutable);
  if (rawExecutable.trim() && !executable && /^(?:qq|qqnt|qqex|cmd|node|napcatwinbootmain|powershell|pwsh)(?:\.exe)?$/i.test(name)) markUnknown();
  if (/^napcatwinbootmain\.exe$/i.test(name)) {
    const commandExecutable = entryPath(commandEntry(command).executable);
    return executable === `${root}/napcatwinbootmain.exe`
      || (!rawExecutable.trim() && commandExecutable === `${root}/napcatwinbootmain.exe`);
  }
  if (/^cmd(?:\.exe)?$/i.test(name)) {
    const argumentsText = commandEntry(command).arguments;
    const rawInvocation = /^(?:(?:\/d|\/s|\/q)\s+)*\/[ck]\s+(?:call\s+)?(.+)$/i.exec(argumentsText)?.[1] ?? "";
    let canonicalEntry = canonicalPath(commandEntry(rawInvocation.replace(/^"+/, '"')).executable);
    if (!canonicalEntry && rawInvocation.startsWith('"') && rawInvocation.endsWith('"') && rawInvocation.length > 1) {
      canonicalEntry = canonicalPath(commandEntry(rawInvocation.slice(1, -1)).executable);
    }
    const entries = ["launcher-user.bat", "napcat.bat", "napcatwinbootmain.exe"].map((entry) => `${root}/${entry}`);
    if (entries.includes(canonicalEntry)) return true;
    if ((!canonicalEntry || rawInvocation.startsWith('"'))
      && (rawInvocation.includes(`${root}/`) || entries.some((entry) => containsPath(rawInvocation, entry)))) markUnknown();
    return false;
  }
  if (/^node(?:\.exe)?$/i.test(name)) {
    let argumentsText = commandEntry(command).arguments;
    while (/^--(?:inspect(?:-brk)?(?:=\S+)?|no-warnings|trace-warnings|enable-source-maps)(?:\s|$)/.test(argumentsText)) {
      argumentsText = commandEntry(argumentsText).arguments;
    }
    const entry = entryPath(commandEntry(argumentsText).executable);
    return ["index.js", "napcat.mjs", "napcat/napcat.mjs"]
      .some((script) => entry === `${root}/${script}`);
  }
  if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(name)) {
    return /(?:^|\s)-(?:file|f)\s+"?[^"\r\n]*\/start-napcat-login\.ps1(?:["\s]|$)/i.test(command)
      && !/(?:^|\s)-(?:command|c|encodedcommand|enc|e)(?:\s|$)/i.test(command)
      && containsPath(command, root);
  }
  return false;
}

export function classifyNapCatProcesses(processes, napcatRoot) {
  if (!Array.isArray(processes)) throw new Error("NAPCAT_PROCESS_SCAN_UNKNOWN: invalid process snapshot");
  if (processes.some((record) => !record || !String(field(record, "Name", "name") ?? "").trim())) {
    throw new Error("NAPCAT_PROCESS_SCAN_UNKNOWN: missing process names");
  }
  const root = napcatRoot ? normalizePath(path.win32.isAbsolute(napcatRoot) ? path.win32.normalize(napcatRoot) : path.resolve(napcatRoot)) : "";
  if (String(napcatRoot ?? "").trim() && !canonicalPath(napcatRoot)) throw new Error("NAPCAT_PROCESS_SCAN_UNKNOWN: invalid NapCat root");
  const records = processes.filter((record) => record && Number.isSafeInteger(pidOf(record)) && pidOf(record) > 0);
  const byPid = new Map(records.map((record) => [pidOf(record), record]));
  const owned = new Set();
  const ordinary = new Set();
  const uncertain = new Set();
  for (const record of records) {
    const name = String(field(record, "Name", "name") ?? "");
    let invalidPath = false;
    const modules = record.ModulePaths ?? record.modulePaths ?? [];
    const hook = qqName.test(name) && (record.ModuleScanState ?? record.moduleScanState) === "ok" && Array.isArray(modules) && modules.some((modulePath) => {
      const normalized = canonicalPath(modulePath);
      if (String(modulePath ?? "").trim() && !normalized) invalidPath = true;
      return root && normalized === `${root}/napcatwinboothook.dll`;
    });
    if (ownRoot(record, root, () => { invalidPath = true; }) || hook) owned.add(pidOf(record));
    else if (invalidPath) uncertain.add(pidOf(record));
    else if (/^napcatwinbootmain\.exe$/i.test(name)
      && (!field(record, "ExecutablePath", "executablePath") || !field(record, "CommandLine", "commandLine"))) uncertain.add(pidOf(record));
  }
  const linked = (record, parent) => parent && birth(record) !== null
    && birth(parent) !== null && birth(parent) <= birth(record) && pidOf(parent) !== pidOf(record);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!owned.has(pidOf(record)) && !uncertain.has(pidOf(record)) && uncertain.has(parentOf(record))
        && treeName.test(String(field(record, "Name", "name") ?? ""))) {
        uncertain.add(pidOf(record));
        changed = true;
      }
      if (!owned.has(pidOf(record)) && treeName.test(String(field(record, "Name", "name") ?? ""))
        && owned.has(parentOf(record)) && linked(record, byPid.get(parentOf(record)))) {
        owned.add(pidOf(record));
        changed = true;
      }
    }
  }
  for (const record of records) {
    const command = String(field(record, "CommandLine", "commandLine") ?? "");
    const state = record.ModuleScanState ?? record.moduleScanState;
    if (qqName.test(String(field(record, "Name", "name") ?? "")) && !owned.has(pidOf(record))
      && state === "ok" && command.trim() && !/\s--type(?:=|\s)/i.test(command)
      && birth(record) !== null && !uncertain.has(pidOf(record))
      && !/(?:^|\s)-q(?:\s|$)|loadnapcat|napcatwinboothook/i.test(command)) ordinary.add(pidOf(record));
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!ordinary.has(pidOf(record)) && !owned.has(pidOf(record)) && !uncertain.has(pidOf(record))
        && qqName.test(String(field(record, "Name", "name") ?? ""))
        && ordinary.has(parentOf(record)) && linked(record, byPid.get(parentOf(record)))
        && (record.ModuleScanState ?? record.moduleScanState) === "ok") {
        ordinary.add(pidOf(record));
        changed = true;
      }
    }
  }
  return {
    owned: records.filter((record) => owned.has(pidOf(record))),
    ordinary: records.filter((record) => ordinary.has(pidOf(record))),
    unknown: records.filter((record) => uncertain.has(pidOf(record))
      || (qqName.test(String(field(record, "Name", "name") ?? ""))
        && !owned.has(pidOf(record)) && !ordinary.has(pidOf(record)))),
  };
}

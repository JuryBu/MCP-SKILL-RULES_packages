import path from "node:path";

export function windowsPowerShellEnvironment(parentEnvironment = process.env) {
  const systemRoot = parentEnvironment.SystemRoot ?? parentEnvironment.SYSTEMROOT ?? "C:\\Windows";
  const home = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const environment = { ...parentEnvironment };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  environment.PSModulePath = path.win32.join(home, "Modules");
  return { executable: path.win32.join(home, "powershell.exe"), environment, modulesPath: environment.PSModulePath };
}

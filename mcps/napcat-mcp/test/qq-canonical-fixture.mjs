import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const escaped = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function createQqCanonicalFixture({ root, installedRoot, stateRoot, ownerShell, sourceRoot }) {
  const inputRoot = path.join(root, "qq-input");
  fs.mkdirSync(inputRoot);
  const files = [];
  const save = (name, bytes) => {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    fs.writeFileSync(path.join(inputRoot, name), content);
    const entry = { path: name, bytes: content.length, sha256: digest(content) };
    files.push(entry);
    return entry;
  };
  const targets = { login: path.join(installedRoot, "ops", "start-napcat-login.ps1"), recovery: path.join(installedRoot, "ops", "start-napcat-account-recovery.ps1"),
    wrapper: path.join(installedRoot, "ops", "Start-QqThenExistingWatchdog.ps1"), deployment: path.join(stateRoot, "deployment.json"), plan: path.join(stateRoot, "startup-ps7.json") };
  if (fs.existsSync(targets.recovery)) fs.unlinkSync(targets.recovery);
  if (fs.existsSync(targets.wrapper)) fs.unlinkSync(targets.wrapper);
  const candidateBytes = { login: Buffer.from("param()\n'candidate fixture login'\n"), recovery: Buffer.from("param()\n'candidate fixture recovery'\n"),
    wrapper: Buffer.from("param()\n'candidate fixture wrapper'\n"), deployment: Buffer.from(JSON.stringify({ state: "active", fixture: true })) };
  const watchdogPath = path.join(installedRoot, "ops", "Run-NapCatSupervisorWatchdog.ps1");
  const watchdogBytes = fs.readFileSync(path.join(sourceRoot, "ops", "Run-NapCatSupervisorWatchdog.ps1"));
  const plan = { schema: "qq.fixed-ps7-startup/v1", state: "active", ps7Path: ownerShell,
    inputs: [{ path: watchdogPath, sha256: digest(watchdogBytes) }, ...["login", "recovery", "wrapper"].map(name => ({ path: targets[name], sha256: digest(candidateBytes[name]) }))] };
  candidateBytes.plan = Buffer.from(JSON.stringify(plan));
  const qq5Mappings = Object.entries(targets).map(([name, target]) => {
    const originalExists = fs.existsSync(target);
    const original = originalExists ? save(`${name}.original.bin`, fs.readFileSync(target)) : null;
    return { name, target, originalExists, originalSha256: original?.sha256 ?? null, originalSddl: null, original,
      candidate: save(`${name}.candidate.bin`, candidateBytes[name]) };
  });
  const action = { execute: ownerShell, arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "${targets.wrapper}" -PlanPath "${targets.plan}" -PlanSha256 ${digest(candidateBytes.plan)}`, workingDirectory: installedRoot };
  const xml = exec => `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.2"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Enabled>true</Enabled></Settings><Actions Context="Author">${exec}</Actions></Task>`;
  const originalXml = save("original.xml", xml("<Exec><Command>fixture-old.exe</Command><Arguments>fixture only</Arguments></Exec>"));
  const proposedText = xml(`<Exec><Command>${escaped(action.execute)}</Command><Arguments>${escaped(action.arguments)}</Arguments><WorkingDirectory>${escaped(action.workingDirectory)}</WorkingDirectory></Exec>`);
  const proposedXml = save("candidate.xml", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(proposedText, "utf16le")]));
  const manifest = { schemaVersion: 1, kind: "PrivateCanonicalReadonlyInputNotInstallable", qq5Mappings,
    task: { name: "CodexNapCatSupervisor", originalXml, proposedXml, liveReadonly: { sddl: "fixture-only" } },
    sharedWatchdogTransition: { target: watchdogPath, baselineSha256: digest(fs.readFileSync(watchdogPath)), candidateSha256: digest(watchdogBytes) }, files };
  const manifestPath = path.join(inputRoot, "canonical.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { qqCanonicalManifestPath: manifestPath, qqCanonicalManifestSha256: digest(fs.readFileSync(manifestPath)), qqStateRoot: stateRoot };
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexThreadBridge } from "../src/codex-thread-bridge.mjs";
import { createTaskRegistry } from "../src/task-registry.mjs";
import {
  buildRearmWakePrompt,
  createStaleSentWakeRearmPlan,
  sha256,
  verifyRearmedTask,
} from "../src/stale-sent-wake-rearm.mjs";

function parseArguments(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`未知参数：${token}`);
    const name = token.slice(2);
    if (["prepare", "execute", "confirm-codex-idle", "confirm-zero-business-processes"].includes(name)) {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} 缺少值`);
    values[name] = value;
    index += 1;
  }
  return { values, flags };
}

function required(values, name) {
  const value = values[name]?.trim();
  if (!value) throw new Error(`--${name} 不能为空`);
  return value;
}

function readBuffer(filePath) {
  return fs.readFileSync(filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
}

function writeJson(filePath, value) {
  atomicWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function fileSnapshot(paths) {
  return Object.fromEntries(Object.entries(paths).map(([name, filePath]) => {
    const buffer = readBuffer(filePath);
    return [name, { path: filePath, bytes: buffer.length, sha256: sha256(buffer) }];
  }));
}

function updateMaintenance(filePath, value) {
  const current = fs.existsSync(filePath) ? readJson(filePath) : { schemaVersion: 1, reasons: {} };
  const reasons = current.reasons && typeof current.reasons === "object" ? { ...current.reasons } : {};
  if (value === null) delete reasons.staleSentWakeRearm;
  else reasons.staleSentWakeRearm = value;
  if (Object.keys(reasons).length) writeJson(filePath, { schemaVersion: 1, reasons, updatedAt: new Date().toISOString() });
  else fs.rmSync(filePath, { force: true });
}

function validateRuntime(runtime, plan) {
  if (runtime.state !== "running" || runtime.inFlightScan || runtime.lastError !== null || runtime.maintenance !== null) {
    throw new Error(`router 状态不安全：${JSON.stringify({ state: runtime.state, inFlightScan: runtime.inFlightScan, lastError: runtime.lastError, maintenance: runtime.maintenance })}`);
  }
  if (plan.routerPid !== runtime.pid || plan.routerStartedAt !== runtime.startedAt) {
    throw new Error("router 身份已变化");
  }
}

function createPlan(options) {
  const registryState = readJson(options.registry);
  const runtime = readJson(options.runtimeState);
  const plan = createStaleSentWakeRearmPlan({
    state: registryState,
    taskId: options.taskId,
    expectedGeneration: options.expectedGeneration,
    expectedConversationId: options.expectedConversationId,
    preparedAt: new Date().toISOString(),
  });
  validateRuntime(runtime, { routerPid: runtime.pid, routerStartedAt: runtime.startedAt });
  return {
    schemaVersion: 1,
    preparedAt: plan.preparedAt,
    taskId: plan.taskId,
    expectedGeneration: plan.expectedGeneration,
    expectedConversationId: plan.expectedConversationId,
    expectedPendingSeqs: plan.expectedPendingSeqs,
    expectedActiveWakeIds: plan.expectedActiveWakeIds,
    expectedLatestWakeId: plan.expectedLatestWakeId,
    before: plan.before,
    files: fileSnapshot({ registry: options.registry, dedupe: options.dedupe, log: options.log }),
    routerPid: runtime.pid,
    routerStartedAt: runtime.startedAt,
  };
}

function rehydratePlan(state, storedPlan) {
  return createStaleSentWakeRearmPlan({
    state,
    taskId: storedPlan.taskId,
    expectedGeneration: storedPlan.expectedGeneration,
    expectedConversationId: storedPlan.expectedConversationId,
    expectedPendingSeqs: storedPlan.expectedPendingSeqs,
    expectedActiveWakeIds: storedPlan.expectedActiveWakeIds,
    expectedLatestWakeId: storedPlan.expectedLatestWakeId,
    preparedAt: storedPlan.preparedAt,
  });
}

function verifyFileSnapshot(storedPlan, paths) {
  const current = fileSnapshot(paths);
  for (const name of Object.keys(paths)) {
    if (current[name].sha256 !== storedPlan.files[name].sha256 || current[name].bytes !== storedPlan.files[name].bytes) {
      throw new Error(`${name} 文件已变化，拒绝执行`);
    }
  }
}

export function createBackup(storedPlan, paths, backupRoot) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
  const backupPath = path.join(backupRoot, `stale-sent-wake-rearm-${stamp}`);
  fs.mkdirSync(backupPath, { recursive: false });
  for (const [name, sourcePath] of Object.entries(paths)) fs.copyFileSync(sourcePath, path.join(backupPath, `${name}.backup`));
  writeJson(path.join(backupPath, "plan.json"), storedPlan);
  return backupPath;
}

export function restoreBackup(paths, backupPath) {
  for (const name of Object.keys(paths)) atomicWrite(paths[name], readBuffer(path.join(backupPath, `${name}.backup`)));
}

function proxyBridgeOptions(options) {
  const stateRoot = path.dirname(options.registry);
  const runtimePath = path.join(stateRoot, "codex-app-server-proxy-runtime.json");
  const tokenFilePath = path.join(stateRoot, "codex-app-server-proxy-token.txt");
  if (!fs.existsSync(runtimePath) || !fs.existsSync(tokenFilePath)) throw new Error("缺少 Codex app-server proxy 运行文件");
  const runtime = readJson(runtimePath);
  return {
    mode: "transparent_proxy",
    controlUrl: runtime.controlUrl ?? "http://127.0.0.1:18431",
    tokenFilePath,
    bindingPath: options.binding,
    cwd: path.dirname(options.binding),
    env: { ...process.env, NAPCAT_MCP_BINDING_PATH: options.binding },
  };
}

async function executePlan(options, storedPlan) {
  const paths = { registry: options.registry, dedupe: options.dedupe, log: options.log };
  verifyFileSnapshot(storedPlan, paths);
  validateRuntime(readJson(options.runtimeState), storedPlan);
  const backupPath = createBackup(storedPlan, paths, options.backupRoot);
  const maintenance = { taskId: storedPlan.taskId, planPath: options.planPath, startedAt: new Date().toISOString() };
  let bridge;
  let registry;
  let rearmResult;
  let wakeAccepted = false;
  try {
    updateMaintenance(options.maintenanceFile, maintenance);
    verifyFileSnapshot(storedPlan, paths);
    validateRuntime(readJson(options.runtimeState), storedPlan);
    const currentState = readJson(options.registry);
    const plan = rehydratePlan(currentState, storedPlan);
    const messages = plan.before.pending.map((message) => ({ messageSeq: message.messageSeq, messageAt: message.messageAt }));
    const wakeId = crypto.randomUUID();
    const prompt = buildRearmWakePrompt(plan.before, messages, wakeId);
    const promptSha256 = sha256(Buffer.from(prompt, "utf8"));
    registry = createTaskRegistry({ statePath: options.registry });
    rearmResult = registry.rearmStaleSentWakes({
      taskId: storedPlan.taskId,
      expectedGeneration: storedPlan.expectedGeneration,
      expectedConversationId: storedPlan.expectedConversationId,
      expectedPendingSeqs: storedPlan.expectedPendingSeqs,
      expectedActiveWakeIds: storedPlan.expectedActiveWakeIds,
      expectedLatestWakeId: storedPlan.expectedLatestWakeId,
      preparedAt: storedPlan.preparedAt,
      newWakeId: wakeId,
      promptSha256,
    });
    writeJson(path.join(backupPath, "archived-wakes.json"), rearmResult.archivedWakes);
    bridge = createCodexThreadBridge(proxyBridgeOptions(options));
    const wake = await bridge.wake({
      threadId: storedPlan.expectedConversationId,
      prompt,
      wakeId,
      taskId: storedPlan.taskId,
      generation: storedPlan.expectedGeneration,
      localRole: plan.before.localRole,
      sourceMachine: plan.before.sourceMachine,
      targetMachine: plan.before.targetMachine,
      trustedPeerQq: plan.before.trustedPeerQq,
      pendingMessageSeqs: storedPlan.expectedPendingSeqs,
      newMessageSeqs: storedPlan.expectedPendingSeqs,
      pendingThroughSequence: storedPlan.expectedPendingSeqs.at(-1),
      pendingThroughTime: messages.at(-1).messageAt,
      promptSha256,
    });
    if (!["accepted", "completed"].includes(wake.outcome)) throw new Error(`新 wake 未被接纳：${wake.outcome}`);
    wakeAccepted = true;
    registry.confirmWakeSent({
      taskId: storedPlan.taskId,
      expectedGeneration: storedPlan.expectedGeneration,
      expectedWakeSentAt: rearmResult.wakeSentAt,
      expectedWakeId: wakeId,
    });
    const verification = verifyRearmedTask(registry.get(storedPlan.taskId), plan, wakeId);
    updateMaintenance(options.maintenanceFile, null);
    return { ok: true, backupPath, wake, verification, filesAfter: fileSnapshot(paths) };
  } catch (error) {
    try {
      updateMaintenance(options.maintenanceFile, maintenance);
      if (rearmResult && !wakeAccepted) {
        registry.rollbackStaleSentWakeRearm({
          taskId: storedPlan.taskId,
          expectedGeneration: storedPlan.expectedGeneration,
          expectedPendingSeqs: storedPlan.expectedPendingSeqs,
          newWakeId: rearmResult.wakeId,
          rollback: rearmResult.rollback,
        });
        const restoredRegistry = readBuffer(options.registry);
        const originalRegistry = readBuffer(path.join(backupPath, "registry.backup"));
        if (!restoredRegistry.equals(originalRegistry)) throw new Error("registry 回滚后未恢复原始字节");
        restoreBackup({ dedupe: paths.dedupe, log: paths.log }, backupPath);
      } else if (!rearmResult) {
        restoreBackup(paths, backupPath);
      } else {
        throw new Error("新 wake 已被接纳，禁止回滚造成重复注入");
      }
      updateMaintenance(options.maintenanceFile, null);
    } catch (rollbackError) {
      error.rollbackError = { message: rollbackError.message };
    }
    throw Object.assign(error, { backupPath });
  } finally {
    await bridge?.close?.();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, flags } = parseArguments(argv);
  const options = {
    registry: path.resolve(required(values, "registry")),
    dedupe: path.resolve(required(values, "dedupe")),
    log: path.resolve(required(values, "log")),
    runtimeState: path.resolve(required(values, "runtime-state")),
    maintenanceFile: path.resolve(required(values, "maintenance-file")),
    binding: path.resolve(required(values, "binding")),
    planPath: path.resolve(required(values, "plan")),
    backupRoot: path.resolve(required(values, "backup-root")),
    taskId: required(values, "task-id"),
    expectedGeneration: Number(required(values, "expected-generation")),
    expectedConversationId: required(values, "expected-conversation-id"),
  };
  if (flags.has("prepare") === flags.has("execute")) throw new Error("必须且只能指定 --prepare 或 --execute");
  if (flags.has("prepare")) {
    const plan = createPlan(options);
    writeJson(options.planPath, plan);
    return { ok: true, mode: "prepare", planPath: options.planPath, plan };
  }
  if (!flags.has("confirm-codex-idle") || !flags.has("confirm-zero-business-processes")) {
    throw new Error("execute 必须显式确认 Codex idle 与业务进程为 0");
  }
  const storedPlan = readJson(options.planPath);
  return executePlan(options, storedPlan);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? "UNEXPECTED_ERROR", message: error.message, details: error.details ?? null, backupPath: error.backupPath ?? null, rollbackError: error.rollbackError ?? null }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

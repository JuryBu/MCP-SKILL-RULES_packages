import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createCodexCommunicationControl } from "./codex-communication-control.mjs";
import { createCodexCommunicationTransport, hasCommunicationProjection, rememberCommunicationProjectionClient,
  transferCommunicationProjection, readProxyWakeVisibilityRevision, releaseProxyWakeJournalReader } from "./codex-communication-transport.mjs";

export function communicationWriterFingerprint(configPath, expectedConfigurationSha256) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)
    || !/^[a-f0-9]{64}$/u.test(expectedConfigurationSha256 ?? "")) {
    throw Object.assign(new Error("Communication handoff requires a pinned configuration"), { code: "COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED" });
  }
  const file = fs.realpathSync(configPath);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) {
    throw Object.assign(new Error("Communication handoff configuration is not a bounded file"), { code: "COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED" });
  }
  const bytes = fs.readFileSync(file);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedConfigurationSha256) {
    throw Object.assign(new Error("Communication handoff configuration differs from its binding"), { code: "COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED" });
  }
  const config = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const fields = Object.keys(config).filter(key => key !== "thread_read").sort();
  const shared = Object.fromEntries(fields.map(key => [key, config[key]]));
  return crypto.createHash("sha256").update(JSON.stringify(shared)).digest("hex");
}
import { createLiveCodexThreadReader } from "./codex-thread-read.mjs";
import { createNativeReadObservation } from "./native-read-observation.mjs";
import { sourceNativeReadObservationApproval } from "./codex-communication-read-approval.mjs";

function observationThreadId(config, binding, approval, consumed) {
  if (!Object.hasOwn(config, "native_observation_thread_id")) return null;
  if (approval?.singleUse === true && consumed) {
    throw Object.assign(new Error("Source正文试点单次许可已作废"), { code: "COMMUNICATION_THREAD_READ_OBSERVATION_ALREADY_USED" });
  }
  const threadId = config.native_observation_thread_id;
  const manifestValid = !Object.hasOwn(approval ?? {}, "manifestSha256") || approval.manifestSha256 === undefined
    ? true
    : (/^[a-f0-9]{64}$/u.test(approval.manifestSha256 ?? "") && binding?.manifest_sha256 === approval.manifestSha256);
  if (typeof threadId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(threadId)
    || threadId !== approval?.threadId || !config.thread_ids.includes(threadId)
    || !binding || !/^[a-f0-9]{64}$/u.test(approval?.configurationSha256 ?? "")
    || binding.configuration_sha256 !== approval.configurationSha256
    || !manifestValid) {
    throw Object.assign(new Error("Source正文试点配置未经批准"), { code: "COMMUNICATION_THREAD_READ_OBSERVATION_NOT_APPROVED" });
  }
  return threadId;
}

function configuredThreadRead(config, proxy, transport, binding, approval, receiveTokenBytes, consumed) {
  if (config === undefined) return undefined;
  if (!config || typeof config !== "object" || Array.isArray(config)
    || Object.keys(config).some(key => !["token_file", "list", "list_scope", "thread_ids", "native_observation_thread_id"].includes(key))
    || !path.isAbsolute(config.token_file ?? "") || typeof config.list !== "boolean"
    || (config.list_scope !== undefined && !["allowed_threads", "current_account"].includes(config.list_scope))
    || (config.list_scope === "current_account" && !config.list)
    || !Array.isArray(config.thread_ids) || config.thread_ids.length > 50
    || config.thread_ids.some(id => typeof id !== "string" || !id || id.length > 512 || /[\u0000-\u001f]/u.test(id))
    || new Set(config.thread_ids).size !== config.thread_ids.length) throw new Error("COMMUNICATION_THREAD_READ_CONFIGURATION_INVALID");
  const observedThread = observationThreadId(config, binding, approval, consumed);
  const descriptor = fs.openSync(config.token_file, "r");
  let readToken;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 512) throw new Error("COMMUNICATION_THREAD_READ_TOKEN_INVALID");
    const data = Buffer.alloc(513);
    const size = fs.readSync(descriptor, data, 0, data.length, 0);
    if (size > 512) throw new Error("COMMUNICATION_THREAD_READ_TOKEN_INVALID");
    const tokenBytes = data.subarray(0, size);
    if (observedThread !== null && (
      crypto.createHash("sha256").update(tokenBytes).digest("hex") !== approval.readTokenSha256
      || crypto.createHash("sha256").update(receiveTokenBytes).digest("hex") !== approval.receiveTokenSha256
    )) throw Object.assign(new Error("Source正文试点的口令文件已变化"), { code: "COMMUNICATION_THREAD_READ_OBSERVATION_NOT_APPROVED" });
    readToken = tokenBytes.toString("utf8").trim();
  } finally { fs.closeSync(descriptor); }
  const access = { list: config.list, listScope: config.list_scope ?? "allowed_threads", threadIds: new Set(config.thread_ids) };
  const observation = observedThread === null ? null : createNativeReadObservation({ allowed: new Set([observedThread]), registryStamp(threadId) {
    const journal = readProxyWakeVisibilityRevision(proxy, threadId);
    const communication = transport.readVisibilityRevision(threadId);
    const selection = proxy.liveCodeRuntime?.status?.()?.selected?.manifestSha256 ?? null;
    return journal && communication ? [journal, communication, selection] : null;
  } });
  return { readToken, access, observation, readThread: createLiveCodexThreadReader(proxy, transport.projectKnownHistoryItem, observation) };
}

export function createCodexCommunicationAttachment(proxy, { nativeReadObservationApproval = sourceNativeReadObservationApproval } = {}) {
  const readApproval = nativeReadObservationApproval && Object.freeze({
    threadId: nativeReadObservationApproval.threadId,
    configurationSha256: nativeReadObservationApproval.configurationSha256,
    readTokenSha256: nativeReadObservationApproval.readTokenSha256,
    receiveTokenSha256: nativeReadObservationApproval.receiveTokenSha256,
    ...(Object.hasOwn(nativeReadObservationApproval, "manifestSha256") ? { manifestSha256: nativeReadObservationApproval.manifestSha256 } : {}),
    ...(Object.hasOwn(nativeReadObservationApproval, "singleUse") ? { singleUse: nativeReadObservationApproval.singleUse } : {}),
  });
  let control = null;
  let configurationPath = null;
  let endpoint = null;
  let binding = null;
  let readObservation = null;
  let observationApprovalConsumed = false;
  let operation = Promise.resolve();

  function serialize(action) {
    const pending = operation.catch(() => {}).then(action);
    operation = pending;
    return pending;
  }

  function status() {
    return { enabled: control !== null, endpoint, configuration_path: configurationPath,
      ...(binding ? { binding: { ...binding } } : {}) };
  }

  async function attach(input) {
    if (typeof input?.config_path !== "string" || !path.isAbsolute(input.config_path)) {
      throw new Error("COMMUNICATION_CONFIGURATION_ABSOLUTE_PATH_REQUIRED");
    }
    const conditionalFields = ["expected_instance_id", "expected_manifest_sha256", "expected_configuration_sha256"];
    const conditionalCount = conditionalFields.filter(name => Object.hasOwn(input, name)).length;
    if (conditionalCount !== 0 && (conditionalCount !== conditionalFields.length
      || typeof input.expected_instance_id !== "string" || !input.expected_instance_id
      || !/^[a-f0-9]{64}$/u.test(input.expected_manifest_sha256 ?? "")
      || !/^[a-f0-9]{64}$/u.test(input.expected_configuration_sha256 ?? ""))) {
      throw new Error("COMMUNICATION_ATTACH_CONDITIONS_INVALID");
    }
    const expected = conditionalCount ? {
      instance_id: input.expected_instance_id,
      manifest_sha256: input.expected_manifest_sha256,
      configuration_sha256: input.expected_configuration_sha256,
    } : null;
    const expectedWriterEpoch = proxy.writerEpoch;
    const checkParent = () => {
      if (!expected) return;
      const parent = proxy.liveCodeRuntime?.status?.();
      if (proxy.closed || typeof expectedWriterEpoch !== "string" || !expectedWriterEpoch
        || proxy.writerEpoch !== expectedWriterEpoch || parent?.instanceId !== expected.instance_id
        || parent.busy !== false || parent.failed !== false
        || parent.selected?.manifestSha256 !== expected.manifest_sha256) {
        throw new Error("COMMUNICATION_PARENT_CONDITION_CHANGED");
      }
    };
    return serialize(async () => {
    if (proxy.closed) throw new Error("COMMUNICATION_PROXY_CLOSED");
    if (control) throw new Error("COMMUNICATION_CONTROL_ALREADY_ATTACHED");
    checkParent();
    let candidate;
    try {
      const configPath = fs.realpathSync(input.config_path);
      const configurationBytes = fs.readFileSync(configPath);
      if (expected && crypto.createHash("sha256").update(configurationBytes).digest("hex") !== expected.configuration_sha256) {
        throw new Error("COMMUNICATION_CONFIGURATION_CONDITION_CHANGED");
      }
      const config = JSON.parse(configurationBytes.toString("utf8").replace(/^\uFEFF/, ""));
      if (config.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw new Error("COMMUNICATION_CONFIGURATION_LOOPBACK_REQUIRED");
      }
      if (!path.isAbsolute(config.token_file ?? "") || !path.isAbsolute(config.ledger_path ?? "")) {
        throw new Error("COMMUNICATION_PRIVATE_FILES_ABSOLUTE_PATH_REQUIRED");
      }
      const receiveTokenBytes = fs.readFileSync(config.token_file);
      const token = receiveTokenBytes.toString("utf8").trim();
      if (token.length < 32 || token.length > 4096) throw new Error("COMMUNICATION_TOKEN_INVALID");
      const transport = createCodexCommunicationTransport(proxy);
      const threadRead = configuredThreadRead(config.thread_read, proxy, transport, expected, readApproval, receiveTokenBytes, observationApprovalConsumed);
      candidate = createCodexCommunicationControl({
        host: config.host,
        port: config.port,
        token,
        principalId: config.principal_id,
        allowedOrigins: config.allowed_origins,
        allowedTargets: config.allowed_targets,
        ledgerPath: config.ledger_path,
        transport,
        ...(threadRead ? { threadRead } : {}),
      });
      const address = await candidate.start();
      checkParent();
      control = candidate;
      configurationPath = configPath;
      endpoint = `http://127.0.0.1:${address.port}`;
      binding = expected;
      readObservation = threadRead?.observation ?? null;
      if (readApproval?.singleUse === true && readObservation !== null) observationApprovalConsumed = true;
      return status();
    } catch (error) {
      await candidate?.close().catch(() => {});
      throw error;
    }
    });
  }

  async function close() {
    return serialize(async () => {
      if (control) await control.close();
      readObservation = null;
      releaseProxyWakeJournalReader(proxy);
      control = null;
      configurationPath = null;
      endpoint = null;
      binding = null;
      return status();
    });
  }

  return { status, attach, close,
    threadReadObservation: () => readObservation,
    hasOwnedProjection: () => hasCommunicationProjection(proxy),
    rememberProjectionClient: client => rememberCommunicationProjectionClient(proxy, client),
    transferProjection: startPrevious => transferCommunicationProjection(proxy, startPrevious),
  };
}

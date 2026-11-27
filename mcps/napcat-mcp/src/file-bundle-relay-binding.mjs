import { createHash } from "node:crypto";
import { fileBundleRouteScope, pinnedFileBundleFolderId, sameFileBundleRouteScope } from "./file-bundle-route-scope.mjs";

const writePurposes = new Set(["prepare", "announce", "upload", "file_space", "delete"]);
const continuationPurposes = new Set(["list", "quota", "reconcile", "accept_offer", "download", "commit_received",
  "receipt", "accept_receipt", "read_received", "reconcile_delete"]);

function fault(code, message) {
  throw Object.assign(new Error(message), { code });
}

function capture(frozen, disclosesRecipients = false) {
  return Object.freeze({
    relayId: frozen.relay_key, generation: frozen.generation, groupId: frozen.group_id, channel: frozen.channel,
    selfQqId: frozen.expected_self_id, peerQqId: frozen.peer_qq_id,
    localMachineId: frozen.local_machine_id, peerMachineId: frozen.peer_machine_id,
    ...fileBundleRouteScope({
      legacyTrainingCoexistence: frozen.legacy_training_coexistence,
      fileBundleFolderId: frozen.file_bundle_folder_id, fileBundleFolderName: frozen.file_bundle_folder_name,
    }),
    disclosesRecipients,
  });
}

function aRoute(route) {
  return {
    relay_key: route.relayId, generation: route.generation, group_id: route.groupId, channel: route.channel,
    expected_self_id: route.selfQqId, peer_qq_id: route.peerQqId,
    local_machine_id: route.localMachineId, peer_machine_id: route.peerMachineId,
    ...(route.legacyTrainingCoexistence === true ? { legacy_training_coexistence: true } : {}),
    ...(route.fileBundleFolderId != null ? { file_bundle_folder_id: route.fileBundleFolderId } : {}),
    ...(route.fileBundleFolderName != null ? { file_bundle_folder_name: route.fileBundleFolderName } : {}),
  };
}

function identityMatches(left, right) {
  const expected = aRoute(left);
  const current = aRoute(right);
  return sameFileBundleRouteScope(left, right)
    && Object.keys(expected).every((key) => expected[key] === current[key]);
}

function verifiedFileControl(result, route, expectedHash) {
  if (result?.status === "not_sent") return { status: "not_sent", reason: result.reason };
  if ((result?.status !== "sent_verified" && result?.status !== "duplicate") || result.outcome_unknown !== false
    || result.transport_stage !== "group_received" || result.relay_key !== route.relayId
    || result.route_generation !== route.generation || result.group_id !== route.groupId
    || result.body_sha256 !== expectedHash || typeof result.onebot_message_id !== "string"
    || !result.onebot_message_id || !/^[1-9][0-9]*$/u.test(String(result.real_seq ?? ""))) {
    return { status: "unknown" };
  }
  return { status: "sent", messageId: result.onebot_message_id };
}

export function createFileBundleRelayBinding({
  configOptions, loadAndValidateRelayConfig, resolveRelayRoute, reverifyFrozenRelayRoute,
  verifyLiveRoute, sendPinnedControl, inspectPinnedControl, controlAddress,
}) {
  const load = () => loadAndValidateRelayConfig(configOptions);

  async function reverify(route, purpose, options = {}) {
    options.signal?.throwIfAborted();
    if (!route || route.channel !== "qq" || !route.localMachineId || !route.peerMachineId
      || (options.peer && options.peer !== route.peerMachineId)
      || (!writePurposes.has(purpose) && !continuationPurposes.has(purpose))) return null;
    pinnedFileBundleFolderId(route);
    const allowDraining = !writePurposes.has(purpose);
    const config = await load();
    await reverifyFrozenRelayRoute(config, aRoute(route), { allowDraining, requireFileBundleWrite: !allowDraining });
    const current = await resolveRelayRoute(config, {
      target_machine: route.peerMachineId, channel: route.channel, mode: "read",
      relay_key: route.relayId, expected_generation: route.generation, expected_group_id: route.groupId,
    });
    if (!identityMatches(route, capture(current))
      || (!allowDraining && (current.role !== "active_write" || current.allow_file_bundle_write !== true))
      || (["prepare", "announce", "upload", "read_received"].includes(purpose)
        && route.disclosesRecipients && current.allow_recipient_list_disclosure !== true)) return null;
    const verified = await verifyLiveRoute(current, purpose, options);
    options.signal?.throwIfAborted();
    return verified === true ? current : null;
  }

  async function routeAuthorized(route, purpose, options) {
    try {
      return !!await reverify(route, purpose, options);
    } catch {
      options?.signal?.throwIfAborted();
      return false;
    }
  }

  async function resolveRoute(input, context) {
    if (input.channel !== undefined && input.channel !== "qq") {
      fault("RELAY_FILE_ROUTE_DENIED", "当前纯数据包走 QQ 中继");
    }
    const original = [input.reply_relay_key, input.reply_group_id, input.reply_route_generation].some((field) => field !== undefined);
    if (original && (typeof input.reply_relay_key !== "string" || !input.reply_relay_key
      || typeof input.reply_group_id !== "string" || !/^[1-9][0-9]{4,31}$/u.test(input.reply_group_id)
      || !Number.isSafeInteger(input.reply_route_generation)
      || input.reply_route_generation < 1)) {
      fault("RELAY_FILE_REPLY_ROUTE_UNBOUND", "文件包回复须绑定原群和原代次");
    }
    const config = await load();
    const frozen = await resolveRelayRoute(config, {
      target_machine: input.target_machine, channel: "qq", mode: original ? "reply" : "write",
      ...(original ? { relay_key: input.reply_relay_key, expected_generation: input.reply_route_generation,
        expected_group_id: input.reply_group_id } : {}),
    });
    const multiple = Math.max(input.recipients?.length ?? 0, Array.isArray(input.meta?.all_recipients) ? input.meta.all_recipients.length : 0) > 1;
    if (multiple && (input.allow_disclose_recipients === false || frozen.allow_recipient_list_disclosure !== true)) {
      fault("RELAY_RECIPIENT_DISCLOSURE_BLOCKED", "当前中继群未获准公开同批名单");
    }
    const route = capture(frozen, multiple);
    if (!(await routeAuthorized(route, "prepare", { ...context, peer: input.target_machine }))) {
      fault("RELAY_FILE_ROUTE_DENIED", "原路线未开放新的文件包写入");
    }
    return route;
  }

  async function controlRequest(op, offer, route, file, options, inspect) {
    if (!["file_notice", "file_ack"].includes(op)) return { status: "unknown" };
    const purpose = inspect ? "reconcile" : op === "file_notice" ? "announce" : "receipt";
    let frozen;
    try {
      frozen = await reverify(route, purpose, options);
    } catch {
      options?.signal?.throwIfAborted();
    }
    if (!frozen) return inspect ? { status: "unknown" } : { status: "not_sent", reason: "route_or_expiry" };
    const source = await controlAddress(route.localMachineId, options);
    const target = await controlAddress(route.peerMachineId, options);
    if (!source || !target) return inspect ? { status: "unknown" } : { status: "not_sent", reason: "control_address_missing" };
    const body = JSON.stringify({ v: 1, offer, ...(op === "file_ack" ? { nativeFile: file } : {}) });
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const request = {
      dedupe_key: "napcat-file:" + op + ":" + offer.from + ":" + offer.transferId,
      channel: route.channel, target_machine: route.peerMachineId, op, source, recipients: [target], body,
      reply_relay_key: route.relayId, reply_group_id: route.groupId, reply_route_generation: route.generation,
      meta: { bundle_id: offer.transferId },
    };
    options?.signal?.throwIfAborted();
    const verified = await (inspect ? inspectPinnedControl : sendPinnedControl)(frozen, request, {
      ...options, requireFileBundleWrite: !inspect && op === "file_notice",
      requireRecipientListDisclosure: !inspect && op === "file_notice" && route.disclosesRecipients === true,
    });
    return verifiedFileControl(verified, route, bodyHash);
  }

  async function decodeVerifiedEvent(event, { signal } = {}) {
    signal?.throwIfAborted();
    const frame = event?.frame;
    if (!["file_notice", "file_ack"].includes(frame?.op)) return null;
    if (typeof frame.body !== "string" || frame.body.length > 1900 || frame.from_machine !== event.source_machine
      || createHash("sha256").update(frame.body).digest("hex") !== frame.body_sha256) {
      fault("RELAY_FILE_CONTROL_INVALID", "文件包中继帧正文或已核来源不符");
    }
    let parsed;
    try {
      parsed = JSON.parse(frame.body);
    } catch {
      fault("RELAY_FILE_CONTROL_INVALID", "文件包中继帧正文格式不符");
    }
    const config = await load();
    const frozen = await resolveRelayRoute(config, {
      target_machine: event.source_machine, channel: "qq", mode: "read", relay_key: event.relay_key,
      expected_generation: event.route_generation, expected_group_id: event.group_id,
    });
    const route = capture(frozen);
    const remote = frame.op === "file_notice" ? parsed?.offer?.from : parsed?.offer?.to;
    const local = frame.op === "file_notice" ? parsed?.offer?.to : parsed?.offer?.from;
    const senderQqId = typeof event.sender_id === "string" ? event.sender_id
      : Number.isSafeInteger(event.sender_id) ? String(event.sender_id) : null;
    if (parsed?.v !== 1 || route.peerMachineId !== remote || route.localMachineId !== local
      || frame.to_machine !== local || senderQqId !== route.peerQqId
      || event.group_id !== route.groupId || event.route_generation !== route.generation) {
      fault("RELAY_FILE_CONTROL_INVALID", "文件包中继帧与原群、发件端或收件端不符");
    }
    if (!(await routeAuthorized(route, frame.op === "file_notice" ? "accept_offer" : "accept_receipt", { signal }))) {
      fault("RELAY_FILE_CONTROL_NOT_READY", "文件包中继帧的实际路线暂未复核");
    }
    return {
      op: frame.op, offer: parsed.offer, nativeFile: parsed.nativeFile, route,
      observed: { groupId: route.groupId, relayId: route.relayId, generation: route.generation, channel: route.channel,
        senderQqId, messageId: String(event.onebot_message_id ?? event.event_id ?? "") },
    };
  }

  return {
    resolveRoute, routeAuthorized, decodeVerifiedEvent,
    control: {
      publish: (op, offer, route, file, options) => controlRequest(op, offer, route, file, options, false),
      find: (op, offer, route, file, options) => controlRequest(op, offer, route, file, options, true),
    },
  };
}

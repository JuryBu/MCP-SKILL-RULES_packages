import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canArchiveFileBundle, openRelayFileJournal, relayFileJournalKey } from "./file-bundle-journal.mjs";
import { createFileBundleRuntime } from "./file-bundle-runtime.mjs";
import { verifiedFileNoticeSender } from "./file-bundle-transfer.mjs";

const bodyName = "core-payload.json";
const maxBodyBytes = 1024 ** 2;
const maxEventPageBytes = 2 * 1024 ** 2;
const keyPattern = /^[a-f0-9]{64}$/u;
const simpleString = { type: "string", minLength: 1, maxLength: 256 };
const endpointText = { type: "string", minLength: 1, maxLength: 512 };
const localFile = {
  type: "object", required: ["name", "filePath"], additionalProperties: false,
  properties: { name: simpleString, filePath: { type: "string", minLength: 1, maxLength: 4096 } },
};
const cursor = { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" };
const noExtra = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const fileBundleTools = [
  {
    name: "napcat_file_bundle_send", inputSchema: noExtra({
      dedupe_key: simpleString, target_machine: simpleString, channel: simpleString, reply_relay_key: simpleString,
      reply_group_id: simpleString, reply_route_generation: { type: "integer", minimum: 1 },
      allow_disclose_recipients: { type: "boolean" },
      op: simpleString, source: endpointText,
      recipients: { type: "array", maxItems: 16, items: endpointText },
      meta: { type: "object" }, payload_json: {},
      attachments: { type: "array", maxItems: 63, items: localFile },
    }, ["dedupe_key", "target_machine", "op", "source", "recipients", "meta", "payload_json"]),
    description: "可信本机交流核心在获准路线准备并预告一份纯数据包；结果按原请求查询。",
  },
  {
    name: "napcat_file_bundle_poll", inputSchema: noExtra({
      relay_keys: { type: "array", maxItems: 16, items: simpleString }, cursor, limit: { type: "integer", minimum: 1, maximum: 32 },
    }),
    description: "在本机文件队列推进一页已登记的收发或原次查证。",
  },
  {
    name: "napcat_file_bundle_events_read", inputSchema: noExtra({ cursor, limit: { type: "integer", minimum: 1, maximum: 32 } }),
    description: "分页读取尚待交流核心接管的已验本地文件包，开始新一轮读取时重新从空游标起步。",
  },
  {
    name: "napcat_file_bundle_events_ack", inputSchema: noExtra({
      event_ids: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    }, ["event_ids"]),
    description: "交流核心完成本地持久接管后确认指定事件；远端收妥未核实时继续保留工作副本。",
  },
];

function fault(code, message) {
  throw Object.assign(new Error(message), { code });
}

function digest(encoded) {
  return createHash("sha256").update(encoded).digest("hex");
}

function stableTransferId(machine, source, key) {
  const bits = createHash("sha256").update(JSON.stringify([machine, source, key])).digest().subarray(0, 16);
  bits[6] = (bits[6] & 15) | 128;
  bits[8] = (bits[8] & 63) | 128;
  const value = bits.toString("hex");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join("-");
}

function checkText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function payload(input) {
  if (!checkText(input?.op, 64) || !/^[a-z][a-z0-9_]*$/u.test(input.op)
    || ["file_notice", "file_ack"].includes(input.op)
    || !checkText(input.source, 512) || !Array.isArray(input.recipients) || input.recipients.length > 16
    || !input.recipients.every((entry) => checkText(entry, 512))
    || typeof input.meta !== "object" || input.meta === null || Array.isArray(input.meta)
    || !Object.hasOwn(input, "payload_json")) {
    fault("RELAY_FILE_BODY_INVALID", "文件包的交流核心正文元信息无效");
  }
  return { v: 1, op: input.op, source: input.source, recipients: input.recipients, meta: input.meta, payload_json: input.payload_json };
}

async function subdirectory(root, folder) {
  const full = path.join(root, folder);
  await fs.mkdir(full, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(full)).isDirectory() || path.relative(root, await fs.realpath(full)) !== folder) {
    fault("RELAY_FILE_ROOT_CHANGED", "文件包入口目录身份变化");
  }
  return full;
}

function eventId(record) {
  const { offer, route } = record;
  return digest(JSON.stringify([offer.from, offer.to, offer.transferId, offer.sha256, route.groupId, route.generation]));
}

function incomingReady(record) {
  return record.direction === "in" && ["received", "acknowledging", "acknowledged"].includes(record.state)
    && !!record.staged?.files?.length;
}

export async function createFileBundleEndpoint({
  authorizeInvocation, resolveRoute, resolveAttachments, runtimeOptions, openControlConsumer,
  now = Date.now, transferTtlMs = 86_400_000,
}) {
  const { localMachine } = runtimeOptions;
  const root = await fs.realpath(runtimeOptions.privateRoot);
  const requests = await openRelayFileJournal(await subdirectory(root, "requests"));
  const envelopes = await subdirectory(root, "envelopes");
  const descriptor = Symbol("local sealed request body");
  const runtime = await createFileBundleRuntime({
    ...runtimeOptions, privateRoot: root, now,
    resolveLocalFiles: async (value, scope) => {
      if (!value?.[descriptor]) fault("RELAY_FILE_BODY_INVALID", "只有本机封存的交流核心正文可进入文件包");
      const files = value.attachments.length ? await resolveAttachments(value.attachments, scope) : [];
      return [{ name: bodyName, filePath: value.filePath }, ...files];
    },
    canReleaseIncoming: async (record, confirmation) => {
      if (!verifiedFileNoticeSender(record) || confirmation !== eventId(record)) return false;
      const claim = await requests.read(confirmation);
      return claim?.value?.kind === "core-owned-copy" && claim.value.groupId === record.route.groupId;
    },
  });
  const journal = await openRelayFileJournal(path.join(root, "journal"));
  const controlConsumer = await openControlConsumer?.({ privateRoot: root, ingestControl });
  let buildingRequests = 0;

  async function requireCaller(tool, context) {
    if (await authorizeInvocation(tool, context) !== true) {
      fault("RELAY_FILE_CALLER_DENIED", "文件传输入口只接受本机已授权的交流核心");
    }
    context?.signal?.throwIfAborted();
  }

  function status(record, result, duplicate = false) {
    const { offer, state, route } = record;
    const unknown = ["announcing", "uploading"].includes(state);
    return {
      ok: true, status: duplicate ? "duplicate"
        : result?.reason === "pending_capacity" ? "pending_capacity"
          : state === "announced" ? "announced" : state === "uploaded" || state === "received" ? "sent_verified"
            : unknown ? "unknown" : "pending",
      stage: state, bundle_id: offer.transferId, bundle_sha256: offer.sha256, bytes: offer.bytes,
      relay_key: offer.relayId, group_id: route.groupId, route_generation: route.generation, outcome_unknown: unknown,
      reason: result?.reason ?? record.blockedReason ?? null,
    };
  }

  async function sendOnce(input, context) {
    if (!checkText(input.dedupe_key, 256) || !checkText(input.target_machine, 80)
      || (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 63
        || !input.attachments.every((item) => checkText(item?.name, 256) && checkText(item?.filePath, 4096))))) {
      fault("RELAY_FILE_REQUEST_INVALID", "文件传输的收件机器、编号或本地附件引用无效");
    }
    const body = JSON.stringify(payload(input));
    if (Buffer.byteLength(body) > maxBodyBytes) return { ok: true, status: "too_large", outcome_unknown: false };
    const fingerprint = digest(JSON.stringify([input.target_machine, input.channel ?? null, input.reply_relay_key ?? null,
      input.reply_group_id ?? null, input.reply_route_generation ?? null, input.allow_disclose_recipients ?? null,
      body, input.attachments ?? []]));
    const transferId = stableTransferId(localMachine, input.source, input.dedupe_key);
    const key = relayFileJournalKey("request", localMachine, transferId);
    let entry = await requests.read(key);
    if (!entry) {
      const route = await resolveRoute(input, context);
      if (!route) fault("RELAY_FILE_ROUTE_DENIED", "当前没有获准的文件传输路线");
      entry = await requests.advance(key, null, { fingerprint, route, expiresAt: now() + transferTtlMs })
        ?? await requests.read(key);
    }
    if (!entry || entry.value.fingerprint !== fingerprint) {
      fault("RELAY_FILE_ID_CONFLICT", "同一去重编号已用于内容或目标不同的一笔文件传输");
    }
    const existing = await runtime.lookupOutgoing(transferId);
    if (existing) return status(existing, null, true);
    const directory = await fs.mkdtemp(path.join(envelopes, "body-"));
    const filePath = path.join(directory, bodyName);
    let written = false;
    try {
      const handle = await fs.open(filePath, "wx", 0o600);
      written = true;
      try {
        await handle.writeFile(body, "utf8");
      } finally {
        await handle.close();
      }
      const result = await runtime.prepare({
        transferId, to: input.target_machine, route: entry.value.route, expiresAt: entry.value.expiresAt,
        requestFingerprint: fingerprint,
        files: { [descriptor]: true, filePath, attachments: input.attachments ?? [] }, signal: context?.signal,
      });
      if (!["prepared", "existing"].includes(result.status)) {
        return { ok: true, status: "pending_capacity", reason: result.status, outcome_unknown: false };
      }
      const sent = result.status === "prepared" ? await runtime.advance(transferId, context) : null;
      return status(await runtime.lookupOutgoing(transferId), sent, result.status === "existing");
    } catch (error) {
      if (["RELAY_BUNDLE_TOO_LARGE", "RELAY_BUNDLE_FILE_COUNT"].includes(error?.code)) {
        return { ok: true, status: "too_large", outcome_unknown: false };
      }
      throw error;
    } finally {
      if (written) await fs.unlink(filePath).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  }

  async function send(input, context) {
    if (buildingRequests >= 8) return { ok: true, status: "pending_capacity", reason: "local_lane_full", outcome_unknown: false };
    buildingRequests += 1;
    try {
      return await sendOnce(input, context);
    } finally {
      buildingRequests -= 1;
    }
  }

  async function readEvents(input, context) {
    const limit = input.limit ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32
      || (input.cursor != null && !keyPattern.test(input.cursor))) fault("RELAY_FILE_EVENT_CURSOR", "文件事件分页无效");
    const selected = [];
    for await (const item of journal.scan({ signal: context?.signal })) {
      if (!incomingReady(item.value) || item.value.releaseState || (input.cursor && item.key <= input.cursor)
        || await requests.read(eventId(item.value))) continue;
      selected.push(item.key);
    }
    selected.sort();
    const events = [];
    const errors = [];
    let bytes = 0;
    let through = null;
    let more = selected.length > limit;
    for (const key of selected.slice(0, limit)) {
      const previous = through;
      through = key;
      const item = await journal.read(key);
      if (!item || item.value.releaseState || await requests.read(eventId(item.value))) continue;
      const stored = item.value;
      const senderId = verifiedFileNoticeSender(stored);
      if (senderId === null) {
        errors.push({ event_id: eventId(stored), code: "RELAY_FILE_SENDER_UNVERIFIED" });
        continue;
      }
      if ((await runtimeOptions.routeAuthorized(stored.route, "read_received", { ...context, peer: stored.offer.from })) !== true) {
        errors.push({ event_id: eventId(stored), code: "RELAY_FILE_ROUTE_UNAVAILABLE" });
        continue;
      }
      const [metadata, ...files] = stored.staged.files;
      try {
        const original = await fs.lstat(metadata.filePath);
        if (metadata.name !== bodyName || metadata.bytes > maxBodyBytes || !original.isFile() || original.size !== metadata.bytes) {
          fault("RELAY_FILE_BODY_INVALID", "已收文件包的正文原件不符");
        }
        const encoded = await fs.readFile(metadata.filePath);
        if (encoded.length !== metadata.bytes || digest(encoded) !== metadata.sha256) {
          fault("RELAY_FILE_BODY_INVALID", "已收文件包的正文原件已变化");
        }
        const decoded = JSON.parse(encoded.toString("utf8"));
        if (decoded.v !== 1) fault("RELAY_FILE_BODY_INVALID", "文件正文格式版本不支持");
        const body = payload(decoded);
        const multiple = Math.max(body.recipients.length, Array.isArray(body.meta.all_recipients) ? body.meta.all_recipients.length : 0) > 1;
        if (multiple && (await runtimeOptions.routeAuthorized({ ...stored.route, disclosesRecipients: true }, "read_received", {
          ...context, peer: stored.offer.from,
        })) !== true) {
          errors.push({ event_id: eventId(stored), code: "RELAY_RECIPIENT_DISCLOSURE_BLOCKED" });
          continue;
        }
        const current = {
          event_id: eventId(stored), bundle_id: stored.offer.transferId, source_machine: stored.offer.from,
          sender_id: senderId, target_machine: stored.offer.to, relay_key: stored.offer.relayId, group_id: stored.route.groupId,
          route_generation: stored.route.generation, received_at: new Date(stored.receivedAt).toISOString(),
          op: body.op, source: body.source, recipients: body.recipients, meta: body.meta,
          payload_json: body.payload_json, staged_files: files,
        };
        const encodedSize = Buffer.byteLength(JSON.stringify(current));
        if (bytes + encodedSize > maxEventPageBytes && events.length) {
          through = previous;
          more = true;
          break;
        }
        if (encodedSize > maxEventPageBytes) fault("RELAY_FILE_BODY_INVALID", "单个文件事件超过本机读取上限");
        events.push(current);
        bytes += encodedSize;
      } catch {
        context?.signal?.throwIfAborted();
        errors.push({ event_id: eventId(stored), code: "RELAY_FILE_BODY_INVALID" });
      }
    }
    return { ok: true, events, errors, next_cursor: more ? through : null };
  }

  async function maintainSettled(signal, relayIds) {
    let handled = 0;
    let archived = 0;
    let needsReview = 0;
    for await (const item of journal.scan({ signal })) {
      const record = item.value;
      if (!record.offer || (relayIds && !relayIds.includes(record.offer.relayId))) continue;
      const outgoing = record.direction === "out" && record.state === "received";
      const incoming = record.direction === "in" && record.state === "acknowledged" && incomingReady(record);
      if ((!incoming && !outgoing) || (record.releaseState === "released" && !canArchiveFileBundle(record))) continue;
      const confirmation = incoming ? eventId(record) : undefined;
      if (confirmation && !(await requests.read(confirmation))) continue;
      try {
        let settled = item;
        if (record.releaseState !== "released") {
          const outcome = await runtime.release({ direction: record.direction, source: record.offer.from,
            transferId: record.offer.transferId, confirmation, signal });
          if (outcome.status === "released") settled = await journal.read(item.key);
        }
        if (canArchiveFileBundle(settled?.value) && await journal.archiveCompleted(settled.key, settled.revision)) archived += 1;
      } catch {
        signal?.throwIfAborted();
        needsReview += 1;
      }
      if (++handled >= 32) break;
    }
    return { archived, needs_review: needsReview };
  }

  async function acknowledge(input, context) {
    if (!Array.isArray(input.event_ids) || !input.event_ids.length || input.event_ids.length > 32
      || !input.event_ids.every((key) => typeof key === "string" && keyPattern.test(key))) {
      fault("RELAY_FILE_EVENT_ACK_INVALID", "请给出已由交流核心接管的精确文件事件编号");
    }
    const pending = new Set(input.event_ids);
    const results = [];
    for (const key of pending) {
      const claim = await requests.read(key);
      if (claim?.value?.kind !== "core-owned-copy" || !keyPattern.test(claim.value.bundleKey ?? "")) continue;
      const stored = await journal.read(claim.value.bundleKey);
      if (incomingReady(stored?.value ?? {}) && verifiedFileNoticeSender(stored.value)
        && eventId(stored.value) === key && stored.value.releaseState === "released") {
        pending.delete(key);
        results.push({ event_id: key, status: "recorded", release: "released" });
      }
    }
    if (!pending.size) return { ok: true, results, not_found: [] };
    for await (const item of journal.scan({ signal: context?.signal })) {
      const record = item.value;
      if (!incomingReady(record) || !verifiedFileNoticeSender(record)) continue;
      const key = eventId(record);
      if (!pending.has(key)) continue;
      await requests.advance(key, null, { kind: "core-owned-copy", groupId: record.route.groupId, bundleKey: item.key, claimedAt: now() });
      const release = await runtime.release({ direction: "in", source: record.offer.from, transferId: record.offer.transferId,
        confirmation: key, signal: context?.signal });
      pending.delete(key);
      results.push({ event_id: key, status: "recorded", release: release.status });
    }
    return { ok: true, results, not_found: [...pending] };
  }

  async function poll(input, context) {
    const resume = { limit: input.limit, after: input.cursor ?? null, relayIds: input.relay_keys, signal: context?.signal };
    runtime.validateResume(resume);
    const control = await controlConsumer?.sweep({ relayKeys: input.relay_keys, signal: context?.signal });
    const result = await runtime.resume(resume);
    const maintenance = await maintainSettled(context?.signal, input.relay_keys);
    return { ok: true, results: result.results, next_cursor: result.next, ...(control ? { control } : {}),
      maintenance };
  }

  async function ingestControl(event, { signal } = {}) {
    if (event.op === "file_notice") return runtime.acceptAnnouncement({ ...event, signal });
    if (event.op === "file_ack") {
      const received = await runtime.acceptReceipt({ ...event, signal });
      if (received.status === "received") await runtime.release({
        direction: "out", transferId: event.offer.transferId, signal,
      });
      return received;
    }
    return { status: "ignored" };
  }

  const actions = { napcat_file_bundle_send: send, napcat_file_bundle_poll: poll,
    napcat_file_bundle_events_read: readEvents, napcat_file_bundle_events_ack: acknowledge };
  return {
    ingestControl,
    async invoke(tool, input, context) {
      if (!Object.hasOwn(actions, tool)) fault("RELAY_FILE_TOOL_UNKNOWN", "未知文件运输入口");
      await requireCaller(tool, context);
      return actions[tool](input ?? {}, context);
    },
  };
}

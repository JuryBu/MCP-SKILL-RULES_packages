import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { relayBundleLimits, stageRelayFileBundle } from "./file-bundle-codec.mjs";
import { relayFileJournalKey } from "./file-bundle-journal.mjs";
import { fileBundleRouteScope, pinnedFileBundleFolderId } from "./file-bundle-route-scope.mjs";

const token = /^[A-Za-z0-9_.-]{1,80}$/u;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const numberId = /^[1-9][0-9]{0,31}$/u;
const hash = /^[a-f0-9]{64}$/u;
const maxOfferLifeMs = 7 * 24 * 60 * 60 * 1000;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function textMatches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function nativeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f]/u.test(value);
}

function presentRoute(value) {
  const { relayId, generation, groupId, selfQqId, peerQqId, channel = "qq",
    localMachineId = null, peerMachineId = null, disclosesRecipients = false } = value ?? {};
  if (!textMatches(relayId, token) || !Number.isSafeInteger(generation) || generation < 1
    || ![groupId, selfQqId, peerQqId].every((id) => textMatches(id, numberId)) || selfQqId === peerQqId
    || channel !== "qq" || (localMachineId !== null && !textMatches(localMachineId, token))
    || (peerMachineId !== null && !textMatches(peerMachineId, token)) || typeof disclosesRecipients !== "boolean") {
    fail("RELAY_FILE_ROUTE_INVALID", "文件包路线不完整");
  }
  pinnedFileBundleFolderId(value);
  return { relayId, generation, groupId, selfQqId, peerQqId, channel, localMachineId, peerMachineId,
    disclosesRecipients, ...fileBundleRouteScope(value) };
}

function offerName(transferId, sha256) {
  return ["ncr", transferId, sha256.slice(0, 16)].join("-") + ".ncp";
}

export function createRelayFileOffer({ transferId, from, to, route: inputRoute, bytes, sha256, createdAt, expiresAt }) {
  const route = presentRoute(inputRoute);
  if (!textMatches(transferId, uuid) || !textMatches(from, token) || !textMatches(to, token) || from === to
    || !Number.isSafeInteger(bytes) || bytes < 1 || !textMatches(sha256, hash)
    || !Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(expiresAt)
    || expiresAt <= createdAt || expiresAt - createdAt > maxOfferLifeMs) {
    fail("RELAY_FILE_OFFER_INVALID", "文件预告身份或期限无效");
  }
  return {
    transferId, from, to, relayId: route.relayId, generation: route.generation,
    name: offerName(transferId, sha256), bytes, sha256, createdAt, expiresAt,
  };
}

function validateOffer(input, route, maxBundleBytes) {
  const offer = createRelayFileOffer({ ...input, route });
  if (input?.relayId !== offer.relayId || input?.generation !== offer.generation
    || input?.name !== offer.name || offer.bytes > maxBundleBytes) {
    fail("RELAY_FILE_OFFER_INVALID", "文件预告与固定路线、名称或字节上限不符");
  }
  return offer;
}

function verifySource(observed, route) {
  if (observed?.groupId !== route.groupId || observed?.senderQqId !== route.peerQqId
    || observed?.relayId !== route.relayId || observed?.generation !== route.generation
    || (observed?.channel ?? "qq") !== route.channel
    || !nativeId(observed.messageId)) {
    fail("RELAY_FILE_SOURCE_MISMATCH", "群消息实际来源与原路线不符");
  }
}

export function verifiedFileNoticeSender(record) {
  const sender = record?.announcementSenderQqId;
  return record?.direction === "in" && textMatches(sender, numberId) && nativeId(record.announcementId)
    && sender === record.route?.peerQqId && sender === record.file?.uploaderId ? sender : null;
}

function matchFile(file, offer, uploaderId) {
  if (!nativeId(file?.id) || file.name !== offer.name || file.bytes !== offer.bytes
    || file.uploaderId !== uploaderId) return null;
  return { id: file.id, name: file.name, bytes: file.bytes, uploaderId: file.uploaderId };
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ownedBundlePath(root, bundlePath) {
  if (typeof bundlePath !== "string" || !path.isAbsolute(bundlePath)) {
    fail("RELAY_FILE_LOCAL_BUNDLE_INVALID", "文件包未在本机封存");
  }
  const real = await fs.realpath(bundlePath);
  const relative = path.relative(root, real);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
    || !(await fs.lstat(bundlePath)).isFile()) {
    fail("RELAY_FILE_LOCAL_BUNDLE_INVALID", "文件包不在本次私有传输目录");
  }
  return real;
}

async function checkLocalBundle(root, bundlePath, packet, signal) {
  const real = await ownedBundlePath(root, bundlePath);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(real, { signal })) {
    bytes += chunk.length;
    if (bytes > packet.bytes) break;
    digest.update(chunk);
  }
  if (bytes !== packet.bytes || digest.digest("hex") !== packet.sha256) {
    fail("RELAY_FILE_LOCAL_BUNDLE_CHANGED", "本机封存文件已变化");
  }
  return real;
}

async function discardStaged(staged) {
  if (!staged) return;
  await Promise.allSettled(staged.files.map((file) => fs.unlink(file.filePath)));
  await fs.rmdir(staged.directory).catch(() => {});
}

function createFileWriteLane() {
  const groups = new Map();
  return async (groupId, operation, signal) => {
    signal?.throwIfAborted();
    const group = groups.get(groupId) ?? { tail: null, depth: 0 };
    if (group.depth >= 8) return { status: "file_lane_full" };
    const prior = group.tail;
    let release;
    group.tail = new Promise((resolve) => { release = resolve; });
    group.depth += 1;
    groups.set(groupId, group);
    try {
      await prior;
      signal?.throwIfAborted();
      return await operation();
    } finally {
      group.depth -= 1;
      if (!group.depth) groups.delete(groupId);
      release();
    }
  };
}

const runGroupFileWrite = createFileWriteLane();

export async function createRelayFileTransfer({ localMachine, journal, workRoot, io, limits, now = Date.now }) {
  if (!textMatches(localMachine, token) || typeof workRoot !== "string" || !path.isAbsolute(workRoot)) {
    fail("RELAY_FILE_LOCAL_INVALID", "本机文件运输身份或目录无效");
  }
  const root = await fs.realpath(workRoot);
  if (!(await fs.stat(root)).isDirectory()) fail("RELAY_FILE_LOCAL_INVALID", "本机文件运输目录无效");
  const bounds = relayBundleLimits(limits);

  const outKey = (id) => relayFileJournalKey("out", localMachine, id);
  const inKey = (source, id) => relayFileJournalKey("in", source, id);

  async function authorized(route, peer, purpose, signal) {
    if ((route.localMachineId !== null && route.localMachineId !== localMachine)
      || (route.peerMachineId !== null && route.peerMachineId !== peer)) return false;
    signal?.throwIfAborted();
    const allowed = await io.authorize(Object.freeze({ ...route }), peer, purpose, { signal });
    signal?.throwIfAborted();
    return allowed === true;
  }

  function freshness(offer) {
    const current = now();
    return offer.createdAt <= current + 60_000 && offer.expiresAt > current;
  }

  async function register(key, value) {
    const saved = await journal.advance(key, null, value) ?? await journal.read(key);
    if (!saved || !equalValue(saved.value.offer, value.offer) || !equalValue(saved.value.route, value.route)
      || saved.value.requestFingerprint !== value.requestFingerprint) {
      fail("RELAY_FILE_ID_CONFLICT", "文件包编号已绑定到另一份预告或路线");
    }
    return saved.value;
  }

  async function transition(current, changes) {
    return await journal.advance(current.key, current.revision, { ...current.value, ...changes });
  }

  async function runEffect(current, { initial, active, perform, reconcile, accept }) {
    let claimed = current;
    const first = current.value.state === initial;
    if (first) {
      claimed = await transition(current, { state: active, startedAt: now(), blockedReason: null });
      if (!claimed) return { status: "changed" };
    }
    let outcome;
    try {
      outcome = await (first ? perform : reconcile)(claimed.value);
    } catch {
      return { status: "unknown", state: active };
    }
    if (first && outcome?.status === "not_sent") {
      const written = await transition(claimed, { state: initial, blockedReason: outcome.reason ?? null });
      return written ? { status: "not_sent", reason: outcome.reason, state: initial } : { status: "changed" };
    }
    const next = outcome?.status === "sent" ? accept(outcome, claimed.value) : null;
    if (!next) return { status: "unknown", state: active };
    return await transition(claimed, next) ? { status: next.state } : { status: "changed" };
  }

  async function registerOutgoing({ offer: raw, route: inputRoute, bundlePath, requestFingerprint = null, signal }) {
    const route = presentRoute(inputRoute);
    const offer = validateOffer(raw, route, bounds.maxBundleBytes);
    if (offer.from !== localMachine || !freshness(offer) || !(await authorized(route, offer.to, "prepare", signal))) {
      fail("RELAY_FILE_SEND_DENIED", "文件预告未获准或已过期");
    }
    if (requestFingerprint !== null && !textMatches(requestFingerprint, hash)) {
      fail("RELAY_FILE_OFFER_INVALID", "原文件申请的指纹无效");
    }
    const sourcePath = await checkLocalBundle(root, bundlePath, offer, signal);
    return register(outKey(offer.transferId), { direction: "out", state: "prepared", offer, route, sourcePath, requestFingerprint });
  }

  async function advanceOutgoing(transferId, { signal } = {}) {
    const current = await journal.read(outKey(transferId));
    if (!current) return { status: "not_found" };
    const { offer, route, state, sourcePath } = current.value;
    const options = { signal };
    const checkSpace = async () => {
      const space = await io.ensureSpace(offer, route, options);
      if (space?.status !== "ready") return space?.status ?? "quota_unknown";
      return route.legacyTrainingCoexistence === true && space.headroom !== true ? "pending_capacity" : null;
    };
    if (state === "prepared" || state === "announcing") {
      if (!(await authorized(route, offer.to, state === "prepared" ? "announce" : "reconcile", signal))
        || (state === "prepared" && !freshness(offer))) return { status: "blocked", state };
      const announce = (record) => runEffect(record, {
        initial: "prepared",
        active: "announcing",
        perform: async () => (await authorized(route, offer.to, "announce", signal) && freshness(offer))
          ? io.announce(offer, route, options) : { status: "not_sent", reason: "route_or_expiry" },
        reconcile: () => io.findAnnouncement(offer, route, options),
        accept: (result) => nativeId(result.messageId) ? { state: "announced", announcementId: result.messageId } : null,
      });
      if (state !== "prepared" || route.legacyTrainingCoexistence !== true) return announce(current);
      return runGroupFileWrite(route.groupId, async () => {
        const recent = await journal.read(current.key);
        if (!recent || recent.revision !== current.revision) return { status: "changed" };
        if (!(await authorized(route, offer.to, "announce", signal)) || !freshness(offer)) {
          return { status: "not_sent", reason: "route_or_expiry", state };
        }
        let reason;
        try {
          reason = await checkSpace();
        } catch (error) {
          signal?.throwIfAborted();
          reason = error?.code ?? "quota_unknown";
        }
        return reason ? { status: "not_sent", reason, state } : announce(recent);
      }, signal);
    }
    if (state === "announced" || state === "uploading") {
      if (!(await authorized(route, offer.to, state === "announced" ? "upload" : "reconcile", signal))
        || (state === "announced" && !freshness(offer))) return { status: "blocked", state };
      const attempt = async () => {
        const recent = await journal.read(current.key);
        if (!recent || recent.revision !== current.revision) return { status: "changed" };
        let source;
        if (state === "announced") {
          try {
            if (!(await authorized(route, offer.to, "upload", signal)) || !freshness(offer)) {
              return { status: "not_sent", reason: "route_or_expiry", state };
            }
            await ownedBundlePath(root, sourcePath);
            const reason = await checkSpace();
            if (reason) return { status: "not_sent", reason, state };
            source = await checkLocalBundle(root, sourcePath, offer, signal);
            if (!(await authorized(route, offer.to, "upload", signal)) || !freshness(offer)) {
              return { status: "not_sent", reason: "route_or_expiry", state };
            }
          } catch (error) {
            signal?.throwIfAborted();
            return { status: "not_sent", reason: error?.code ?? "upload_preflight_failed", state };
          }
        }
        return runEffect(recent, {
          initial: "announced",
          active: "uploading",
          perform: () => io.upload(offer, route, source, options),
          reconcile: () => io.findUpload(offer, route, route.selfQqId, options),
          accept: (result, claimed) => {
            const file = matchFile(result.file, offer, route.selfQqId);
            return file ? { state: "uploaded", file, uploadedAt: claimed.startedAt } : null;
          },
        });
      };
      return state === "announced" ? runGroupFileWrite(route.groupId, attempt, signal) : attempt();
    }
    return { status: state };
  }

  async function acceptAnnouncement({ offer: raw, route: inputRoute, observed, signal }) {
    const route = presentRoute(inputRoute);
    const offer = validateOffer(raw, route, bounds.maxBundleBytes);
    verifySource(observed, route);
    if (offer.to !== localMachine || !freshness(offer) || !(await authorized(route, offer.from, "accept_offer", signal))) {
      fail("RELAY_FILE_RECEIVE_DENIED", "文件预告目标未获准或已过期");
    }
    return register(inKey(offer.from, offer.transferId), {
      direction: "in", state: "waiting_file", offer, route, announcementId: observed.messageId,
      announcementSenderQqId: observed.senderQqId,
    });
  }

  async function receiveBundle(source, transferId, { signal } = {}) {
    const current = await journal.read(inKey(source, transferId));
    if (!current) return { status: "not_found" };
    const { offer, route, state } = current.value;
    if (state !== "waiting_file") return { status: state };
    if (!freshness(offer) || !(await authorized(route, offer.from, "download", signal))) return { status: "blocked" };
    const options = { signal };
    const found = await io.findUpload(offer, route, route.peerQqId, options);
    if (found?.status !== "sent") return { status: "waiting_file" };
    const file = matchFile(found.file, offer, route.peerQqId);
    if (!file) return { status: "file_unverified" };
    const temporary = await fs.mkdtemp(path.join(root, "download-"));
    const bundlePath = path.join(temporary, "bundle.data");
    let staged;
    let saved = false;
    let keepUncertain = false;
    try {
      await io.download(offer, route, file, bundlePath, options);
      await ownedBundlePath(root, bundlePath);
      staged = await stageRelayFileBundle({ workRoot: root, bundlePath, expected: offer, limits: bounds, signal });
      if (!freshness(offer) || !(await authorized(route, offer.from, "commit_received", signal))) {
        return { status: "blocked" };
      }
      try {
        saved = !!await transition(current, { state: "received", file, staged, receivedAt: now() });
      } catch {
        const after = await journal.read(current.key).catch(() => undefined);
        if (after?.value?.staged?.directory === staged.directory && equalValue(after.value.file, file)) {
          saved = true;
        } else {
          keepUncertain = after === undefined;
          return { status: "receipt_storage_unknown" };
        }
      }
      return { status: saved ? "received" : "changed" };
    } finally {
      await fs.unlink(bundlePath).catch(() => {});
      await fs.rmdir(temporary).catch(() => {});
      if (!saved && !keepUncertain) await discardStaged(staged);
    }
  }

  async function confirmReceipt(source, transferId, { signal } = {}) {
    const current = await journal.read(inKey(source, transferId));
    if (!current) return { status: "not_found" };
    const { offer, route, state, file, staged } = current.value;
    if (state !== "received" && state !== "acknowledging") return { status: state };
    if (!(await authorized(route, offer.from, state === "received" ? "receipt" : "reconcile", signal))) {
      return { status: "blocked", state };
    }
    return runEffect(current, {
      initial: "received",
      active: "acknowledging",
      perform: async () => {
        try {
          if (!Array.isArray(staged?.files) || !staged.files.length || staged.files.length > bounds.maxFiles) {
            return { status: "not_sent", reason: "stored_evidence_invalid" };
          }
          for (const [index, entry] of staged.files.entries()) {
            if (entry.filePath !== path.join(staged.directory, String(index) + ".data")) {
              return { status: "not_sent", reason: "stored_evidence_invalid" };
            }
            await checkLocalBundle(root, entry.filePath, entry, signal);
          }
        } catch {
          return { status: "not_sent", reason: "stored_evidence_invalid" };
        }
        return (await authorized(route, offer.from, "receipt", signal))
          ? io.receipt(offer, route, file, { signal }) : { status: "not_sent", reason: "route_changed" };
      },
      reconcile: () => io.findReceipt(offer, route, file, { signal }),
      accept: (result) => nativeId(result.messageId) ? { state: "acknowledged", receiptMessageId: result.messageId } : null,
    });
  }

  async function acceptReceipt({ offer: raw, observed, nativeFile, signal }) {
    const current = await journal.read(outKey(raw?.transferId));
    if (!current) return { status: "not_found" };
    const { offer, route, state, startedAt, uploadedAt } = current.value;
    const immutable = validateOffer(raw, route, bounds.maxBundleBytes);
    verifySource(observed, route);
    if (!equalValue(offer, immutable) || !(await authorized(route, offer.to, "accept_receipt", signal))) {
      fail("RELAY_FILE_RECEIPT_MISMATCH", "收包回执与原预告不符");
    }
    const file = matchFile(nativeFile, offer, route.selfQqId);
    if (!file || (current.value.file && !equalValue(current.value.file, file))) {
      fail("RELAY_FILE_RECEIPT_MISMATCH", "收包回执引用的群文件身份不符");
    }
    if (state === "received") return { status: "received" };
    if (state !== "uploaded" && state !== "uploading") return { status: "not_awaiting_receipt" };
    if (state === "uploading") {
      const located = await io.findUpload(offer, route, route.selfQqId, { signal });
      if (located?.status !== "sent" || !equalValue(matchFile(located.file, offer, route.selfQqId), file)) {
        return { status: "upload_unverified" };
      }
    }
    const saved = await transition(current, {
      state: "received", file, uploadedAt: uploadedAt ?? startedAt, receivedAt: now(), receiptMessageId: observed.messageId,
    });
    return { status: saved ? "received" : "changed" };
  }

  return {
    registerOutgoing, advanceOutgoing, acceptAnnouncement, receiveBundle, confirmReceipt, acceptReceipt,
    readOutgoing: async (id) => (await journal.read(outKey(id)))?.value ?? null,
    readIncoming: async (source, id) => (await journal.read(inKey(source, id)))?.value ?? null,
  };
}

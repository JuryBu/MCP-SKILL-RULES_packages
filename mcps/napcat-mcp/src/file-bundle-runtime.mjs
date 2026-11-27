import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { relayBundleLimits, writeRelayFileBundle } from "./file-bundle-codec.mjs";
import { openRelayFileJournal, relayFileJournalKey } from "./file-bundle-journal.mjs";
import { createFileBundleCapacity } from "./file-bundle-capacity.mjs";
import { createFileBundleOneBot } from "./file-bundle-onebot.mjs";
import { relayFileQuotaPolicy } from "./file-bundle-quota.mjs";
import { createRelayFileOffer, createRelayFileTransfer } from "./file-bundle-transfer.mjs";

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function privateSubdirectory(root, name) {
  const result = path.join(root, name);
  await fs.mkdir(result, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(result)).isDirectory() || path.relative(root, await fs.realpath(result)) !== name) {
    reject("RELAY_FILE_RUNTIME_PATH_DENIED", "文件包目录身份变化");
  }
  return result;
}

async function spoolUsage(workRoot, limit, signal) {
  let bytes = 0;
  let entries = 0;
  const folders = await fs.opendir(workRoot);
  for await (const folder of folders) {
    signal?.throwIfAborted();
    if (++entries > limit || !folder.isDirectory() || !/^(?:send|receive|download)-[A-Za-z0-9]+$/u.test(folder.name)) {
      reject("RELAY_FILE_RUNTIME_PATH_DENIED", "文件包目录含未知内容");
    }
    const contained = await fs.opendir(path.join(workRoot, folder.name));
    for await (const file of contained) {
      signal?.throwIfAborted();
      if (++entries > limit || !file.isFile() || !/^(?:[0-9]+|bundle)\.data$/u.test(file.name)) {
        reject("RELAY_FILE_RUNTIME_LIMIT", "文件包目录超出安全扫描范围");
      }
      const stat = await fs.lstat(path.join(workRoot, folder.name, file.name));
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > Number.MAX_SAFE_INTEGER - bytes) {
        reject("RELAY_FILE_RUNTIME_PATH_DENIED", "文件包目录身份变化");
      }
      bytes += stat.size;
    }
  }
  return bytes;
}

export async function createFileBundleRuntime({
  localMachine, privateRoot, bundleLimits, quotaLimits, maxSpoolBytes = 512 * 1024 ** 2,
  oneBot, control, routeAuthorized, resolveLocalFiles, canReleaseIncoming, now = Date.now,
}) {
  const limits = relayBundleLimits(bundleLimits);
  const spacePolicy = relayFileQuotaPolicy({
    maxUploads: oneBot?.fileCountLimit ?? 1500, maxUploadBytes: limits.maxBundleBytes, ...quotaLimits,
  });
  const root = await fs.realpath(privateRoot);
  const workRoot = await privateSubdirectory(root, "files");
  const journal = await openRelayFileJournal(await privateSubdirectory(root, "journal"));
  if (!Number.isSafeInteger(maxSpoolBytes) || maxSpoolBytes < limits.maxBundleBytes) {
    reject("RELAY_FILE_RUNTIME_LIMIT", "文件包本机存储限制无效");
  }
  const provider = await createFileBundleOneBot({ ...oneBot, workRoot, routeAuthorized });
  const capacity = createFileBundleCapacity({ journal, localMachine, provider, routeAuthorized, limits: spacePolicy, now });
  const transfer = await createRelayFileTransfer({
    localMachine, workRoot, journal, limits, now,
    io: {
      ...provider,
      ensureSpace: capacity.ensureSpace,
      authorize: (route, peer, purpose, options) => routeAuthorized(route, purpose, { ...options, peer }),
      announce: (offer, route, options) => control.publish("file_notice", offer, route, null, options),
      receipt: (offer, route, file, options) => control.publish("file_ack", offer, route, file, options),
      findAnnouncement: (offer, route, options) => control.find("file_notice", offer, route, null, options),
      findReceipt: (offer, route, file, options) => control.find("file_ack", offer, route, file, options),
    },
  });
  let pending = Promise.resolve();
  let pendingCount = 0;

  function withSpool(work, signal) {
    if (pendingCount >= 8) return Promise.resolve({ status: "local_lane_full" });
    pendingCount += 1;
    const before = pending;
    const job = before.then(async () => {
      signal?.throwIfAborted();
      const available = maxSpoolBytes - await spoolUsage(workRoot, 8192, signal);
      return work(available);
    }).finally(() => { pendingCount -= 1; });
    pending = job.catch(() => {});
    return job;
  }

  function existingOffer(record, to, route, fingerprint) {
    if (record.offer.to !== to || record.route.relayId !== route?.relayId
      || record.route.groupId !== route.groupId || record.route.generation !== route.generation
      || record.route.selfQqId !== route.selfQqId || record.route.peerQqId !== route.peerQqId
      || record.route.channel !== (route.channel ?? "qq") || record.route.localMachineId !== (route.localMachineId ?? null)
      || record.route.peerMachineId !== (route.peerMachineId ?? null)
      || record.route.disclosesRecipients !== (route.disclosesRecipients ?? false) || record.requestFingerprint !== fingerprint) {
      reject("RELAY_FILE_ID_CONFLICT", "文件包编号已用于其它来源内容、目标或路线");
    }
    return { status: "existing", offer: record.offer, state: record.state };
  }

  async function prepare({ transferId, to, route, files, expiresAt, requestFingerprint, signal }) {
    if (typeof resolveLocalFiles !== "function"
      || (await routeAuthorized(route, "prepare", { peer: to, signal })) !== true) {
      reject("RELAY_FILE_SEND_DENIED", "文件来源或目标路线未获准");
    }
    const fingerprint = requestFingerprint
      ?? createHash("sha256").update(JSON.stringify(files ?? null)).digest("hex");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      reject("RELAY_FILE_OFFER_INVALID", "原文件申请的指纹无效");
    }
    const existing = await transfer.readOutgoing(transferId);
    if (existing) return existingOffer(existing, to, route, fingerprint);
    const identity = createRelayFileOffer({
      transferId, from: localMachine, to, route, bytes: 1, sha256: "0".repeat(64),
      createdAt: now(), expiresAt,
    });
    return withSpool(async (available) => {
      const current = await transfer.readOutgoing(transferId);
      if (current) return existingOffer(current, to, route, fingerprint);
      if (available < 1) return { status: "local_capacity_full" };
      if ((await routeAuthorized(route, "prepare", { peer: to, signal })) !== true) {
        reject("RELAY_FILE_SEND_DENIED", "文件来源或目标路线未获准");
      }
      const permitted = await resolveLocalFiles(files, { to, route, signal });
      let pack;
      try {
        pack = await writeRelayFileBundle({
          workRoot, files: permitted, signal, limits: { ...limits, maxBundleBytes: Math.min(limits.maxBundleBytes, available) },
        });
      } catch (error) {
        if (error?.code === "RELAY_BUNDLE_TOO_LARGE" && available < limits.maxBundleBytes) {
          return { status: "local_capacity_full" };
        }
        throw error;
      }
      try {
        const offer = createRelayFileOffer({
          transferId, from: localMachine, to, route, bytes: pack.bytes, sha256: pack.sha256,
          createdAt: identity.createdAt, expiresAt,
        });
        const saved = await transfer.registerOutgoing({
          offer, route, bundlePath: pack.bundlePath, requestFingerprint: fingerprint, signal,
        });
        if (saved.sourcePath !== pack.bundlePath) {
          await fs.unlink(pack.bundlePath);
          await fs.rmdir(pack.directory);
          return existingOffer(saved, to, route, fingerprint);
        }
        return { status: "prepared", offer };
      } catch (error) {
        const committed = await transfer.readOutgoing(transferId).catch(() => undefined);
        if (committed === null || (committed && committed.sourcePath !== pack.bundlePath)) {
          await fs.unlink(pack.bundlePath).catch(() => {});
          await fs.rmdir(pack.directory).catch(() => {});
        }
        throw error;
      }
    }, signal);
  }

  async function receive(source, transferId, { signal } = {}) {
    const current = await transfer.readIncoming(source, transferId);
    if (!current) return { status: "not_found" };
    if (current.state !== "waiting_file") return { status: current.state };
    return withSpool((available) => current.offer.bytes <= available / 2
      ? transfer.receiveBundle(source, transferId, { signal }) : { status: "local_capacity_full" }, signal);
  }

  function releaseTargets(record, direction) {
    const directory = direction === "out" ? path.dirname(record.sourcePath) : record.staged?.directory;
    if (typeof directory !== "string") reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "文件包保留目录无效");
    const matched = path.relative(workRoot, directory);
    const expected = direction === "out" ? /^send-[A-Za-z0-9]+$/u : /^receive-[A-Za-z0-9]+$/u;
    if (!expected.test(matched)) reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "只回收本轮生成的文件包路径");
    const expectedFiles = direction === "out"
      ? [{ filePath: record.sourcePath, bytes: record.offer.bytes, sha256: record.offer.sha256 }]
      : record.staged.files;
    if (!Array.isArray(expectedFiles) || !expectedFiles.length || expectedFiles.length > limits.maxFiles
      || expectedFiles.some((file, index) => file.filePath !== path.join(directory,
        direction === "out" ? "bundle.data" : String(index) + ".data"))) {
      reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "封存文件布局变化");
    }
    return { directory, expectedFiles };
  }

  async function release({ direction, source, transferId, confirmation, signal }) {
    if (!["out", "in"].includes(direction)) reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "文件包方向无效");
    const key = relayFileJournalKey(direction, direction === "out" ? localMachine : source, transferId);
    let saved = await journal.read(key);
    if (!saved) return { status: "not_found" };
    if (saved.value.releaseState === "released") return { status: "released" };
    if (direction === "out" ? saved.value.state !== "received"
      : saved.value.state !== "acknowledged" || typeof canReleaseIncoming !== "function"
        || (await canReleaseIncoming(saved.value, confirmation, { signal })) !== true) return { status: "retained" };
    const targets = releaseTargets(saved.value, direction);
    if (saved.value.releaseState !== "releasing") {
      saved = await journal.advance(key, saved.revision, { ...saved.value, releaseState: "releasing" });
      if (!saved) return { status: "changed" };
    }
    signal?.throwIfAborted();
    let stat;
    try {
      stat = await fs.lstat(targets.directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (stat) {
      if (!stat.isDirectory() || await fs.realpath(targets.directory) !== targets.directory) {
        reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "文件包保留目录已变化");
      }
      for (const file of targets.expectedFiles) {
        signal?.throwIfAborted();
        try {
          const current = await fs.lstat(file.filePath);
          if (!current.isFile() || current.size !== file.bytes) {
            reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "文件包保留内容已变化");
          }
          const hash = createHash("sha256");
          let readBytes = 0;
          for await (const bytes of createReadStream(file.filePath, { signal })) {
            readBytes += bytes.length;
            if (readBytes > file.bytes) break;
            hash.update(bytes);
          }
          if (readBytes !== file.bytes || hash.digest("hex") !== file.sha256) {
            reject("RELAY_FILE_LOCAL_RELEASE_DENIED", "文件包保留内容与原哈希不同");
          }
          await fs.unlink(file.filePath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await fs.rmdir(targets.directory).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
    return await journal.advance(key, saved.revision, { ...saved.value, releaseState: "released" })
      ? { status: "released" } : { status: "changed" };
  }

  function validateResume({ limit = 8, after = null, relayIds } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32
      || (after !== null && (typeof after !== "string" || !/^[a-f0-9]{64}$/u.test(after)))
      || (relayIds !== undefined && (!Array.isArray(relayIds) || relayIds.length > 16
        || !relayIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 80)))) {
      reject("RELAY_FILE_RESUME_LIMIT", "文件包恢复范围无效");
    }
  }

  async function resume({ limit = 8, after = null, relayIds, signal } = {}) {
    validateResume({ limit, after, relayIds });
    const pending = [];
    for await (const row of journal.scan({ signal })) {
      const { direction, state, offer } = row.value;
      const recoverable = direction === "out" ? ["prepared", "announcing", "announced", "uploading"]
        : ["waiting_file", "received", "acknowledging"];
      if (offer && recoverable.includes(state) && (after === null || row.key > after)
        && (!relayIds || relayIds.includes(offer.relayId))) {
        pending.push({ key: row.key, direction, state, offer });
      }
    }
    pending.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const results = [];
    for (const entry of pending.slice(0, limit)) {
      signal?.throwIfAborted();
      const { direction, state, offer, key } = entry;
      let result;
      try {
        result = direction === "out"
          ? await transfer.advanceOutgoing(offer.transferId, { signal })
          : state === "waiting_file" ? await receive(offer.from, offer.transferId, { signal })
            : await transfer.confirmReceipt(offer.from, offer.transferId, { signal });
      } catch {
        signal?.throwIfAborted();
        result = { status: "reconcile_needed" };
      }
      results.push({ key, transferId: offer.transferId, direction, ...result });
    }
    return { results, next: pending.length > limit ? results.at(-1).key : null };
  }

  return {
    prepare, receive, release, resume, validateResume,
    advance: transfer.advanceOutgoing,
    acceptAnnouncement: transfer.acceptAnnouncement,
    confirmReceipt: transfer.confirmReceipt,
    acceptReceipt: transfer.acceptReceipt,
    lookupOutgoing: transfer.readOutgoing,
    lookupIncoming: transfer.readIncoming,
    reconcileCleanup: capacity.reconcile,
  };
}

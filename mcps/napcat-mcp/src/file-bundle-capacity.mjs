import { randomUUID } from "node:crypto";
import { ensureRelayFileSpace } from "./file-bundle-quota.mjs";
import { relayFileJournalKey } from "./file-bundle-journal.mjs";

function snapshot(record) {
  const { offer, route, state, file, uploadedAt, receivedAt, cleanupState, direction } = record.value;
  if (!offer || !route || !file) return null;
  return {
    ...route, origin: "relay-data-bundle", state, direction, cleanupState,
    nativeFileId: file.id, name: file.name, bytes: file.bytes, uploaderId: file.uploaderId,
    transferId: offer.transferId, bundleSha256: offer.sha256, uploadedAt, receivedAt,
  };
}

function exact(left, right) {
  return left?.id === right?.id && left?.name === right?.name
    && left?.bytes === right?.bytes && left?.uploaderId === right?.uploaderId;
}

export function createFileBundleCapacity({ journal, localMachine, provider, routeAuthorized, limits, now = Date.now }) {
  const protection = { retentionMs: limits?.retentionMs ?? 60 * 60 * 1000 };

  async function view(groupId, options) {
    const records = [];
    for await (const item of journal.scan(options)) {
      const scope = snapshot(item);
      if (scope && scope.groupId === groupId) records.push(scope);
    }
    return records;
  }

  async function settleCleanup(claim, cleanupState) {
    const attempt = claim.value.cleanupAttemptId;
    if (typeof attempt !== "string" || !attempt) return null;
    for (let attemptNumber = 0; attemptNumber < 6; attemptNumber += 1) {
      const newest = await journal.read(claim.key);
      if (!newest || newest.value.cleanupAttemptId !== attempt) return null;
      if (newest.value.cleanupState === cleanupState) return newest;
      if (newest.value.cleanupState !== "deleting") return null;
      const written = await journal.advance(newest.key, newest.revision, { ...newest.value, cleanupState });
      if (written) return written;
    }
    return null;
  }

  async function removeOwnedOnce(route, candidate, observed, { signal } = {}) {
    const options = { signal };
    const original = await journal.read(relayFileJournalKey("out", localMachine, candidate.transferId));
    const owned = original && snapshot(original);
    if (!owned || owned.direction !== "out" || owned.state !== "received" || owned.cleanupState != null
      || owned.relayId !== route.relayId || owned.groupId !== route.groupId || owned.generation !== route.generation
      || owned.uploaderId !== route.selfQqId || original.value.offer.from !== localMachine
      || owned.nativeFileId !== candidate.nativeFileId || owned.name !== candidate.name || owned.bytes !== candidate.bytes
      || owned.bundleSha256 !== candidate.bundleSha256 || owned.receivedAt !== candidate.receivedAt
      || !Number.isSafeInteger(owned.receivedAt) || now() - owned.receivedAt < protection.retentionMs
      || !exact(original.value.file, observed)) return { status: "not_sent" };
    const current = await view(route.groupId, options);
    if (current.some((entry) => entry.cleanupState === "deleting")
      || current.filter((entry) => entry.nativeFileId === owned.nativeFileId).length !== 1) {
      return { status: "unknown" };
    }
    if ((await routeAuthorized(original.value.route, "delete", options)) !== true) return { status: "not_sent" };
    signal?.throwIfAborted();
    const claim = await journal.advance(original.key, original.revision, {
      ...original.value, cleanupState: "deleting", cleanupAttemptId: randomUUID(),
    });
    if (!claim) return { status: "unknown" };
    const outcome = await provider.removeConfirmedFile(original.value.route, original.value.file, options);
    if (outcome?.status === "not_sent") return await settleCleanup(claim, null) ? outcome : { status: "unknown" };
    if (outcome?.status !== "removed") return { status: "unknown" };
    return await settleCleanup(claim, "removed") ? { status: "removed" } : { status: "unknown" };
  }

  async function reconcile(route, { signal } = {}) {
    const results = [];
    for await (const item of journal.scan({ signal })) {
      const owned = snapshot(item);
      if (!owned || owned.direction !== "out" || owned.state !== "received" || owned.cleanupState !== "deleting"
        || owned.groupId !== route.groupId) continue;
      const options = { signal };
      const permitted = (await routeAuthorized(item.value.route, "reconcile_delete", options)) === true;
      const gone = permitted ? await provider.inspectAbsence(item.value.route, owned.nativeFileId, options) : null;
      const verified = gone === true && !!await settleCleanup(item, "removed");
      results.push({ nativeFileId: owned.nativeFileId, status: verified ? "removed" : "unknown" });
    }
    return results;
  }

  async function ensureSpace(offer, route, { signal } = {}) {
    return ensureRelayFileSpace({
      route, incomingBytes: offer.bytes, limits, now: now(), signal,
      io: {
        routeStillAuthorized: (_, options) => routeAuthorized(route, "file_space", options),
        readQuota: (_, options) => provider.readQuota(route, options),
        readFileRecords: async (_, options) => {
          await reconcile(route, options);
          return view(route.groupId, options);
        },
        inspectFile: (_, fileId, options) => provider.inspectFile(route, fileId, options),
        removeOwnedOnce,
      },
    });
  }

  return { ensureSpace, reconcile };
}

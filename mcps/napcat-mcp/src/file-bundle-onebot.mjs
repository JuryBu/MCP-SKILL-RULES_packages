import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const decimal = /^[0-9]+$/u;
const positiveId = /^[1-9][0-9]{0,31}$/u;

function issue(code, message) {
  throw Object.assign(new Error(message), { code });
}

function unsigned(value) {
  if (typeof value === "string" && decimal.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function id(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) return "";
  return (typeof value === "number" || typeof value === "string") && positiveId.test(String(value)) ? String(value) : "";
}

function groupFile(raw) {
  const fileId = typeof raw?.file_id === "string" ? raw.file_id : "";
  const name = typeof raw?.file_name === "string" ? raw.file_name : "";
  const uploaderId = id(raw?.uploader ?? raw?.uploader_id);
  const bytes = unsigned(raw?.file_size ?? raw?.size);
  if (!fileId || fileId.length > 512 || /[\s\u0000-\u001f]/u.test(fileId)
    || !name || Buffer.byteLength(name) > 255 || !uploaderId || bytes === null) return null;
  return { id: fileId, name, uploaderId, bytes, busId: unsigned(raw.busid) };
}

function sameFile(file, expected) {
  return file?.id === expected.id && file?.name === expected.name
    && file?.bytes === expected.bytes && file?.uploaderId === expected.uploaderId;
}

function isCompleteRoot(listed, expectedCount) {
  return expectedCount === listed.all.length && Array.isArray(listed.folders) && !listed.folders.length
    && listed.identities.length === listed.all.length
    && new Set(listed.identities.map((file) => file.id)).size === listed.all.length;
}

function withDeadline(parent, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("群文件下载超时"), {
    code: "RELAY_FILE_DOWNLOAD_TIMEOUT",
  })), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}

async function writeChunk(output, chunk, signal) {
  let offset = 0;
  while (offset < chunk.length) {
    signal?.throwIfAborted();
    const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, null);
    if (!bytesWritten) issue("RELAY_FILE_DOWNLOAD_WRITE_FAILED", "写入临时文件未推进");
    offset += bytesWritten;
  }
}

async function confirmLocalChild(root, localPath, allowMissing) {
  if (typeof localPath !== "string" || !path.isAbsolute(localPath)) {
    issue("RELAY_FILE_LOCAL_PATH_DENIED", "文件路径须位于本机私有运输目录");
  }
  const parent = await fs.realpath(path.dirname(localPath));
  const relative = path.relative(root, parent);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    issue("RELAY_FILE_LOCAL_PATH_DENIED", "文件路径不在本机私有运输目录");
  }
  const exact = path.join(parent, path.basename(localPath));
  if (!allowMissing && !(await fs.lstat(exact)).isFile()) {
    issue("RELAY_FILE_LOCAL_PATH_DENIED", "上传只接受本机封存的普通文件");
  }
  return exact;
}

export async function createFileBundleOneBot({
  workRoot, callOneBot, routeAuthorized, downloadOrigins = [], fileCountLimit = 1500, fetchImpl = fetch,
  downloadTimeoutMs = 60_000,
}) {
  if (!Number.isSafeInteger(fileCountLimit) || fileCountLimit < 1 || fileCountLimit > 4096) {
    issue("RELAY_FILE_SCAN_LIMIT_INVALID", "群文件扫描上限无效");
  }
  if (!Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1 || downloadTimeoutMs > 600_000) {
    issue("RELAY_FILE_DOWNLOAD_LIMIT_INVALID", "群文件下载期限无效");
  }
  const root = await fs.realpath(workRoot);
  const origins = new Set(downloadOrigins);

  async function checked(route, purpose, signal) {
    signal?.throwIfAborted();
    const allowed = id(route?.groupId) && await routeAuthorized(route, purpose, { signal }) === true;
    signal?.throwIfAborted();
    if (!allowed) issue("RELAY_FILE_ROUTE_DENIED", "原群文件路线当前未获准");
  }

  async function rootFiles(route, signal) {
    await checked(route, "list", signal);
    const result = await callOneBot("get_group_root_files", {
      group_id: route.groupId, file_count: fileCountLimit,
    }, { signal });
    if (!Array.isArray(result?.files) || result.files.length > fileCountLimit) {
      issue("RELAY_FILE_LIST_UNKNOWN", "群文件列表缺失或超出扫描上限");
    }
    return { all: result.files, identities: result.files.map(groupFile).filter(Boolean), folders: result.folders };
  }

  async function readQuota(route, { signal } = {}) {
    await checked(route, "quota", signal);
    const raw = await callOneBot("get_group_file_system_info", { group_id: route.groupId }, { signal });
    const fileCount = unsigned(raw?.file_count);
    let usedBytes = unsigned(raw?.used_space);
    if (fileCount > 0 && !(usedBytes > 0)) {
      const root = await rootFiles(route, signal);
      usedBytes = isCompleteRoot(root, fileCount) ? unsigned(root.identities.reduce((sum, file) => sum + file.bytes, 0)) : null;
    }
    return {
      fileCount,
      fileCapacity: unsigned(raw?.limit_count),
      usedBytes,
      totalBytes: unsigned(raw?.total_space),
    };
  }

  async function findUpload(offer, route, uploaderId, { signal, fileId } = {}) {
    const { all, identities } = await rootFiles(route, signal);
    const matches = identities.filter((file) => file.uploaderId === uploaderId
      && file.bytes === offer.bytes && file.name === offer.name && (fileId === undefined || file.id === fileId));
    return matches.length === 1 && all.filter((raw) => raw?.file_id === matches[0].id).length === 1
      ? { status: "sent", file: matches[0] } : { status: "unknown" };
  }

  async function upload(offer, route, localBundle, { signal } = {}) {
    const file = await confirmLocalChild(root, localBundle, false);
    if ((await fs.stat(file)).size !== offer.bytes) return { status: "not_sent", reason: "local_size_changed" };
    try {
      await checked(route, "upload", signal);
    } catch {
      return { status: "not_sent", reason: "route_changed" };
    }
    try {
      const result = await callOneBot("upload_group_file", { group_id: route.groupId, file, name: offer.name }, { signal });
      const fileId = typeof result?.file_id === "string" && result.file_id ? result.file_id : undefined;
      return await findUpload(offer, route, route.selfQqId, { signal, fileId });
    } catch {
      return { status: "unknown" };
    }
  }

  async function inspectFile(route, fileId, { signal } = {}) {
    const { all, identities } = await rootFiles(route, signal);
    const matches = identities.filter((file) => file.id === fileId);
    if (matches.length !== 1 || all.filter((raw) => raw?.file_id === fileId).length !== 1) return null;
    return matches[0];
  }

  async function downloadToPrivateFile(offer, route, expected, localDestination, signal) {
    const destination = await confirmLocalChild(root, localDestination, true);
    const live = await inspectFile(route, expected.id, { signal });
    if (!sameFile(live, expected) || live.uploaderId !== route.peerQqId
      || live.name !== offer.name || live.bytes !== offer.bytes) {
      issue("RELAY_FILE_OBSERVATION_CHANGED", "群内文件身份在下载前变化");
    }
    await checked(route, "download", signal);
    const data = await callOneBot("get_group_file_url", {
      group_id: route.groupId, file_id: live.id, ...(live.busId === null ? {} : { busid: live.busId }),
    }, { signal });
    let url;
    try {
      url = new URL(data?.url ?? "");
    } catch {
      issue("RELAY_FILE_URL_INVALID", "群文件未返回有效下载地址");
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !origins.has(url.origin)) {
      issue("RELAY_FILE_URL_DENIED", "群文件下载地址未列入本机许可来源");
    }
    await checked(route, "download", signal);
    const response = await fetchImpl(url, { redirect: "error", signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      issue("RELAY_FILE_DOWNLOAD_FAILED", "群文件下载未返回有效数据");
    }
    const stream = Readable.fromWeb(response.body);
    let output;
    let written = 0;
    let saved = false;
    const digest = createHash("sha256");
    try {
      output = await fs.open(destination, "wx", 0o600);
      try {
        for await (const chunk of stream) {
          written += chunk.length;
          if (written > offer.bytes) issue("RELAY_FILE_SIZE_LIMIT", "下载字节超过可信预告");
          await writeChunk(output, chunk, signal);
          digest.update(chunk);
        }
        if (written !== offer.bytes || digest.digest("hex") !== offer.sha256) {
          issue("RELAY_FILE_DOWNLOAD_MISMATCH", "群文件内容与可信预告不符");
        }
        await output.sync();
      } finally {
        await output.close();
      }
      saved = true;
    } finally {
      stream.destroy();
      if (output && !saved) await fs.unlink(destination).catch(() => {});
    }
  }

  async function download(offer, route, expected, localDestination, { signal } = {}) {
    const pending = withDeadline(signal, downloadTimeoutMs);
    try {
      await downloadToPrivateFile(offer, route, expected, localDestination, pending.signal);
    } finally {
      pending.close();
    }
  }

  async function inspectAbsence(route, fileId, { signal } = {}) {
    function identity(listed) {
      return JSON.stringify(listed.identities.map((file) => JSON.stringify(file)).sort());
    }
    const first = await rootFiles(route, signal);
    if (first.all.some((raw) => raw?.file_id === fileId)) return false;
    const firstQuota = await readQuota(route, { signal });
    if (!isCompleteRoot(first, firstQuota.fileCount)) return null;
    const second = await rootFiles(route, signal);
    if (second.all.some((raw) => raw?.file_id === fileId)) return false;
    const secondQuota = await readQuota(route, { signal });
    return isCompleteRoot(second, secondQuota.fileCount) && JSON.stringify(firstQuota) === JSON.stringify(secondQuota)
      && identity(first) === identity(second) ? true : null;
  }

  async function removeConfirmedFile(route, proven, { signal } = {}) {
    if (proven?.uploaderId !== route.selfQqId) return { status: "not_sent" };
    try {
      const current = await inspectFile(route, proven.id, { signal });
      if (!sameFile(current, proven)) return { status: "not_sent" };
      await checked(route, "delete", signal);
    } catch {
      return { status: "not_sent" };
    }
    try {
      await callOneBot("delete_group_file", { group_id: route.groupId, file_id: proven.id }, { signal });
      return await inspectAbsence(route, proven.id, { signal }) === true ? { status: "removed" } : { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  }

  return { readQuota, findUpload, upload, inspectFile, download, inspectAbsence, removeConfirmedFile };
}

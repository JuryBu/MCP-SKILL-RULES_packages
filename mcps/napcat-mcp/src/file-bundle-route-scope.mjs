const folderName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function fileBundleRouteScope(route) {
  return {
    ...(route?.legacyTrainingCoexistence === true ? { legacyTrainingCoexistence: true } : {}),
    ...(route?.fileBundleFolderId != null ? { fileBundleFolderId: route.fileBundleFolderId } : {}),
    ...(route?.fileBundleFolderName != null ? { fileBundleFolderName: route.fileBundleFolderName } : {}),
  };
}

export function sameFileBundleRouteScope(left, right) {
  return (left?.legacyTrainingCoexistence ?? false) === (right?.legacyTrainingCoexistence ?? false)
    && (left?.fileBundleFolderId ?? null) === (right?.fileBundleFolderId ?? null)
    && (left?.fileBundleFolderName ?? null) === (right?.fileBundleFolderName ?? null);
}

export function pinnedFileBundleFolderId(route) {
  const value = route?.fileBundleFolderId;
  const name = route?.fileBundleFolderName;
  if (value == null && name == null && route?.legacyTrainingCoexistence !== true) return null;
  if (value == null || name == null) {
    throw Object.assign(new Error("群文件包须绑定实际目录标识与名称"), { code: "RELAY_FILE_FOLDER_REQUIRED" });
  }
  if (typeof value !== "string" || !value || value.length > 512 || ["/", ".", ".."].includes(value)
    || /[\\\s\u0000-\u001f]/u.test(value) || typeof name !== "string" || !folderName.test(name)) {
    throw Object.assign(new Error("群文件目录标识或名称无效"), { code: "RELAY_FILE_FOLDER_INVALID" });
  }
  return value;
}

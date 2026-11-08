import fs from "node:fs";
import path from "node:path";
import { readWorkspaceMeta, workspaceHash, WORKSPACES_DIR } from "./store.js";

export function describeUnavailableMemory(hash: string, id: string): string {
    const missing = `❌ 记忆文件已丢失: ${id}（索引存在但文件不存在）`;
    if (hash === "general") return missing;
    const meta = readWorkspaceMeta(hash);
    const hasArchive = fs.existsSync(path.join(WORKSPACES_DIR, hash, "_archive.gz"));
    if (!meta?.isArchived && !hasArchive) return missing;
    const status = meta?.isArchived ? `📦 记忆所在工作区已归档: ${id}` : `⚠️ 记忆活跃正文未找到，所在工作区有归档包: ${id}`;
    if (!hasArchive) return `${status}\n归档包 _archive.gz 当前缺失，请核对该工作区的备份与归档状态。`;
    if (meta?.hash !== hash || !meta.originalPath || workspaceHash(meta.originalPath) !== hash) {
        return `${status}\n归档包存在，工作区归属元信息尚未核实（${hash}），请先核对归属再恢复。`;
    }
    if (!meta.isArchived) return `${status}\n状态核对入口: memory_stats(${JSON.stringify({ action: "detail", workspace: meta.originalPath })})`;
    return `${status}\n工作区: ${meta.originalPath}\n恢复入口: memory_stats(${JSON.stringify({ action: "unarchive", workspace: meta.originalPath })})\n解归档会恢复该工作区的全部归档记忆，完成后可重试原操作。`;
}

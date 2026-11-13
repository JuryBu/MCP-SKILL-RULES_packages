# LS 升级建议 — web-fetcher MCP

> 基于 ls-tools 反向工程经验，针对 web-fetcher 的进程生命周期升级建议。
> 2026-03-18 | 详细原理见同目录 `LS-Principles.md`

补充范围说明：

- 本文聚焦 Antigravity Language Server 作为父进程时的生命周期与退出策略。
- 当前模型桥使用 `modelChain="auto|antigravity|codex|claude-code"`，旧 `chain` 继续兼容，具体入口以[反重力模型桥](docs/antigravity-model-bridge.md)为准。
- 这里讨论的升级建议主要仍对应 `chain="antigravity"` 场景；网页抓取主链和 `chain="codex"` 的模型桥不依赖本文中的 LS RPC 生命周期细节。

## 当前模型入口约定（2026-11-13）

7.4.1现代目录的自动材料型号为Hydrogen XHigh→Hydrogen High→Carbon High，视觉为Carbon High；请求`model`及`WEB_FETCHER_LS_MODEL`均固定本次型号并传至文本／图片入口，旧目录协议兼容保持。多页审查的队列等待计入父总期限，每页预算从取得执行位起计；生成到期后仍独立执行有界自有资源清理。Windows生命周期识别迁至CIM，以下旧WMIC相关示例只保留历史背景。

App 在线时，纯文字继续优先使用新版 App LS 或旧 LS。App 离线时，请求带 `schema` 的结构化文本使用隔离工作目录与配置的 ACP `cli-agent` 文本入口，图片数为0；无 `schema` 的轻量纯文字保留按需 `cli-ls`。图片附件继续使用既有ACP图片机制。

agent 只有在明确未提交、结果为 `not-started` 或明确 `unsupported`，并且 `safeToFallback=true` 时，才在原总期限内兼容到 `cli-ls`。认证、准入、额度、拒绝、取消和未知结果停止后备；不借此重新提交原未知任务。

清理未确认时，即使尚未提交生成也停止入口续选。已有 `WEB_FETCHER_LS_MODEL` 配置在App离线的schema ACP文本入口继续用于显式模型选择。

自有CLI结束后正常退出，借用的App和其它MCP保持运行。候选05图片成功、候选06 LS摘要500／结果未知、候选07未实际生成和候选08正常MCP摘要／视觉成功的范围，见[反重力模型桥](docs/antigravity-model-bridge.md)。以下生命周期方案保留其历史背景，正式部署、加载和正式HTTP验收分别记录。

---

## 背景问题

web-fetcher 当前使用**最后工具调用时间 + 超时阈值**来决定是否自杀。
这导致一个关键痛点：

> AI 在对话中用浏览器子代理、编辑代码、思考等操作了 1 小时，
> 期间没有调用 web-fetcher 的任何工具，
> → web-fetcher 超时自杀 → 下次调用时 EOF 报错 → 需要用户重启窗口

**真正的语义**应该是：只要用户的窗口还开着，MCP 就应该活着。

---

## 升级方案

### 1. 核心改动：lifecycle.ts

```typescript
// === 新增：父进程存活检测 ===

/**
 * 检测父 LS 进程是否还活着
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）
 * process.kill(pid, 0) 是跨平台的存活探针，微秒级，不发真信号
 */
function isParentAlive(): boolean {
    try {
        process.kill(process.ppid, 0);
        return true;
    } catch {
        return false;
    }
}
```

### 2. index.ts 心跳改造

**替换前**（旧逻辑）：
```typescript
const HEARTBEAT_PROCESS_TIMEOUT = 40 * 60 * 1000; // 40 分钟超时

const heartbeatInterval = setInterval(async () => {
    const idle = getIdleTime();
    if (idle > HEARTBEAT_PROCESS_TIMEOUT) {
        await cleanup();
        process.exit(0);  // 💀 误杀！AI 可能还在工作
    }
}, 60000);
```

**替换后**（新逻辑）：
```typescript
// 不再需要 HEARTBEAT_PROCESS_TIMEOUT 常量

const heartbeatInterval = setInterval(async () => {
    // 父 LS 消失 = 窗口关闭 → MCP 跟着退出
    if (!isParentAlive()) {
        logStdinEvent(`父 LS (PID=${process.ppid}) 已消失，MCP 退出`);
        console.error(`[web-fetcher] 父 LS 进程已消失，自动退出`);
        await cleanup();
        process.exit(0);
    }
}, 30000);  // 30s 检测间隔（足够快，又不浪费 CPU）
```

### 3. 保留 stdin 断开检测

原有的 `stdin.on('end'/'close'/'error')` 继续保留，作为**第一层防线**（秒级响应）。
ppid 检测作为**第二层防线**（30 秒内响应），防止 stdin 事件丢失。

### 4. web-fetcher 特有注意事项

#### 4.1 Playwright 浏览器进程

web-fetcher 内部可能启动了 Chromium 浏览器进程（Playwright）。
cleanup 时需要确保浏览器进程也被正确关闭：

```typescript
const cleanup = async () => {
    console.error("[web-fetcher] 正在关闭...");
    clearInterval(heartbeatInterval);
    // 确保关闭所有 Playwright browser 实例
    await closeBrowser?.();  
    // 清理临时截图文件等
    cleanOldTempFiles?.();
};
```

#### 4.2 Cookie 持久化不受影响

web-fetcher 的登录态 Cookie 已经持久化到磁盘，MCP 退出不会丢失。
新窗口启动的新 MCP 实例会自动加载已有 Cookie。

#### 4.3 web_interact 会话

`web_interact` 的 sessionId 会话在 MCP 退出时自然失效。
这与当前行为一致，没有变化。

---

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/lifecycle.ts` | 新增 `isParentAlive()` 函数 |
| `src/index.ts` | 替换心跳超时逻辑为 ppid 存活检测 |

**预估代码变更量**：约 15 行改动（删除超时逻辑 ~5 行，新增 ppid 检测 ~10 行）

---

## 效果对比

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| AI 工作 1 小时没用 web-fetcher | **EOF 自杀** 💀 | 窗口开着 → **活着** ✅ |
| 用户睡觉 8 小时 | **EOF 自杀** 💀 | 窗口开着 → **活着** ✅ |
| 用户关闭窗口 | 可能泄漏进程 | **30s 内自动退出** ✅ |
| 开 100 个窗口关 50 个 | 超时很混乱 | 精确跟随各自窗口 ✅ |
| 不同窗口的 MCP 串用 | 不会（stdio 隔离） | 不会（ppid 也隔离） ✅ |

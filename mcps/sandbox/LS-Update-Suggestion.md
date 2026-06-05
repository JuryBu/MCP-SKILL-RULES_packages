# LS 升级建议 — sandbox MCP

> 基于 ls-tools 反向工程经验，针对 sandbox 的进程生命周期升级建议。
> 2026-04-26 | 详细原理见同目录 `LS-Principles.md`

---

## 背景问题

sandbox 当前使用 **30 分钟无活动超时** 来自杀。
虽然有 Codex 运行中免死的逻辑（`getCodexTaskCount().running > 0 → touchActivity()`），
但本质仍是基于"MCP 工具调用频率"而非"窗口是否还在"来判断。

> AI 在对话中做代码编辑、思考、用浏览器等操作了 1 小时，
> 期间没有调用 sandbox 的任何工具，
> → sandbox 30 分钟超时自杀 → 下次调用时 EOF → 用户需要重启窗口

---

## 范围说明（双链路后）

本文档讨论的是 **LS 生命周期与 LS 链路发现**，范围只覆盖：

- Antigravity 宿主下的 ppid 绑定
- `smart_search(mode="smart", chain="antigravity")` 的 LS 模型调用

它不覆盖 `chain="codex"` 的模型桥。Codex 链路由本地 `codex exec` 提供，生命周期、错误模式和可观测性与 LS 不同，但不会改变 `exact` / `fuzzy` 的行为。

因此后续如果看到 sandbox 同时支持 `antigravity` / `codex` 两条模型链，请把本文理解成“LS 分支说明”，不要把它当成整个 smart_search 的唯一原理文档。

---

## 升级方案

### 1. 核心改动：lifecycle.ts

```typescript
// === 新增：父进程存活检测 ===

/**
 * 检测父 LS 进程是否还活着
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）
 */
export function isParentAlive(): boolean {
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
const HEARTBEAT_PROCESS_TIMEOUT = 30 * 60 * 1000;

const heartbeatInterval = setInterval(async () => {
    const idle = getIdleTime();

    // Codex 运行中免死
    const codexTasks = getCodexTaskCount();
    if (codexTasks.running > 0) {
        touchActivity();
        return;
    }

    if (idle > HEARTBEAT_PROCESS_TIMEOUT) {
        await cleanup();
        process.exit(0);
    }
}, 60000);
```

**替换后**（新逻辑）：
```typescript
const heartbeatInterval = setInterval(async () => {
    // 父 LS 消失 = 窗口关闭 → MCP 跟着退出
    if (!isParentAlive()) {
        logStdinEvent(`父 LS (PID=${process.ppid}) 已消失，MCP 退出`);
        console.error(`[sandbox] 父 LS 进程已消失，自动退出`);
        await cleanup();
        process.exit(0);
    }
}, 30000);
```

> 注意：Codex 运行中免死逻辑**不再需要**了——因为只要窗口开着 LS 就在，
> MCP 就不会退出，Codex 自然也不会被打断。

### 3. sandbox 特有注意事项

#### 3.1 sandbox_launch 脱离进程 — 完全不受影响 ✅

launch 任务的进程设计是 `spawn + unref()`（见 launch.ts L356-364）：
- stdout/stderr 重定向到磁盘日志文件，不走 MCP 管道
- `proc.unref()` 解除了 Node event loop 对子进程的引用
- 注册表 `registry.json` 持久化在磁盘

**MCP 退出时的 cleanup 行为**（index.ts L308-314）：
```typescript
const cleanup = async () => {
    closeAllSessions();    // 关闭 REPL 会话 ← 只清理 session
    cleanupCodexTasks();   // 清理 Codex 任务  ← 只清理 codex
    // launch 任务不在这里！ ✅
};
```

所以：
- MCP 退出 → launch 进程**继续运行**（因为 unref + 独立 stdio）
- 新的 MCP 实例启动后 → `sandbox_launch(action="list")` 可以找回
- launch 进程的状态通过 `isPidAlive()` + 注册表判断

#### 3.2 sandbox_session REPL 会话

REPL 会话是 MCP 的子进程，MCP 退出时 `closeAllSessions()` 会关闭它们。
这与当前行为一致——窗口关闭时 REPL 就该清理。

#### 3.3 sandbox_codex 后台任务

Codex 任务是 MCP 的子进程（非脱离），MCP 退出时 `cleanupCodexTasks()` 会杀掉。
与当前行为一致。

**注意**：如果 AI 正在等待 Codex 结果但窗口被关闭了，Codex 任务会被终止。
这是合理的——窗口关了就没有上下文返回结果了。
如果需要跨窗口存活的任务，应使用 `sandbox_launch` 而非 `sandbox_codex`。

#### 3.4 进程树清理保持不变

executor.ts 中的 `killProcessTree()` 用于清理子进程树（taskkill /PID /T /F）。
这与 ppid 改动无关，继续正常工作。

---

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/lifecycle.ts` | 新增 `isParentAlive()` 导出函数 |
| `src/index.ts` | 替换心跳超时逻辑为 ppid 存活检测；移除 Codex 免死逻辑（不再需要） |

**预估代码变更量**：约 20 行改动（删除旧超时+Codex免死 ~10 行，新增 ppid 检测 ~10 行）

---

## 效果对比

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| AI 工作 1 小时没用 sandbox | **EOF 自杀** 💀 | 窗口开着 → **活着** ✅ |
| Codex 后台运行 | 特殊免死逻辑保活 | **不需要特殊逻辑**，天然活着 ✅ |
| 用户关闭窗口 | 可能泄漏进程 | **30s 内自动退出** ✅ |
| launch 任务 | 不受超时影响 | **继续不受影响** ✅ |
| REPL 会话 | 超时杀 MCP 时一起清理 | 窗口关闭时一起清理 ✅ |
| 100 个窗口关 50 个 | 各自独立超时 | 精确跟随各自窗口 ✅ |

---

## 额外建议：sandbox 独有的 LS API 潜在应用

sandbox 未来可以利用 LS RPC API 实现更智能的功能：

### 对话状态感知执行

```typescript
// 检测当前对话是否活跃，用于决定执行策略
const status = await getConversationStatus();
if (status === 'RUNNING') {
    // AI 正在生成 → 执行任务可能被频繁调用，优化批处理
} else {
    // AI 空闲 → 可以做更重的预处理/缓存刷新
}
```

### Codex 报告自动通知

```typescript
// Codex 完成后，如果对话处于 IDLE，可以通过 LS API 发送提醒
if (codexDone && conversationIdle) {
    await sendActionToChatPanel(lsInfo, port, {
        message: `Codex 任务 ${taskId} 已完成，报告: ${outputFile}`
    });
}
```

这些是未来的增强方向，当前升级优先聚焦于进程生命周期改造。

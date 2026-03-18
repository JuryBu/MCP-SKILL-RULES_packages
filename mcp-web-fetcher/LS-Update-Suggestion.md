# LS 升级建议 — web-fetcher MCP

> 基于 ls-tools 反向工程经验，针对 web-fetcher 的进程生命周期升级建议。
> 2026-03-18 | 详细原理见同目录 `LS-Principles.md`

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

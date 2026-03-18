# Language Server (LS) 进程原理 — MCP 开发者参考

> 本文档由 ls-tools 插件的反向工程经验整理而成，供 MCP 开发 AI 理解 LS 进程机制。
> 最后更新：2026-03-18

---

## 1. LS 进程是什么

Language Server（`language_server_windows_x64`）是 Antigravity IDE **每个窗口**独立启动的后台进程。
它负责：

- **AI 对话管理**：所有 Cascade 对话的生命周期（创建、发送、接收、回溯、删除）
- **模型调用代理**：向远端 API 发起请求，管理 token 配额、流式传输
- **对话数据加密存储**：`.pb` 文件（AES-GCM/ChaCha20 加密的 protobuf）
- **代码补全、索引、搜索**等 IDE 基础功能
- **MCP 子进程管理**：通过 stdio 管道启动和通信

**核心原则：一个窗口 = 一个 LS 进程 = 该窗口所有 MCP 的父进程**

---

## 2. 进程树关系

```
Antigravity IDE 窗口 A
  └→ language_server_windows_x64 (PID=10508)      ← LS 主进程
       ├→ node mcp-memory-store/dist/index.js  (PID=4776)   ppid=10508 ✅
       ├→ node mcp-sandbox/dist/index.js       (PID=22280)  ppid=10508 ✅
       └→ node mcp-web-fetcher/dist/index.js   (PID=2524)   ppid=10508 ✅

Antigravity IDE 窗口 B
  └→ language_server_windows_x64 (PID=99999)      ← 另一个 LS
       ├→ node mcp-memory-store/dist/index.js  (PID=xxxxx)  ppid=99999
       ├→ node mcp-sandbox/dist/index.js       (PID=yyyyy)  ppid=99999
       └→ node mcp-web-fetcher/dist/index.js   (PID=zzzzz)  ppid=99999
```

### 已验证的事实（2026-03-18 实测）

| 结论 | 验证方式 |
|------|---------|
| LS 直接 spawn MCP Node 进程，**中间无 shell** | `process.ppid` 直指 LS PID |
| `process.ppid` 在三个 MCP 中**都可靠** | 三个 MCP 的 ppid 均 = LS PID |
| 每个窗口的 MCP 进程完全独立，**不会串用** | stdio 管道是匿名的一对一连接 |
| 窗口关闭 → LS 消失 → stdio 管道断裂 | `stdin.on('end')` 事件触发 |

---

## 3. LS 进程的生死与对话状态

### 3.1 LS 进程的生命周期

```
窗口打开 → LS 启动 → spawn 所有 MCP → 服务运行中
窗口关闭 → LS 被杀 → stdio 管道断裂 → MCP 应自行退出
```

### 3.2 对话状态枚举

LS 内部对每个 Cascade 对话维护状态机：

| 状态 | 含义 |
|------|------|
| `RUNNING` | AI 正在生成回复 |
| `QUEUED` | 等待处理 |
| `CANCELLING` | 用户取消中 |
| `IDLE` | 空闲，等待用户输入 |
| `COMPLETED` | 对话正常结束 |
| `ERRORED` | 发生错误 |

**活跃状态** = `RUNNING` / `QUEUED` / `CANCELLING`
**静止状态** = `IDLE` / `COMPLETED` / `ERRORED`

### 3.3 对话与 LS 的绑定

- 一个 LS 可以持有**多个对话**（用户在同一窗口切换对话）
- 对话 ID = `cascadeId`（UUID 格式）
- 热对话在 LS 内存中，冷对话持久化为 `.pb` 文件到 `~/.gemini/antigravity/conversations/`

---

## 4. 可用的 LS RPC API

LS 暴露 connect-rpc (HTTP POST + JSON) 接口，监听在 `127.0.0.1` 的动态端口。

### 4.1 连接认证

```
POST http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{Method}
Headers:
  Content-Type: application/json
  x-codeium-csrf-token: {从命令行参数 --csrf_token 获取}
  Connect-Protocol-Version: 1
Body: JSON payload
```

### 4.2 已知可用 API

| 方法 | 用途 | 负载 |
|------|------|------|
| `Heartbeat` | 健康检查 | `{}` |
| `GetAllCascadeTrajectories` | 获取所有对话摘要列表（轻量，~46KB） | `{}` |
| `GetCascadeTrajectorySteps` | 获取对话的详细步骤（重量级，按 ~5MB 分页） | `{cascadeId, stepOffset}` |
| `GetModelResponse` | 调用 AI 模型生成回复（可指定模型） | `{model, prompt}` |

### 4.3 discoverLsProcesses 参考实现

```typescript
// PowerShell 一次性获取 PID + 命令行 + 监听端口
const psScript = `
Get-Process -Name language_server_windows_x64 -ErrorAction SilentlyContinue | ForEach-Object {
  $id = $_.Id
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").CommandLine
  $ports = (Get-NetTCPConnection -OwningProcess $id -State Listen | Select -Expand LocalPort) -join ","
  "$id|$cmd|$ports"
}`;

// 从命令行解析：
//   --csrf_token  → 认证 token
//   --workspace_id → 工作区标识
```

---

## 5. MCP 与 LS 的通信链路

```
AI 输出 → IDE 前端 → LS 管理器 → stdio 管道 → MCP 进程
                                                |
MCP 也可以反向调用 LS：                          |
  HTTP POST → 127.0.0.1:{port} → LS RPC API ←--+
```

MCP 和 LS 之间有**两条通道**：
1. **stdio 管道**（MCP 协议通信，AI ↔ MCP 工具）— 由 SDK 自动管理
2. **HTTP RPC**（MCP 主动查询 LS 数据）— 需要自己实现发现 + 认证

stdio 管道断裂是 MCP 感知"窗口关闭"的**最快信号**。

---

## 6. ppid 绑定机制

### 核心发现

```typescript
// 在任何 MCP 进程中
const myLsPid = process.ppid;  // 直接就是父 LS 的 PID！
```

### 检测父进程存活（跨平台，微秒级）

```typescript
function isParentAlive(): boolean {
    try {
        process.kill(process.ppid, 0);  // signal 0：不发真信号，只检查存活
        return true;
    } catch {
        return false;  // 进程已不存在
    }
}
```

### 与 LS 同生共死

```typescript
// 替代旧的超时自杀：
setInterval(async () => {
    if (!isParentAlive()) {
        console.error(`父 LS (PID=${process.ppid}) 已消失，MCP 退出`);
        await cleanup();
        process.exit(0);
    }
}, 30000);  // 每 30s 检测一次
```

**双保险**：
1. `stdin.on('end')` → 管道断裂，秒级响应（已有）
2. `process.kill(ppid, 0)` → 父进程消失检测，30s 内响应（新增）

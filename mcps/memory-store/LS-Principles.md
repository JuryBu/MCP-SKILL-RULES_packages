# Language Server (LS) 进程原理 — memory-store 开发者参考

> 本文档由 ls-tools 插件反向工程 LS 进程机制后整理而成。
> memory-store 是三个 MCP 中唯一需要与 LS 进行数据交互的（conversation_read_original, autoSummary），
> 因此本文档更侧重 LS 的数据 API 和对话管理机制。
> 最后更新：2026-03-18

---

## 1. LS 进程是什么

Language Server（`language_server_windows_x64`）是 Antigravity IDE **每个窗口**独立启动的后台进程，
是一个 Go 编写的二进制，负责：

- **AI 对话管理**：所有 Cascade 对话的生命周期（创建、发送、接收、回溯、删除）
- **模型调用代理**：向远端 API 发起请求，管理 token 配额、流式传输
- **对话数据加密存储**：`.pb` 文件（AES-GCM/ChaCha20 加密的 protobuf），存于 `~/.gemini/antigravity/conversations/`
- **代码补全、索引、搜索**等 IDE 基础功能
- **MCP 子进程管理**：通过 stdio 管道启动和通信

**核心原则：一个窗口 = 一个 LS 进程 = 该窗口所有 MCP 的父进程**

### 1.1 双链路背景补充

memory-store 需要同时理解两类宿主链路：

- `antigravity`：传统 Antigravity Language Server 链路
- `codex`：Codex 本地线程索引 + 原始事件流 + 模型桥链路

工具层统一约定 `chain="auto|antigravity|codex"`：

- `auto`：优先当前宿主；当前宿主不可用时才尝试另一侧
- `antigravity`：强制走 LS
- `codex`：强制走 Codex 本地链路

显式链路选择失败时直接报错，不做静默回退。

---

## 2. 进程树关系（已验证）

```
Antigravity IDE 窗口 A
  └→ language_server_windows_x64 (PID=10508)      ← LS 主进程
       ├→ node mcp-memory-store/dist/index.js  (PID=4776)   ppid=10508 ✅
       ├→ node mcp-sandbox/dist/index.js       (PID=22280)  ppid=10508 ✅
       └→ node mcp-web-fetcher/dist/index.js   (PID=2524)   ppid=10508 ✅

Antigravity IDE 窗口 B
  └→ language_server_windows_x64 (PID=99999)      ← 另一个独立的 LS
       ├→ node mcp-memory-store/dist/index.js  (PID=xxxxx)  ppid=99999
       ├→ node mcp-sandbox/dist/index.js       (PID=yyyyy)  ppid=99999
       └→ node mcp-web-fetcher/dist/index.js   (PID=zzzzz)  ppid=99999
```

### 2.1 已验证的事实（2026-03-18 实测）

| 结论 | 验证方式 |
|------|---------|
| LS 直接 spawn MCP Node 进程，**中间无 shell** | `process.ppid` 直指 LS PID |
| `process.ppid` 在三个 MCP 中**都精确可靠** | 三个 MCP 的 ppid 均 = LS PID |
| 每个窗口的 MCP 进程完全独立，**不会串用** | stdio 管道是匿名的一对一连接 |
| 窗口关闭 → LS 消失 → stdio 管道断裂 | `stdin.on('end')` 事件触发 |
| LS 不重启时，PID、端口、CSRF token **均保持不变** | 命令行参数和端口绑定在进程启动时确定 |

### 2.2 MCP 与 LS 的双通道通信

```
通道 1（被动）：AI → IDE 前端 → LS → stdio 管道 → MCP
  └→ MCP 协议通信（工具调用/结果返回），由 @modelcontextprotocol/sdk 自动管理

通道 2（主动）：MCP → HTTP POST → 127.0.0.1:{port} → LS RPC API
  └→ MCP 主动查询 LS 数据（对话步骤、模型调用等），需自行实现发现 + 认证
```

stdio 管道断裂是 MCP 感知"窗口关闭"的**最快信号**（秒级）。

---

## 3. LS 进程的生命周期与对话状态

### 3.1 进程生命周期

```
窗口打开 → LS 启动 → spawn 所有 MCP → 服务持续运行
窗口关闭 → LS 被杀 → stdio 管道断裂 → MCP 应自行退出
```

### 3.2 对话状态

LS 内部对每个 Cascade 对话维护状态机：

| 状态 | 含义 |
|------|------|
| `RUNNING` | AI 正在生成回复 |
| `QUEUED` | 等待处理 |
| `CANCELLING` | 用户取消中 |
| `IDLE` | 空闲，等待用户输入 |
| `COMPLETED` | 对话正常结束 |
| `ERRORED` | 发生错误 |

### 3.3 对话与 LS 的绑定关系

- 一个 LS 持有**该窗口内所有对话**（当前对话 + 历史对话）
- 对话 ID = `cascadeId`（UUID 格式）
- **热对话**：在 LS 内存中，通过 `GetAllCascadeTrajectories` 可见（轻量 API，~46KB）
- **冷对话**：持久化为 `.pb` 文件到磁盘，LS 可按需加载（通过 `GetCascadeTrajectorySteps` 触发）
- `.pb` 文件在 `~/.gemini/antigravity/conversations/` 目录是**全局共享**的——任何 LS 都可以加载任意 `.pb`

### 3.4 对话分类（对 conversation_read_original 的意义）

| 分类 | 特征 | 获取路径 |
|------|------|---------|
| ①当前对话 | 在父 LS 的热列表中，状态活跃 | 父 LS 直接拉取 |
| ②别的窗口的活跃对话 | 在另一个 LS 的热列表中 | 从对应 LS 拉取（保证最新完整） |
| ③历史非活跃对话 | 不在任何 LS 热列表中，.pb 在磁盘 | 父 LS 按需加载 .pb |

**关键**：②类对话如果从父 LS 读 .pb，可能拿到的是旧快照（对方 LS 可能还没落盘最新 step）。
因此必须找到持有该对话的 LS 来拉取实时数据。

### 3.5 Codex 对话链路的对应关系

当工具走 `chain="codex"` 时，对话原文不再来自 LS，而来自 Codex 本地数据：

- 线程索引：`~/.codex/state_5.sqlite`
- 原始事件流：`~/.codex/sessions/**/*.jsonl`

与 LS 轨迹相比，Codex 的底层是原始事件流，因此工具层需要自己完成：

- 轮次重建
- 工具调用与返回的归档
- 推理事件与正文的分层呈现
- 子代理线程与 `exec` 线程的引用管理

#### Codex 子代理线程默认策略

- 主线程正文优先保留用户消息、助手消息、主线程工具调用
- 子代理线程默认只保留引用或摘要，避免并行线程直接打乱主线程阅读顺序
- 只有显式要求展开时，才读取子线程全文
- Record、Guard、黄金片段提取等上层能力应沿用同一策略，保证功能表现稳定

---

## 4. LS RPC API 详解

### 4.1 连接认证

```
POST http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{Method}
Headers:
  Content-Type: application/json
  x-codeium-csrf-token: {从 LS 命令行参数 --csrf_token 获取}
  Connect-Protocol-Version: 1
Body: JSON payload
```

### 4.2 已知可用 API

| 方法 | 用途 | 负载示例 | 响应大小 | 耗时 |
|------|------|---------|---------|------|
| `Heartbeat` | 健康检查/端口验证 | `{}` | 极小 | ~1-5ms |
| `GetAllCascadeTrajectories` | 获取所有对话摘要列表 | `{}` | ~46KB | ~1s |
| `GetCascadeTrajectorySteps` | 获取对话详细步骤（分页） | `{cascadeId, stepOffset}` | ~5MB/页 | ~5-14s |
| `GetModelResponse` | 调用 AI 模型生成回复 | `{model, prompt}` | 按响应长度 | 不定 |

### 4.3 API 使用细节

**`GetAllCascadeTrajectories`**
- 返回 `trajectorySummaries` 对象，key 为 cascadeId
- 每个 summary 包含 `stepCount`、`lastModifiedTime`、`status` 等
- 只包含 LS **热列表**中的对话——冷对话（已关闭很久的）不在这里
- 用途：检查对话是否在某个 LS 中、获取 stepCount 做增量判断

**`GetCascadeTrajectorySteps`**
- 按 ~5MB 数据量分页，每页步数不固定（可能 600/400/340/200）
- offset 从 0 开始，返回 0 步表示已到末尾
- 对于不在热列表中的 cascadeId，LS 会尝试从 .pb 自动加载——成功则返回数据，失败返回 500

**`Heartbeat`**
- 最轻量的 API，只用于验证连接有效性（端口 + CSRF 正确）
- 本文档中大量使用它做"有效性判定"

---

## 5. ppid 绑定机制

### 5.1 核心发现

```typescript
// 在 MCP 进程中
const myLsPid = process.ppid;  // 直接就是父 LS 的 PID！
```

LS 直接 spawn MCP，中间没有 shell 或 wrapper，因此 `process.ppid` 精确可靠。

### 5.2 父进程存活检测（跨平台，微秒级）

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

`process.kill(pid, 0)` 是 Node.js 原生 API，不依赖 PowerShell、不依赖 wmic，
在 Windows/Linux/Mac 上均可用，执行时间微秒级。

### 5.3 父 LS 轻量发现

不需要 `discoverLsProcesses()` 扫描所有 LS，只查自己父 PID 一个进程即可：

```typescript
function discoverParentLs(): LsProcessInfo | null {
    const ppid = process.ppid;
    // PowerShell 只查一个 PID，比扫全部快得多
    const psScript = `
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}"
      $ports = (Get-NetTCPConnection -OwningProcess ${ppid} -State Listen
                | Select -Expand LocalPort) -join ","
      "${ppid}|$($p.CommandLine)|$ports"
    `;
    // 解析出 csrfToken、ports
}
```

**缓存策略**：进程生命期内缓存一次就够了——LS 不重启时 PID/端口/CSRF 都不变。
设为模块级变量 `parentLs`，MCP 启动时初始化，用到死。

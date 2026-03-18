# LS 升级建议 — memory-store MCP

> 基于 ls-tools 反向工程经验，针对 memory-store 的进程生命周期 + conversation_read_original 优化。
> 2026-03-18 | 详细原理见同目录 `LS-Principles.md`

---

## 一、进程生命周期：与 LS 同生共死

### 1.1 背景问题

memory-store 当前使用 **40 分钟无活动超时** 来自杀。

> AI 在对话中做代码编辑、思考、浏览器操作了 1 小时，
> 期间没有调用 memory-store 的任何工具，
> → memory-store 40 分钟超时自杀 → 下次调用时 EOF → 用户需要重启窗口

### 1.2 改动：lifecycle.ts

```typescript
// === 新增 ===

/**
 * 检测父 LS 进程是否还活着
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）
 * process.kill(pid, 0) 是 Node 原生 API，跨平台，微秒级
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

### 1.3 改动：index.ts

**替换前**（旧逻辑）：
```typescript
const HEARTBEAT_PROCESS_TIMEOUT = 40 * 60 * 1000;  // 40 分钟

const heartbeatInterval = setInterval(() => {
    const idle = getIdleTime();
    if (idle > HEARTBEAT_PROCESS_TIMEOUT) {
        process.exit(0);  // 💀 误杀
    }
}, 60000);
```

**替换后**（新逻辑）：
```typescript
const heartbeatInterval = setInterval(async () => {
    if (!isParentAlive()) {
        console.error(`[memory-store] 父 LS (PID=${process.ppid}) 已消失，自动退出`);
        cleanupRegistryOnExit();  // 见下文"注册表清理"
        await cleanup();
        process.exit(0);
    }
}, 30000);  // 30s 检测间隔
```

**删除**：`HEARTBEAT_PROCESS_TIMEOUT` 常量。
**保留**：`touchActivity()` 函数（供注册表等其他场景使用），`stdin.on('end'/'close'/'error')` 作为第一层防线。

**双保险机制**：
1. `stdin.on('end')` → 管道断裂，**秒级**响应（已有）
2. `process.kill(ppid, 0)` → 父进程消失检测，**30s 内**响应（新增）

---

## 二、LS 注册表（memory-store 独有）

memory-store 是三个 MCP 中**唯一需要 LS 数据交互**的（`conversation_read_original`、`autoSummary`）。
因此 LS 注册表由 memory-store 独家负责维护。

### 2.1 为什么需要注册表

`conversation_read_original` 需要读取**其他窗口活跃对话**的最新数据。
当前做法是每次调用都跑 `discoverLsProcesses()`（PowerShell 扫描全部 LS，**2-5 秒**）。

注册表将所有存活 LS 的连接信息持久化到磁盘，使跨 LS 查询从**秒级降至毫秒级**。

### 2.2 存储位置与数据结构

```
文件路径：~/.gemini/antigravity/memory-store/ls-registry.json
```

```json
{
  "processes": {
    "10508": {
      "pid": 10508,
      "port": 42345,
      "csrfToken": "abc123",
      "workspaceId": "ws-aaa",
      "registeredAt": "2026-03-18T12:00:00Z"
    },
    "99999": {
      "pid": 99999,
      "port": 18080,
      "csrfToken": "def456",
      "workspaceId": "ws-bbb",
      "registeredAt": "2026-03-18T13:30:00Z"
    }
  }
}
```

**条目数 = 当前打开的窗口数**（不是对话数），通常 1-5 条。

### 2.3 注册表生命周期

#### 启动时：注册父 LS

```typescript
function registerParentLs(): void {
    const parentLsInfo = discoverParentLs();
    if (!parentLsInfo) {
        console.error("[registry] 无法发现父 LS，跳过注册");
        return;
    }

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            updateRegistry(data => {
                data.processes[String(parentLsInfo.pid)] = {
                    pid: parentLsInfo.pid,
                    port: parentLsInfo.port,
                    csrfToken: parentLsInfo.csrfToken,
                    workspaceId: parentLsInfo.workspaceId,
                    registeredAt: new Date().toISOString(),
                };
            });
            // 验证写入成功：读回确认
            const readBack = readRegistry();
            if (readBack.processes[String(parentLsInfo.pid)]) {
                success = true;
                break;
            }
            console.error(`[registry] 注册写入后读回验证失败，重试 (${attempt + 1}/3)`);
        } catch (err) {
            console.error(`[registry] 注册失败 (${attempt + 1}/3): ${err}`);
        }
    }

    if (!success) {
        console.error("[registry] 经过 3 次重试仍无法注册父 LS，将降级使用实时发现");
    }
}
```

启动时同时做一次**惰性清理**：Heartbeat 验证注册表中已有的条目，清理死条目。

#### 退出时：注销父 LS

```typescript
function cleanupRegistryOnExit(): void {
    const myPid = String(process.ppid);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const data = readRegistry();
            if (!data.processes[myPid]) break;  // 已不在表中，无需操作

            delete data.processes[myPid];

            // 如果是最后一条 → 删除整个文件
            if (Object.keys(data.processes).length === 0) {
                try {
                    fs.unlinkSync(registryPath);
                } catch { /* 文件可能已被其他进程删除 */ }
                break;
            }

            // 否则写回
            const tmp = registryPath + '.tmp.' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, registryPath);

            // 读回验证
            const readBack = readRegistry();
            if (!readBack.processes[myPid]) {
                break;  // 确认删除成功
            }
            console.error(`[registry] 注销后读回验证失败，重试 (${attempt + 1}/3)`);
        } catch (err) {
            console.error(`[registry] 注销失败 (${attempt + 1}/3): ${err}`);
        }
    }
}
```

#### 读时惰性清理

当读取注册表发现某条目 Heartbeat 失败时，**不立即删除**，而是标记失败次数。
连续 2-3 次 Heartbeat 失败后才删除，避免因网络抖动或 LS 瞬时繁忙导致误删。

```typescript
// 模块级变量：记录各条目连续失败次数
const heartbeatFailCounts = new Map<string, number>();
const MAX_HEARTBEAT_FAILURES = 3;  // 连续失败 3 次才删除

async function validateRegistryEntry(
    pid: string,
    entry: RegistryEntry
): Promise<boolean> {
    try {
        const result = await rpcCall(
            { pid: entry.pid, csrfToken: entry.csrfToken, ports: [entry.port] } as LsProcessInfo,
            entry.port,
            "Heartbeat",
            {},
            3000  // 3s 超时，不宜太长
        );
        if (result.status === 200) {
            heartbeatFailCounts.delete(pid);  // 重置失败计数
            return true;
        }
    } catch { /* 连接失败 */ }

    // 累加失败次数
    const failures = (heartbeatFailCounts.get(pid) || 0) + 1;
    heartbeatFailCounts.set(pid, failures);

    if (failures >= MAX_HEARTBEAT_FAILURES) {
        console.error(`[registry] PID=${pid} 连续 ${failures} 次 Heartbeat 失败，从注册表移除`);
        heartbeatFailCounts.delete(pid);
        removeFromRegistry(pid);
        return false;
    }

    console.error(`[registry] PID=${pid} Heartbeat 失败 (${failures}/${MAX_HEARTBEAT_FAILURES})，暂不移除`);
    return false;  // 本次不可用，但不删
}
```

### 2.4 并发安全

多个窗口的 memory-store 可能同时读写同一个注册表文件。

```typescript
function updateRegistry(fn: (data: Registry) => void): void {
    const data = readRegistrySafe();
    fn(data);
    // 原子写入：写临时文件 → rename
    const tmpPath = registryPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, registryPath);  // 同一文件系统上的原子操作
}

function readRegistrySafe(): Registry {
    try {
        if (fs.existsSync(registryPath)) {
            return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
        }
    } catch { /* 文件损坏或被并发写入，返回空 */ }
    return { processes: {} };
}
```

---

## 三、conversation_read_original 优化

### 3.1 guessCurrentCascadeId 改造

**当前问题**：通过扫描 `.pb` 文件修改时间来猜当前对话。
多窗口时会猜错——别的窗口的 .pb 可能修改时间更新。

**改为**：直接问父 LS 的热列表。

```typescript
export async function getCurrentCascadeId(): Promise<string | null> {
    const parentLs = getParentLs();
    if (!parentLs) return guessFromPb();  // 兜底保留

    const port = await findHttpPort(parentLs);
    if (!port) return guessFromPb();

    const result = await rpcCall(parentLs, port, "GetAllCascadeTrajectories", {});
    const summaries = result.data?.trajectorySummaries;
    if (!summaries) return guessFromPb();

    // 在父 LS 的热列表中找最近修改的对话
    // 只会拿到本窗口的对话，不会跨窗口混淆
    let latest: { id: string; time: string } | null = null;
    for (const [id, info] of Object.entries(summaries)) {
        const t = (info as any).lastModifiedTime;
        if (!latest || t > latest.time) {
            latest = { id, time: t };
        }
    }
    return latest?.id ?? guessFromPb();
}
```

### 3.2 fetchTrajectory 三步查找

替代当前的"全量扫描所有 LS"逻辑。

#### 总体流程

```
conversation_read_original(cascadeId)

若 cascadeId 未传：
  → getCurrentCascadeId()（问父 LS 热列表，不再猜 .pb）

Step 1: 父 LS（ppid 直连，零发现开销）
  ├→ 热列表有 → 直接拉 ✅   （①当前对话）
  ├→ 热列表无 → 尝试 GetCascadeTrajectorySteps(cascadeId, offset=0)
  │   ├→ 有数据 → LS 从 .pb 自动加载了 ✅   （③历史非活跃对话）
  │   └→ 500 = .pb 不存在或不属于此 LS → 走 Step 2
  └→ 父 LS 不可用 → 走 Step 2

Step 2: 读注册表，查其他 LS（②别的窗口活跃对话）
  → 遍历注册表中非父 LS 的条目
  → Heartbeat 验证（~5ms）
  │   └→ 连续失败 3 次才移除条目，单次失败只标记跳过
  → getStepCountLight 查目标对话
  ├→ 找到 → 从对应 LS 拉取最新数据 ✅
  └→ 都没找到 → 走 Step 3

Step 3: PowerShell 全量发现（极罕见兜底）
  → 可能有刚开的窗口尚未注册到注册表
  → 发现后更新注册表
  → 再次查找
```

#### 详细代码骨架

```typescript
export async function fetchTrajectory(
    cascadeId: string,
    forceRefresh = false
): Promise<{ trajectory: any; fromCache: boolean } | null> {
    const cachePath = getConvCachePath(cascadeId);

    // ===== Step 1: 父 LS =====
    const parentLs = getParentLs();
    if (parentLs) {
        const port = parentLs.port;

        // 查热列表
        const { stepCount } = await getStepCountLight(parentLs.info, port, cascadeId);

        if (stepCount >= 0) {
            // 在父 LS 热列表中 → 走增量/全量拉取逻辑
            return await fetchFromLs(parentLs.info, port, cascadeId, stepCount, cachePath, forceRefresh);
        }

        // 不在热列表 → 尝试直接拉（LS 会自动加载 .pb）
        try {
            const steps = await fetchAllStepsPaged(parentLs.info, port, cascadeId);
            if (steps.length > 0) {
                const trajectory = { steps };
                saveConvCache(cascadeId, { stepCount: steps.length, trajectory });
                return { trajectory, fromCache: false };
            }
        } catch {
            // 500 = .pb 不存在，继续 Step 2
        }
    }

    // ===== Step 2: 注册表中其他 LS =====
    const registry = readRegistrySafe();
    const parentPidStr = String(process.ppid);

    for (const [pid, entry] of Object.entries(registry.processes)) {
        if (pid === parentPidStr) continue;  // 跳过父 LS

        // Heartbeat 验证（带重试容忍机制）
        const valid = await validateRegistryEntry(pid, entry);
        if (!valid) continue;

        const { stepCount } = await getStepCountLight(
            entryToLsInfo(entry), entry.port, cascadeId
        );
        if (stepCount >= 0) {
            return await fetchFromLs(entryToLsInfo(entry), entry.port, cascadeId, stepCount, cachePath, forceRefresh);
        }
    }

    // ===== Step 3: PowerShell 全量兜底 =====
    const freshProcesses = discoverLsProcesses()
        .filter(ls => ls.pid !== process.ppid);  // 父 LS 已查过

    for (const ls of freshProcesses) {
        // 顺便注册到注册表
        registerLsToRegistry(ls);

        const port = await findHttpPort(ls);
        if (!port) continue;
        const { stepCount } = await getStepCountLight(ls, port, cascadeId);
        if (stepCount >= 0) {
            return await fetchFromLs(ls, port, cascadeId, stepCount, cachePath, forceRefresh);
        }
    }

    throw new Error(`无法从任何 LS 获取对话 ${cascadeId}`);
}
```

### 3.3 autoSummary 的 LS 调用

`callGetModelResponse` 和 `generateAutoSummary` 只需要调自己父 LS 的 `GetModelResponse`。

**直接用 ppid 即可**——`discoverParentLs()` 在进程启动时做一次，结果缓存在 `parentLs` 变量中。
不需要走注册表，不需要 `getLsProcess()` 的全量扫描逻辑。

```typescript
export async function callGetModelResponse(model: string, prompt: string): Promise<string | null> {
    const parent = getParentLs();
    if (!parent) return null;
    const result = await rpcCall(parent.info, parent.port, "GetModelResponse", { model, prompt }, 30000);
    return result.data?.response ?? null;
}
```

---

## 四、ls-client.ts 重构总览

### 4.1 删除的概念

| 删除项 | 原因 |
|--------|------|
| `cachedLsInfo` | 被 `parentLs` + 注册表取代 |
| `cachedHttpPort` | 端口信息直接在 `parentLs` 和注册表条目中 |
| `CACHE_TTL` (5min) | 改用 Heartbeat 有效性判定，无 TTL |
| `getLsProcess()` | 被 `getParentLs()` 取代 |
| `guessCurrentCascadeId()` | 被 `getCurrentCascadeId()` 取代（从 .pb 猜 → 问父 LS 热列表） |

### 4.2 新增的概念

| 新增项 | 用途 |
|--------|------|
| `parentLs` | 模块变量，进程启动时通过 ppid 初始化，生命期内不变 |
| `discoverParentLs()` | 轻量版发现，只查一个 PID |
| `getParentLs()` | 获取已缓存的父 LS 信息 |
| `getCurrentCascadeId()` | 从父 LS 热列表获取当前对话 ID |
| `ls-registry.ts` | 共享注册表模块（新文件） |

### 4.3 保留不变的

| 保留项 | 原因 |
|--------|------|
| `discoverLsProcesses()` | 降级为 Step 3 的兜底手段，不再是主路径 |
| `findHttpPort()` | 端口验证逻辑不变 |
| `rpcCall()` | 底层 RPC 调用不变 |
| `fetchAllStepsPaged()` | 分页拉取逻辑不变 |
| `fetchStepsIncremental()` | 增量拉取逻辑不变 |
| `verifyTail()` | 尾部校验逻辑不变 |
| `httpPost()` | 底层 HTTP 调用不变 |

---

## 五、改动文件清单

| 文件 | 类型 | 改动内容 |
|------|------|---------|
| `src/ls-registry.ts` | **新增** | 注册表 CRUD、Heartbeat 验证（2-3 次容忍）、并发安全、退出清理 |
| `src/lifecycle.ts` | 修改 | 新增 `isParentAlive()` 导出 |
| `src/index.ts` | 修改 | ppid 心跳替换超时；启动时 `registerParentLs()`；退出时 `cleanupRegistryOnExit()` |
| `src/ls-client.ts` | 重构 | 删除 cachedLsInfo 体系；新增 parentLs 体系；`fetchTrajectory` 三步查找；`getCurrentCascadeId` 替代猜测 |

**不需要改动**：
- `tools/conversation.ts` — 只调 `fetchTrajectory`，接口不变
- `tools/golden-extract.ts` — 只调 `fetchTrajectory` + `callGetModelResponse`，接口不变
- `store.ts`、`temp-store.ts`、`trajectory.ts` — 无关

---

## 六、效果对比

| 场景 | 当前行为 | 优化后行为 |
|------|---------|-----------|
| 40min 没调用 memory-store | **EOF 自杀** 💀 | 窗口开着 → **活着** ✅ |
| 读当前窗口的对话 | PowerShell 扫描 2-5s | ppid 直连 **~5ms** ✅ |
| 读别的窗口活跃对话 | PowerShell 扫描 2-5s | 注册表查询 **~5ms** ✅ |
| 读历史冷对话 | PowerShell + 遍历 LS | 父 LS 直接加载 .pb ✅ |
| 推断当前对话 ID | 扫描 .pb 修改时间（可能猜错） | 问父 LS 热列表（**精确**） ✅ |
| 注册表某条目 LS 暂时繁忙 | N/A | **容忍 2-3 次**再移除，不误删 ✅ |
| 窗口关闭 | 可能泄漏进程 | **30s 内自动退出** + 注册表自清理 ✅ |

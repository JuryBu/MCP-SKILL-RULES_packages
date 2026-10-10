# 账号启动恢复包装入口

`ops/start-napcat-account-recovery.ps1` 在既有登录入口外增加部署核验、独占执行和启动历史，随后按既有接收器停止标记决定是否调用任务路由入口。它保留原来的 QQ 登录和 router 实现，供已有的 Windows 登录或恢复触发入口调用。

本文件说明源码接入条件。Windows 登录、睡眠或休眠恢复、任务调度器触发以及真实账号收发需要在目标机器另外验收。包装入口自身不安装任务、修改触发器或运行常驻监督器。

## 接入参数

部署方必须显式提供账号目录、预期账号及两个脚本的路径和 SHA256。路径使用绝对路径，SHA256 来自已核验的部署文件，账号值留在本机调用参数中。

| 参数 | 用途 |
|---|---|
| `AccountRoot`、`ExpectedAccountId` | 本机账号部署目录和预期账号 |
| `LoginScriptPath`、`LoginScriptSha256` | 已部署登录入口及预期摘要 |
| `RouterScriptPath`、`RouterScriptSha256` | 已部署任务路由入口及预期摘要 |
| `NodeExePath` | router 未暂停时使用的 Node，可执行文件绝对路径和 SHA256 必须列入 `criticalFiles` |
| `TriggerSource` | 记录 `logon`、`resume`、`manual` 或 `isolated_test` 来源 |

调用结构如下，其中变量由部署方从已核验的本机部署材料填写。接入前保留原包装文件和可独立执行的回退入口，真实运行按目标机器的授权窗口进行。

```powershell
& $RecoveryScriptPath -AccountRoot $AccountRoot -ExpectedAccountId $ExpectedAccountId `
  -LoginScriptPath $LoginScriptPath -LoginScriptSha256 $LoginScriptSha256 `
  -RouterScriptPath $RouterScriptPath -RouterScriptSha256 $RouterScriptSha256 `
  -NodeExePath $NodeExePath -TriggerSource logon
```

`AccountRoot/state` 必须已存在。包装入口读取 `state/deployment.json`，沿用以下部署字段；已有的 `codeRoot` 字段可以保留，实际脚本位置取显式参数。

| 部署字段 | 要求 |
|---|---|
| `state` | `active`；其它状态停止恢复 |
| `account` | 与 `ExpectedAccountId` 一致 |
| `dataRoot` | 绝对路径，包含 `binding.json`，其 `expectedSelfId` 与账号一致 |
| `brokerRoot` | 本机 broker 的绝对路径 |

| 部署字段 | 要求 |
|---|---|
| `napCatRoot` | NapCat 的绝对路径 |
| `qqExePath` | QQ 可执行文件的绝对路径 |
| `qqUserDataDir` | 绝对路径，其中必须存在以预期账号命名的目录 |
| `criticalFiles` | 非空数组，每项包含绝对 `path` 和已核验的 `sha256` |

部署清单、binding 和脚本摘要构成本机信任基线。维护者应保护这些私有文件的写入权限，并把需要校验的运行依赖列入 `criticalFiles`。router 未暂停时，`NodeExePath` 必须匹配其中唯一一项路径与实际文件摘要，首次核验、登录后以及调用 router 前均检查 Node 字节。包装入口只读取现有部署，配置和权限维护由部署流程负责。

## 执行顺序与停止条件

包装入口先取得 `state/startup-recovery.lock` 的独占文件句柄，随后追加 `run_start`，检查旧的未结束运行，再核验部署身份。核验通过后清理本进程的快速登录密码、账号和相关注入环境变量，调用登录入口，保留 `TimeoutSeconds=120`、`NoQr`、`NoPasswordFallback`。

只有登录入口报告「登录进程提前退出」时，包装入口才等待 10 秒，再尝试一次。人工登录、权限或安全拒绝、超时、非零退出、错账号以及未知错误均在当前运行中结束。接收器失败也结束当前运行，登录成功的 QQ 保持原状态。

登录结果必须属于 `online`、`already_online` 或 `online_existing`，账号必须一致。随后再次核验部署和停止条件，检查 `dataRoot/state/task-router.stop`；该标记存在时保留在线 QQ，跳过 router。标记缺失时，包装入口使用显式 `NodeExePath` 调用已核验的 router 入口，要求返回的 `started` 为布尔值，接受启动成功或 `already_running`。

首次通过的账号、五个运行路径和 `criticalFiles` 路径／摘要清单固定为当前运行的身份。后续核验和重试等待使用该身份，清单改成同账号的另一有效部署也会以 `identity_drift` 结束，router 保持未启动。路径按 Windows 完整路径和大小写规范化，关键文件按路径／摘要排序后比较；相同文件清单调整顺序保持同一身份。

`state/startup.stop`、非活动部署以及被持有的 `state/account-switch.lock` 都会停止恢复。停止条件在首次核验、登录后以及重试等待期间检查；脚本保留这些标记。空闲的账号切换锁文件允许恢复，正在持有的锁会拒绝恢复。

独占锁的所有者负责共享摘要和历史，拒绝的并发调用返回退出码 1、`state=concurrent`、`reason=concurrent_attempt`，共享文件保持原字节。锁文件可以保留在磁盘上，句柄在成功和异常结束时释放。

## 结果与失败定位

| 文件或输出 | 内容 |
|---|---|
| `state/last-start.json` | 最近一次锁所有者的结果、尝试数、账号、router 状态和安全失败定位 |
| `state/startup-history.jsonl` | 追加运行开始、尝试结束、重试等待、运行结束及旧未结束运行标记 |
| 退出码 0 | 预期账号已在线，router 已就绪或按原停止标记暂停 |
| 退出码 1 | 已分类失败或并发拒绝，stderr 使用固定原因标签 |

历史保留第一次失败和随后成功的完整顺序。`run_end.exitCode` 属于包装入口，`failure.childExitCode` 属于登录入口报告的子进程；缺少 PID 或退出码时记录明确的缺失原因。

上次中断留下未换行的历史末行时，锁所有者保留原字节，追加分隔和 `history_tail_interrupted` 事件，再写本次运行开始。登录成功但 router 失败时，摘要分别保留已成功的安全登录结果和 router 失败状态，便于定位。

失败定位只保留允许的异常类型、固定错误标签、类别、入口标识、行号、整数 PID／退出码及当前登录日志位置。异常正文、任意错误标识和登录／router 返回的密码、token 等额外字段被排除。运行文件中的账号和日志位置属于本机私有材料，公开问题报告应提取最小脱敏证据。

包装入口沿用原有时间预算：第二次尝试前检查累计 150 秒，等待期间检查累计 270 秒。登录入口负责其 120 秒等待期限，外层任务负责整个进程树的生命周期。真实任务的运行时限、退出后子进程存活和系统恢复事件需要随目标入口验证。

## 隔离复跑

`test/start-napcat-account-recovery.test.ps1` 默认同时要求本机已有 Windows PowerShell 5.1 和 PowerShell 7，`WindowsPowerShellOnly` 可单独验收已有 WinPS 环境，`IdentityFocused` 只运行身份绑定及相关正常／拒绝回归，`DiagnosticsFocused` 只运行返回字段类型和中断历史的相关回归。它以真实解释器子进程运行同一个公共入口，只替换 QQ／login／router，全部部署文件和停止标记位于新建临时目录。测试过程中保留当前执行策略；遇到执行策略或安全拒绝时，维护者保留错误并按现有授权处理。

```powershell
& $TestScriptPath -OutputRoot $NewTemporaryOutputRoot `
  -WindowsPowerShellPath $ExistingWindowsPowerShellPath -PowerShell7Path $ExistingPowerShell7Path
```

测试覆盖两次真实并发调用、独占写入、部署与账号拒绝、原登录参数及调用顺序、10 秒一次重试、失败历史、子进程非零退出和超时、敏感异常与返回字段。复跑结果写入临时目录的 `results.json`，绑定入口和测试文件 SHA256，并保留每个样本的进程输出及历史。

回退时恢复已备份的原包装入口，核对其摘要，保留新增历史用于排障。停止标记和健康 QQ 的状态继续沿原部署维护流程处理。

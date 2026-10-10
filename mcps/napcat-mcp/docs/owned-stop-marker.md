# 停止标记的持续所有权

`ops/owned-stop-marker.ps1` 提供 Windows 停止标记的创建、持续持有、只读核对和按对象消费。停止标记用于让对应 Node 组件发现停止要求；服务的停止、启动、签名检查和实例核对由调用方执行。

一个生命周期父进程创建并持续持有 `proxy`、`router` 各自的 lease（包含原生文件句柄的进程内对象）。子进程取得 proof（读取凭据），核对相同标记后执行自己的工作。父进程消费标记时使用创建时保留的同一个句柄，随后由启动入口再次检查新停止要求。

## 接口

模块通过 dot-source 加载，函数名和下列参数可供 stop/start 接入。

| 函数 | 必填参数 | 返回内容 |
|---|---|---|
| `New-OwnedStopMarker` | `Path, Component, AttemptId` | 本进程的 lease |
| `Assert-OwnedStopMarker` | `Lease, Path, Component, AttemptId` | 脱敏 Evidence |
| `Read-OwnedStopMarker` | 同上 | 同上 |
| `Export-OwnedStopMarkerProof` | 同上 | 纯 JSON 字符串，含私有 ownerToken |

| 函数 | 必填参数 | 返回内容 |
|---|---|---|
| `Assert-OwnedStopMarkerProof` | `ProofJson, Path, Component` | 只读核对的脱敏 Evidence |
| `Consume-OwnedStopMarker` | `Lease, Path, Component, AttemptId` | 按句柄消费的 Evidence |
| `Close-OwnedStopMarker` | `Lease` | 保留标记并释放句柄的 Evidence |

`Component` 在当前集成中使用 `proxy` 或 `router`。`AttemptId` 是调用方维护操作的标识，允许 1～128 个英文字母、数字、点、下划线或短横线，首字符须为字母或数字。模块另外生成独立的 `operationId` 和 256 位随机 `ownerToken`。

创建可以传 `LifetimeSeconds`，默认 1800 秒，范围为 1～86400 秒。assert、read、export 和 consume 可以传 `OperationId`，省略时使用实际 lease 中的标识。proof 验证也接受 `AttemptId`、`OperationId`；当前 stop 接入应同时传入这两个外部预期值。

## 父进程与子进程的配合

父进程先创建并保留两个实际 lease，将导出的 proof 写入自己的私有 JSON 文件，调用 child stop 时传 `StopMarkerProofPath`、`StopMarkerAttemptId`、`StopMarkerOperationId`。proof 文件包含 ownerToken，应只交给对应子进程读取，避免输出 proof、记录完整命令行或把凭据放进公共回执。

child stop 读取私有 JSON 后，调用 `Assert-OwnedStopMarkerProof`，分别在执行开始和结束时核对组件停止标记。验证通过后使用已有标记，跳过旧的覆盖写入。proxy 的持有模式还需要拒绝 `AllowVerifiedForceStop`。

父进程收齐停止结果后，分别调用 `Consume-OwnedStopMarker`。消费回执中的 `PathState` 为 `Missing` 时，调用方才能继续执行下一步启动核对。child start 使用 `RequireNoStopMarker`，检查已有标记和启动前新增的标记，遇到停止要求时保全文件并拒绝启动。

父进程应在同一个 `try/finally` 生命周期中管理两个 lease。lease 尚未消费、仍为 `Held` 时，在每个停止子调用前后执行 `Assert-OwnedStopMarker`，消费继续传入同一原 lease。消费后的启动按消费回执及新停止要求处理。第二个创建失败、子进程失败、超时、回执保存失败或启动结果未知时，调用方保留状态供复核；finally 中通过 `Dispose()` 释放尚未消费的句柄，标记继续保留。

proof 是读取凭据。将 JSON、反序列化对象或另一进程中的对象传给 consume，会得到 lease 拒绝。模块只接受当前进程登记的原 lease，不提供失联后凭 token 重新取得消费权的接口。每个父进程固定使用同一份模块，更新模块后开启新的父进程；遇到已加载的旧实现会报 `OWNED_STOP_MARKER_FRESH_PARENT_REQUIRED`。

## 原生保护和验证内容

创建调用 `CreateFileW`，访问权为 `GENERIC_READ | GENERIC_WRITE | DELETE`，共享权仅为 `FILE_SHARE_READ`，创建方式为 `CREATE_NEW`。已存在的文件由 Windows 原子拒绝，模块保留原文件。句柄使用 `SafeFileHandle`，没有 delete-on-close 标志，没有可继承句柄属性。

lease 持续持有期间，其它普通进程请求写入、删除、改名或替换目标文件会遇到共享冲突。Node 可以检查标记是否存在，也可以使用兼容共享方式读取。PowerShell 读取者需要 `FileShare.ReadWrite | FileShare.Delete`，以兼容父句柄已经请求的 WRITE 和 DELETE 访问；读取者本身仍只申请 `FileAccess.Read`。

模块用 `GetFileInformationByHandleEx(FileIdInfo)` 读取卷序列号及 128 位文件 ID，核对原生句柄指向的路径、单链接普通文件、完整记录的 SHA256 和 record 字段。record 绑定 schema、component、attemptId、独立 operationId、随机 token、父 PID、父进程启动时间及有效期。时间用于有效期检查，消费权来自实际 lease。

proof 验证用只读句柄读取文件，核对 proof 与 record 的全部字段、路径、文件 ID 和字节哈希，检查父 PID 与启动时间，并在返回前再次核对对象和哈希。验证分别尝试申请 WRITE 与 DELETE 访问，两次都要求收到 Windows 共享冲突 32；探测保持文件字节与删除状态原样。`ReadOnlyVerified` 记录当次对象及共享保护的观察结果。其它只读句柄也能产生这种共享保护；父进程的持续持有状态由子调用前后的原 lease 检查负责，消费始终由该原 lease 执行。

JSON 使用框架内置 `DataContractJsonSerializer`。输入须为扁平对象，字段类型严格核对，重复键、转义后的重复键、未知字段、嵌套对象和损坏 JSON 均拒绝。record 有 9 个字段，proof 有 13 个字段。验证结果和常规异常只包含脱敏状态，ownerToken 留在 record、进程内存和私有 proof 中。

消费在完成绑定、对象及有效期检查后调用 `SetFileInformationByHandle(FileDispositionInfo)`，成功后释放原句柄。代码保持这条原生句柄链，消费期间没有关闭后按路径删除的步骤。`FILE_DISPOSITION_INFO` 使用 1 字节 BOOLEAN，`FILE_ID_INFO` 为 24 字节，`FILE_STANDARD_INFO` 为 24 字节。

## 消费、失败与保全

服务 runner 读取停止要求并退出，保留停止文件交给创建它的调用方处理。外层 runner 在启动前及取得实例锁后发现停止文件时拒绝启动，正常退出只释放自己的实例锁和进程资源。调用方在确认服务已退出后消费原 lease；明确重新启动仍通过正常 start 入口完成。

| 状态 | 实际含义 | 调用方动作 |
|---|---|---|
| `Consumed + Missing` | 原对象已请求删除，父句柄已释放，路径探测为缺失 | 继续启动前的新标记检查 |
| `Consumed + Unavailable` | 路径仍无法打开，可能仍有只读句柄使删除待完成 | 保留回执，等待或复核，停止本次启动 |
| `Consumed + Present` | 路径当前有文件，可能是新的停止要求 | 保全现有文件，停止本次启动 |
| `Preserved` | close、dispose 或父进程退出后留下标记 | 按原操作状态复核 |

`DispositionApplied` 表示 Windows 接受了按句柄删除请求，`LeaseReleased` 表示父句柄已经释放。仍在读取的句柄关闭后，Windows 才能完成旧对象的删除。消费结束后创建的新停止标记继续存在，重复消费旧 lease 会被拒绝。

过期、错误绑定、未知文件对象和读取失败会阻断消费。创建过程中若发生写入或 flush 失败，已创建的部分标记保留供复核。消费前的错误保持 lease 和标记；close 可释放已过期的 lease，释放后仍保留文件。

路径须为本地盘符开头的绝对路径，长度小于 260 字符。相对路径、UNC、设备路径、备用数据流、点路径段、保留设备名及 reparse 祖先目录会被拒绝。调用方应使用自己的受控服务目录；该目录的权限和运行配置由部署流程管理。

## 隔离使用示例

以下示例只创建自有 Temp 标记，不调用服务。proof 保存在变量中，示例不会输出它。

```powershell
. (Join-Path $PSScriptRoot '..\ops\owned-stop-marker.ps1')
$markerPath = Join-Path ([IO.Path]::GetTempPath()) ('owned-demo-' + [guid]::NewGuid().ToString('N') + '.stop')
$lease = New-OwnedStopMarker -Path $markerPath -Component proxy -AttemptId demo-attempt
$binding = @{ Lease = $lease; Path = $markerPath; Component = 'proxy'; AttemptId = 'demo-attempt' }
try {
    $proofJson = Export-OwnedStopMarkerProof @binding
    $verified = Assert-OwnedStopMarkerProof -ProofJson $proofJson -Path $markerPath -Component proxy -AttemptId demo-attempt -OperationId $lease.OperationId
    $receipt = Consume-OwnedStopMarker @binding
    if ($receipt.PathState -ne 'Missing') { throw 'STOP_MARKER_PATH_NOT_READY' }
} finally {
    $lease.Dispose()
}
```

## 运行时和验收范围

模块使用 Windows 内置 API 和框架内置序列化能力。WinPS 5.1 根据当前类型的 `Assembly.Location` 取得框架引用；PS7 使用当前宿主自带的 `ref` 引用包，并核实序列化类型的实际程序集可用。缺少引用包时直接拒绝加载，部署方另行核对原运行时。

`test/owned-stop-marker.test.ps1` 通过真实 WinPS、独立读取/攻击/竞争/退出子进程和 Node 进行原生验收。它覆盖原子竞争、已存在文件保全、同字节替换阻断、改写/删除阻断、proof 字段与 JSON 错误、错误 lease、有效期、按对象消费、释放与退出保全、删除待完成、新停止要求保全及自有资源清理。

已在 Windows 原生文件系统上分别用 WinPS 5.1 和 PS7.6.6 执行同版58项对象测试，四个 stop/start helper 的24项接入测试也已通过。独立复核重走只阻DELETE仍可WRITE的原反例，以及普通读锁与父lease权限分离的对照。

隔离实际链已覆盖 PS7父进程持有lease、WinPS子进程调用正常helper、旧runner退出后由修正版正常处理死亡实例锁、候选端口冲突失败及独立恢复。官方App Server使用真实程序，OneBot端点为隔离夹具。最终维护控制器整体、正常MCP工具调用、Desktop退出后存活和重开、真实Windows登录仍由各部署环境单独验收，应用前保留独立恢复入口。

## API 依据

句柄访问及共享方式见 Microsoft [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)，按对象删除见 [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle) 和 [FILE_DISPOSITION_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info)，文件身份见 [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)，宿主引用包行为见 [Add-Type](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type?view=powershell-7.6)。

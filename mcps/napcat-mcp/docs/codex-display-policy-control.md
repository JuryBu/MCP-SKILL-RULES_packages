# 外层显示策略的隔离维护入口

本入口只更新已登记提醒的 hidden/visible 显示与文本转换。连接、内部 RPC、工具回复、cancel、身份登记和 journal 继续由原代理主体处理。在途 turn 与历史读取保留原策略，已绑定条目的显示结果随 journal 保存。

## 正常启动与默认关闭

正常 runner 的既有命令行增加可选 `--display-policy-root <已审本地目录>`。省略时显示策略控制关闭，原显示行为保持；指定时仍从原策略启动，不自动导入或激活目录中的文件。既有启动脚本与生产配置需要由负责维护的主线另行决定是否接入此参数。

控制请求复用原 loopback HTTP 端口和原 Bearer token，不新增监听器。独立 CLI 从明确提供的 runtime-state 与 token-file 读取端点和凭据，只接受 loopback HTTP。实例标识来自 runner 的生命周期锁；旧实例的回执无法在新实例激活。

## 操作顺序

以下命令中的路径均需替换为当前隔离实例的文件路径，今晚只用于隔离验证。

```powershell
node ops/codex-display-policy.mjs --runtime-state <runtime.json> --token-file <token.txt> --action status
node ops/codex-display-policy.mjs --runtime-state <runtime.json> --token-file <token.txt> --action prepare --root-id <status返回的rootId> --candidate <根内相对文件名.mjs> --sha256 <已审文件SHA256> --receipt-out <新的回执文件.json>
node ops/codex-display-policy.mjs --runtime-state <runtime.json> --token-file <token.txt> --action activate --receipt <回执文件.json>
node ops/codex-display-policy.mjs --runtime-state <runtime.json> --token-file <token.txt> --action restore --revision <当前revision>
```

`prepare` 核对根目录身份、根内实际路径和内容 SHA，再从这些已核对的字节导入并验证接口。模块应为自包含 `.mjs`，相对依赖不能由此入口加载。`activate` 只接收准备回执，并再次核对原文件路径与 SHA。候选属于已经人工审阅的可信本地代码；模块会在代理进程中执行。单文件上限 256 KiB，每个实例最多导入 32 个不同 SHA。

准备成功只保存回执，当前策略继续工作。一个实例同时保留一份待激活回执；准备正在进行时返回 `DISPLAY_POLICY_PREPARE_BUSY`，已有回执时返回 `DISPLAY_POLICY_PREPARATION_PENDING`。需要放弃回执时使用 `--action discard --receipt <回执文件.json>`，随后才能准备其它候选。

同一回执重复激活返回 `alreadyActivated: true`，不会再次切换。错误 SHA、根外路径、旧口令、错误实例、过期 revision 或坏模块返回明确错误，原选择保持。`restore` 恢复上一次选择并增加 revision；已绑定条目继续使用保存的显示决定。操作结果未知时先查询 `status`，核对 `preparationId`、版本和 revision，再处理原回执。

## 接口与范围

`GET /v1/display-policy` 返回 enabled、instanceId、rootId、busy、preparationId、version、revision。`POST /v1/display-policy/prepare` 接收 instanceId、rootId、expectedRevision、candidate、sha256；`activate` 接收完整准备回执；`restore` 接收 instanceId、rootId、expectedRevision；`discard` 另需 preparationId。全部请求沿原 Bearer 认证。

此次范围保留常驻 bootstrap 与官方 AppServer 的版本。宿主首次迁移、这两个常驻主体的替换、任意协议结构改动、真实 Desktop 与生产双机切换仍需各自准备和验收。

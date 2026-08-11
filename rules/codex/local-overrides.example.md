## 本地私有覆盖示例

复制本文件为安装器指定的私有覆盖文件，再填写接收者自己的值。真实文件不得提交到 Git。

- 本机逻辑角色：`development` 或 `training`
- 本机机器名称：`ExampleDevelopmentMachine`
- 对端机器名称：`ExampleTrainingMachine`
- 固定群 ID：`1000000001`
- 固定群名：`ExampleGroup`
- 预期成员数：`4`
- 本机 NapCat 账号：`2000000001`
- 可信对端账号：`3000000001`
- 桌面保底账号：`ExampleDesktopAccount`
- OneBot URL：`http://127.0.0.1:3010`
- 主人通知渠道：在私有覆盖中写明首选渠道、适用所有任务还是指定任务、需要通知的决策/授权/阻塞范围和防刷屏规则
- 微信协作桥定位：在私有覆盖中写明它是实时信息来源、对等通知通道或其它本地角色

token、二维码、快速登录授权、binding、任务账本和 heartbeat 不写入 Rules 文件。

# 精确文件安装与独立恢复

来源为711b075完整候选的四份部署脚本，首次归入公共源码时修正了PowerShell7的JSON日期转换。文件更新和恢复都校验清单、源字节与目标基线；恢复保留原事务的清单、恢复计划和维护门SHA。

先在Windows PowerShell5.1和实际PowerShell7分别运行`Test-ShadowFileSet.ps1 -ResultsDirectory <各自独立的绝对目录>`。测试只创建系统Temp下的隔离文件及自有模拟锁，结果包含每项通过或失败及原fixture路径。两个测试顺序执行，因为安装工具共用全局互斥。

正式准备先运行Apply的`-ValidateOnly`，保存精确目标、候选SHA、旧字节、原权限与启动入口。LiveFiles另需机器维护门及其SHA：确认旧监督器已退出、实时runtime当前PID已退出、Node锁已释放，并逐个核对持续保护进程的PID、创建时刻和程序路径。实际QQ、BootMain、普通QQ、watchdog和broker属于保护范围；计划重新加载的MCP后端、router和监督器分别记录代次。

切换许可、账号及机器私有配置由现场维护对话核对。遇到错误立即保留原事务；恢复使用同一manifest、restore-plan和gate，不更换gate。原维护门过期后仍可恢复已开启事务，持续保护身份和实时运行状态必须重新核实。只读准备不启动生产进程、不创建正式停止标记，也不改变任务绑定。

## 已准备文件与Task Action的事务入口

`Invoke-PreparedTrainingInstallation.ps1`与`RECOVERY-ENTRY.ps1`复用已通过Windows PowerShell5.1及PowerShell7临时安装、独立恢复和重复恢复验证的入口。它们不包含固定机器路径、账号、凭据或ACL，机器准备资料由各自现场维护者保存。

安装入口默认`-Mode Inspect`，必填`-PreparationDirectory`、`-ExpectedPreparationSha256`、`-TransactionDirectory`，先核准备清单、所有候选工具/文件、机器settings和install-manifest的哈希，再检查原文件与原Task相位，并执行文件更新的`-ValidateOnly`。实际数量由准备清单决定。`-Mode Apply`另需既有维护授权对应的`-OwnerWindowConfirmed`、`-MaintenanceGatePath`和`-ExpectedGateSha256`，随后禁用原Task、应用文件、切到候选Task Action并恢复原Enabled状态。该开关记录已核许可，现场仍须核具体范围和在途状态。

独立恢复入口与`PREPARATION.private.json`放在同一私有准备目录，其默认`-Mode Inspect -ExpectedPreparationSha256 <SHA256>`核完整文件与Task相位。恢复使用`-Mode Restore -ExpectedPreparationSha256 <SHA256> -TransactionDirectory <原事务绝对目录> -ExpectedPlanSha256 <原restore-plan哈希> -MaintenanceGatePath <原门路径> -ExpectedGateSha256 <原门哈希>`，生产模式同时要求`-OwnerWindowConfirmed`。恢复核原事务归属和持续保护身份，恢复旧文件、原Task Action及Enabled状态，支持重复恢复。

一个已验准备实例核对30个代码依赖与启动plan共31项，拟写14个代码文件与plan共15项，启动输入由14增至16。机器目录、基线、settings、原Task XML/SDDL和候选plan不随入口公开，各机器须生成自己的哈希绑定资料。脱敏清单用于审查，不作为可执行安装输入。

这两份入口负责文件与Task Action事务，**尚未集成**停止监督器/路由、watchdog重新拉起、scoped backend reload和真实业务验收。它们既不启动也不停止进程。完整运行切换由维护方另行串行编排，在正式Apply前先核全部前置条件和独立恢复；文件已安装与进程已加载分别验收。

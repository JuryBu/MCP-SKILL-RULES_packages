# 精确文件安装与独立恢复

来源为711b075完整候选的四份部署脚本，首次归入公共源码时修正了PowerShell7的JSON日期转换。文件更新和恢复都校验清单、源字节与目标基线；恢复保留原事务的清单、恢复计划和维护门SHA。

先在Windows PowerShell5.1和实际PowerShell7分别运行`Test-ShadowFileSet.ps1 -ResultsDirectory <各自独立的绝对目录>`。测试只创建系统Temp下的隔离文件及自有模拟锁，结果包含每项通过或失败及原fixture路径。两个测试顺序执行，因为安装工具共用全局互斥。

正式准备先运行Apply的`-ValidateOnly`，保存精确目标、候选SHA、旧字节、原权限与启动入口。LiveFiles另需机器维护门及其SHA：确认旧监督器已退出、实时runtime当前PID已退出、Node锁已释放，并逐个核对持续保护进程的PID、创建时刻和程序路径。实际QQ、BootMain、普通QQ、watchdog和broker属于保护范围；计划重新加载的MCP后端、router和监督器分别记录代次。

切换许可、账号及机器私有配置由现场维护对话核对。遇到错误立即保留原事务；恢复使用同一manifest、restore-plan和gate，不更换gate。原维护门过期后仍可恢复已开启事务，持续保护身份和实时运行状态必须重新核实。只读准备不启动生产进程、不创建正式停止标记，也不改变任务绑定。

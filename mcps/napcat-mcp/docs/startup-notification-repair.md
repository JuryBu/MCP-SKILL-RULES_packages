# 启动和通知修复：同源最小包

本目录提供桌面重开、旧实例退出后的启动恢复、Windows PowerShell子进程模块路径、通知订阅及扫描器/监督服务恢复。首次文件接入使用下述安装入口；已接入的完整运行时支持父层实现和模型工作进程共同热切，保留原连接及在途请求。8秒内快速失败后的30秒等待、生图和模型目录请求分类已纳入运行源码，各机器的实际加载版本仍以运行检查为准。

## 日常自主热切

`ops/verify-full-runtime-owner.mjs`支持`Inspect`、`Apply`、`Run`和`Restore`，增加`--non-interactive`即可由维护任务调用。`Apply`保留新实现；`Run`切换后等待60秒再恢复，供验收使用；`Restore`使用同一输入和已保存事件恢复该次升级之前的实现。

每次升级使用新的候选目录和输入。输入固定当前实例、revision、登记文件SHA及`expectedSelection`，分别用`installedManifestPath`核现装基线、`sourceManifestPath`核新源码。core/helper变化时提供经过状态兼容验证的`compatibility`，覆盖初始版本和当前版本到新版本的明确迁移边。已执行的输入不重复使用，未知结果先核实际状态及原事件。

日常热切不要求关闭Desktop或人工输入确认。独立冷恢复保留为故障后备：恢复脚本从绑定的登记文件核对候选所属、路径和源码SHA，在所有业务结束、Desktop退出且进程身份吻合后正常停启；保留升级前的登记选择和原始文件。当前健康、在途请求继续、旧实现恢复与重新启动后的选择分别验证。

## 文件选择与机器差异

`ops/build-startup-repair.mjs`以接收机器的现装目录为基线，提取启动/通知所需的11份源码，协调器只替换长工作目录的一行。包内协调器其余源码用于核对来源，安装器保留现装协调器其余内容。桌面入口只移除旧的直接修改事故状态代码，保留原程序路径、managed健康检查和提示窗口修复。实际改动数量随相同文件的跳过而变化，以生成清单为准。

`ops/prepare-startup-repair.ps1`只读现装文件，生成独立候选、原件、权限/属性清单与文件恢复入口。`ops/prepare-startup-owner.ps1`只读机器状态，生成私有操作配置、独立停止辅助脚本和看守任务备份。两者均不安装或停启生产。

## 恢复边界

启动恢复保留对话历史、消息日志、UNKNOWN和工作进程记录，不重放请求。正式入口启用保留历史和中断快照恢复：旧计数即使仍记录在途模型请求、RPC、工具调用及客户端连接，也可在完整身份、源码哈希、旧父进程、官方子进程、工作进程及监听均经核验后恢复。恢复器先保存原件，结束旧会话，新进程重新建立活动状态，消息账本继续用于去重。

活动控制事务、未知或未完成的控制操作、非法计数、账本结构错误、进程身份无法判定、活实例、状态漂移及停止标记继续阻止新实例。严格模式仍要求请求计数为0。`test/inner-startup-interrupted-recovery.test.mjs`覆盖9/10/9忙碌计数、UNKNOWN保留、活进程/孤儿进程/监听拒绝、写入失败回退；`test/inner-startup-busy-native.mjs`使用隔离目录、端口及真实Codex程序，验证完整桌面入口到Auto恢复、原生初始化和就绪，全程不发送模型业务请求。

仅更新启动文件时，使用`ops/prepare-startup-static.mjs`生成精确原件、候选及哈希清单，再用包内`update-startup-static.ps1`执行`Inspect/Update/Rollback`；当前运行进程和业务状态保持。现行桌面应急块须经`repairDesktopLauncher`识别后移除，未知变体停止生成。完整候选入口的隔离验收通过后才安装；Windows真实重启仍在正常使用窗口单独核验。

真实程序验收入口为`node test/inner-startup-busy-native.mjs <codex程序绝对路径> <桌面launcher绝对路径或-> <结果JSON绝对路径>`。第二参数为`-`时，验证正式`start-codex-model-stream-proxy.ps1`入口；设置`NAPCAT_TEST_POWERSHELL`为PowerShell程序绝对路径可选择目标Shell。测试仅在自有临时目录及空闲端口运行，成功后释放并清理；失败保留结果和现场。

## 首次文件接入入口

`ops/continue-startup-repair.ps1`要求独立Windows PowerShell窗口和显式确认。正常退出Codex后，它等待业务结束，禁用原监督任务，用有精确所有权的停止标记正常结束监督器和代理；旧看守仍在运行时，只有主人明确允许且模型进程、服务监听均退出、任务动作和进程身份匹配、没有额外子进程，才使用Stop-ScheduledTask停止这个空闲任务。随后安装所选文件，恢复消息扫描及监督服务，再恢复原看守任务，主人最后从桌面快捷方式打开Codex。账号与付费请求保持。

代理停止标记在安装及回退期间持续保留，新版看守读取state/supervisor-watchdog.stop正常结束循环并释放互斥锁，每秒复核一次。事务管理的文件由安装清单核验，普通依赖固定哈希，防止新看守的旧依赖哈希阻止回退。新增test/startup-watchdog-stop.test.mjs验证真实看守两次正常退出/再开及六类空闲任务检查；任务检查夹具不执行真实Windows任务停启，实际生产加载和系统登录另行验收。

失败时保留`owner-result.json`、`receipt.json`和原件；已经尝试的Apply不能盲目重复。独立本人入口`-Action RestoreFiles`同样要求正常退出Codex，确认监督器与代理正常结束后才调用`repair-files.ps1 -Action Rollback`。原件和清单即可执行，候选文件可以缺失；还原后监督任务保持暂停，先从快捷方式恢复桌面，再验自动守护。`UNKNOWN`继续保留，不自动重试。

## 同版检查与回包

在拥有标记的Temp目录执行`test/startup-repair-package.test.mjs`和`test/startup-repair-owner-entry.test.mjs`，显式设置`NAPCAT_INSTALLED_TEST_ROOT`指向只读现装基线。前者在派生安装目录验证真实桌面连接两次重开、保留业务历史的退出恢复及候选缺失时的文件回退；后者验证本人入口、停止标记清理、扫描/监督调用顺序和回退。该入口测试的服务启动是隔离替身，生产加载和Windows真实登录恢复分别待验。

两机分别回报包SHA、现装基线、候选清单、Shell/Node版本、实际命令和通过/失败输出、恢复资料位置，以及准备、安装、进程加载、实际消息和桌面使用的状态。业务回复沿原双机task和generation发送；运输回执与业务验收分开，ACK只确认原wake中实际完成的消息。

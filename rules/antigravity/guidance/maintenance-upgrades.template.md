# 配置维护、服务切换、备份回退与共享仓发布（Antigravity 2.0）

本专题遵循全局 `GEMINI.md`「专题阅读入口」：修改全局/工作区规则、MCP 配置、本机常驻服务，或执行任何本机 Git 提交与共享仓库脱敏同步前读取。

## 一、切换前规范备份、独立回退与原子替换

1. **备份归档不乱堆**：修改关键配置、规则或服务脚本前，禁止在目标根目录随手留 `.bak`、`_old`、`_copy`。确需留存的备份统一放入 `C:/Users/<USER>/.gemini/backups/<模块>/<日期-说明>/`（或项目对应 `backups/`），附 `manifest.json`（含原路径、字节数、SHA256、新增文件列表、当地时间）与**不依赖被改组件即可独立运行的回退脚本/命令**（如 `restore.ps1`，回退后复核 SHA256，对新增共享父目录只删本次创建文件及空目录，禁盲目 `-Recurse` 误删后续积累的用户数据；若本机设有只读永久纪念归档目录，回退或清理严禁修改、覆盖或删除）。
2. **原子写入防截断**：关键文件修改一律采用「写同目录临时文件 `<name>.tmp.<pid>` → 校验非空、UTF-8 编码无损及预算限制（如规则单文件 `< 24,000 B`） → `os.replace` 原子替换 → 核对无残留 `.tmp`」。
3. **隔离验证与重启恢复链检查**：碰运行中的服务（如代理、MCP 网关、定时任务）先在 `%TEMP%` 隔离实例跑通正常请求、异常分支、进程身份校验（如按 PID + 进程名/创建时间校验后再停止，严禁盲目 `taskkill /F` 复用 PID）及开机/重开恢复链；需要人工重启客户端或配合时，提前把完整可复制命令、预期现象与失败回退一步讲清。

## 二、本机 Git 提交身份（宿主 × 机器角色正交双标）与共享仓脱敏同步

1. **Git 提交纪律与多机反重力区分规范**：
   - 未经用户明确要求不擅自 `git commit`、建分支或修改全局/仓库级 `.git/config`。获准提交前先 `git status` / `git diff` 核对改动归属，**必须用精确文件路径 `git add -- <paths>` 隔离无关未提交修改**，禁止 `git add .` 混入他端在途工作，禁止 `force push`。
   - **保留 GitHub 账号绑定并按「宿主 × 机器角色」正交双标**：GitHub 按邮箱关联账号头像，提交时必须保留接收方已验证的 Git 邮箱不变（不动仓库本地 `.git/config` 留给 Codex 等宿主的默认 `user.name`）。双机协作体系（如 `development` 开发机与 `training` 训练机）提交前须先从本机 `GEMINI.md` 第七节 / `personal-care.local.md` 读取已确认的 `local_role` 并与仓库本地 `.git/config` 交叉核对——**角色未确认时必须先向用户核实，严禁默认推断为 `development` 或让两台机器的反重力混用同一无角色标签**：
     - **开发机反重力（`local_role=development`）**：传 `-c user.name="<ExistingGitName> [Antigravity 2.0 · development]"`，`<= 72` 字符标题尾标写 **`[Antigravity/dev]`**，Trailer 填 `Antigravity-Machine: development`；
     - **训练机反重力（`local_role=training`）**：传 `-c user.name="<ExistingGitName> [Antigravity 2.0 · training]"`，`<= 72` 字符标题尾标写 **`[Antigravity/training]`**，Trailer 填 `Antigravity-Machine: training`；
     - **单机无角色环境（`local_role=standalone`）**：传 `-c user.name="<ExistingGitName> [Antigravity 2.0]"`，标题尾标写 `[Antigravity]`，Trailer 填 `Antigravity-Machine: standalone`；
     - 在单消息体（`-F <msg_file>` 或单 `-m`）末尾连续无空行附上三行来源 Trailer：
       - `Antigravity-Agent: Antigravity 2.0`
       - `Antigravity-Machine: <development|training|standalone>`
       - `Antigravity-Conversation: <当前稳定 conversationId>`
2. **五端共享仓库唯一主目录串行与双机模板分层防冲突**：
   - **唯一主目录与 `main` 串行**：在共享工具包仓库（`<toolkit-root>`）中只于唯一主目录的 `main` 分支操作，不为实现或发布另建分支、worktree、clone 或整仓副本；若其它宿主维护线程正在修改相关模块，先核对协调，绝不并发抢改覆盖。
   - **双机规则分层防冲突**：`rules/antigravity/GEMINI.template.md` 与基础四专题保持跨机通用；后续若训练机部署 Antigravity 2.0 并需接入条件式训练监督规则，应独立新增按需专题（如 `rules/antigravity/guidance/training-machine.template.md`）并在本机私有入口挂接，避免开发机与训练机反复抢改同一核心文件。
   - **严格脱敏审查**：公开模板更新前必须运行 `./install/Test-CodexToolkit.ps1` 的可移植文本与结构校验并逐行检查 `git diff --cached`，**严禁将本机私有个人信息、社交/内容平台账号 ID、Cookie/密钥、本机用户名绝对路径、私人目录昵称或私密对话正文提交进公开仓库**；本机安装生效与公开模板同步分开核验、如实汇报。

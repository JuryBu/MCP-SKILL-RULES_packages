# 配置维护、服务切换、备份回退与共享仓发布（Antigravity 2.0）

本专题遵循全局 `GEMINI.md`「专题阅读入口」：修改全局/工作区规则、MCP 配置、本机常驻服务，或执行任何本机 Git 提交与共享仓库脱敏同步前读取。

## 一、切换前规范备份、独立回退与原子替换

1. **备份归档不乱堆**：修改关键配置、规则或服务脚本前，禁止在目标根目录随手留 `.bak`、`_old`、`_copy`。确需留存的备份统一放入 `C:/Users/<USER>/.gemini/backups/<模块>/<日期-说明>/`（或项目对应 `backups/`），附 `manifest.json`（含原路径、字节数、SHA256、新增文件列表、当地时间）与**不依赖被改组件即可独立运行的回退脚本/命令**（如 `restore.ps1`，回退后复核 SHA256，对新增共享父目录只删本次创建文件及空目录，禁盲目 `-Recurse` 误删后续积累的本地个人数据；若本机设有只读永久纪念归档目录，回退或清理严禁修改、覆盖或删除）。
2. **原子写入防截断**：关键文件修改一律采用「写同目录临时文件 `<name>.tmp.<pid>` → 校验非空、UTF-8 编码无损及预算限制（如规则单文件 `< 24,000 B`） → `os.replace` 原子替换 → 核对无残留 `.tmp`」。
3. **隔离验证、独立恢复入口与拆清依赖分批推进（禁保守转嫁等待成本）**：碰运行中的服务（如代理、交流核心、MCP 网关、定时任务）先在 `%TEMP%` 隔离实例跑通正常请求、异常分支、进程身份校验（按 PID + 进程名/创建时间校验后再停止，严禁盲目 `taskkill /F`）及开机/重开恢复链；一旦涉及切崩会导致模型失联的关键服务，**必先验通不依赖被升级对象的独立恢复入口与双层回退**。把「独立开窗实发测试」「当前批次现役切换」「后续各批准备与独立核验」按真实依赖拆开（已验证过的隔离前提直接复用，不从头重跑）：核心服务严禁攒大包一次全切，整体获准且每批具备独立验收与回退后，**趁用户离席电脑空闲窗口按最小独立单元观察达标即连续推进下一批，无需每批停等人工或跨端搭档签字放行**；异常即停在该批按预案回退并验旧链路。**除确需人工亲手操作、补权限或极端不可逆破坏外，严禁因支线开窗受阻或「怕弹窗/怕风险」把全部无依赖批次冻结让用户硬等**；需人工配合时，把完整可复制命令、预期现象与失败回退一步讲清。

## 二、本机 Git 提交身份（宿主 × 机器角色正交双标）与共享仓脱敏同步

1. **Git 提交纪律与多机反重力区分规范**：
   - 通用仓库默认未经用户明确要求不擅自 `git commit`/`git push`，所有仓库禁止擅自建分支/worktree/clone、`force push` 或修改全局/仓库级 `.git/config`；从用户已有安排核对本线对多端共享维护仓（`<toolkit-root>`）的维护与公开发布职责（见各项目或本机私有覆盖；既有授权直接沿用，不把复制示例文件当成自动授权），职责内完成适用实测（按改动范围做针对性实测，不强加小修全跑全套单测）、既有独立审查与脱敏核对并按第 2 条确认 `main` 串行写窗实际轮到本线后，按动作链「核 `git status`/`git diff` 归属并 `git fetch` 核最新远端变化 → **精确 `git add -- <paths>` 隔离无关未提交修改（禁 `git add .` 混入他端在途工作）** → 逐行核 `git diff --cached` → 按下方正交署名提交 → 推送远端 → 核查远端结果」自主执行（免逐次请用户批推）；明确只读、暂停或另约发布时机的按该任务安排，源码推仓不等于自动升级/切换/重启生产服务。
   - **保留 GitHub 账号绑定并按「宿主 × 机器角色」正交双标**：GitHub 按邮箱关联账号头像，提交时必须保留接收方已验证的 Git 邮箱不变（不动仓库本地 `.git/config` 留给 Codex 等宿主的默认 `user.name`）。双机协作体系（如 `development` 开发机与 `training` 训练机）提交前须先从本机 `GEMINI.md` 第七节 / `personal-care.local.md` 读取已确认的 `local_role` 并与仓库本地 `.git/config` 交叉核对——**角色未确认时必须先向用户核实，严禁默认推断为 `development` 或让两台机器的反重力混用同一无角色标签**：
     - **开发机反重力（`local_role=development`）**：传 `-c user.name="<ExistingGitName> [Antigravity 2.0 · development]"`，`<= 72` 字符标题尾标写 **`[Antigravity/dev]`**，Trailer 填 `Antigravity-Machine: development`；
     - **训练机反重力（`local_role=training`）**：传 `-c user.name="<ExistingGitName> [Antigravity 2.0 · training]"`，`<= 72` 字符标题尾标写 **`[Antigravity/training]`**，Trailer 填 `Antigravity-Machine: training`；
     - **单机无角色环境（`local_role=standalone`）**：传 `-c user.name="<ExistingGitName> [Antigravity 2.0]"`，标题尾标写 `[Antigravity]`，Trailer 填 `Antigravity-Machine: standalone`；
     - 在单消息体（`-F <msg_file>` 或单 `-m`）末尾连续无空行附上三行来源 Trailer：
       - `Antigravity-Agent: Antigravity 2.0 (<当前主模型可读名>)`
       - `Antigravity-Machine: <development|training|standalone>`
       - `Antigravity-Conversation: <当前稳定 conversationId>`
2. **五端共享仓库唯一主目录串行与双机模板分层防冲突**：
   - **唯一主目录与 `main` 串行**：在共享工具包仓库（`<toolkit-root>`）中只于唯一主目录的 `main` 分支操作，不为实现或发布另建分支、worktree、clone 或整仓副本。多宿主维护线程并行工作时，先准备差异并经 `communication-core`（见 `guidance/communication-bridges.md`）协调串行写窗（不请用户批窗）：**以「本次交棒已确认且仍有效，或已排定的写入时段实际轮到本线」为准**，再实核无其它在途写入、无 `.git/index.lock`、暂存区为空且已 `git fetch` 核清最新远端无冲突变更，确认齐备后按上节动作链自主精确暂存、提交并推送（对端离线时亦沿同一判据并记入 `reconnect-sync.md`，待对端恢复在线首拍自主补发完整变更清单与提交哈希）。**竞态与未就绪底线**：若旧交棒失效、上一棒刚提交仍在推送尚未完成交棒、尚未拿到交棒/排定写入时段未实际轮到本线，或远端现态核不清、存在并发写/暂存区脏污——**即使暂存区已空且 `.git/index.lock` 已释放，也只保留共享写入这一步，照常推进其余不碰暂存区的独立验证并记入 `reconnect-sync.md`**，绝不并发抢改或混入他人未提交改动。
   - **双机规则分层防冲突**：`rules/antigravity/components/`、`variants/*.profile.json`（预留 `machineRole` 扩展字段）与基础五专题保持跨机通用；后续若训练机部署 Antigravity 2.0 并需接入条件式训练监督规则，应独立新增按需专题（如 `rules/antigravity/guidance/training-machine.template.md`）及对应变体清单，避免开发机与训练机反复抢改同一核心文件。
   - **严格脱敏审查与双版本门禁**：公开模板更新前必须运行 `./install/Test-CodexToolkit.ps1` 的可移植文本与结构校验并逐行检查 `git diff --cached`；**更新 `rules/antigravity/` 时必同步运行 `./install/Test-AntigravityRulesProfiles.ps1`（校验 `catgirl` + `neutral` 双版本构建、20/30 字符用户名膨胀下 `< 24,000 B`、组件与 `GEMINI.template.md` 逐字一致及零私密泄露）**。**严禁将本机私有个人信息、社交/内容平台账号 ID、Cookie/密钥、本机用户名绝对路径、私人目录昵称或私密对话正文提交进公开仓库**；本机安装生效与公开模板同步分开核验、如实汇报。

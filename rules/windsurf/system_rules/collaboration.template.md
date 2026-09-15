## 代码执行

- 所有命令与脚本执行优先 MCP sandbox（硬超时+内存限制+输出截断）；宿主原生终端（Cascade 的 run_command / Devin 的 exec）仅作 sandbox 不可达时的 fallback、或需要交互式终端/用户审批留痕的场景，「命令短」「只读」不构成跳过 sandbox 的理由
  · exec/session/batch 三种模式，长任务用 sandbox_launch
- ⚠️ 文件写入安全：Python open("w") 截断文件，重要文件用原子写入（先临时文件→os.replace）

## 任务分发与协作

对话越长越贵（按上下文计费），独立可拆的活优先拆子代理，保护主线上下文预算。

### 分发判断

- **Codex CLI**：纯代码 Review / 大规模审核 / 跨文件重构（GPT 额度多且便宜）
- **子代理**：执行留痕（跑测试/截图验证）、探索调研、脏活外包（扫目录/读长文/批量分析）、并行独立模块——独立可拆就优先拆出去
- **sandbox_council**：多模型讨论/审议/方案对比（纯讨论轻量）
- **主线自己做**：需要深度上下文的活、简单小改动、多轮快速交互

### Codex

日常说的「Codex」= 本地客户端（大规模协同实现/Review/材料搜索/核查），通过报对话ID中转协作，我启动不了只能用户操作。
Codex CLI (sandbox_codex)：GPT专属通道，background=true启动+check(waitSeconds=45)。GPT需求优先走CLI不要spawn GPT子代理。

### 子代理

通用要求（两种宿主都适用）：
- 派发前写清**输出路径**（报告存哪、文件写哪）；只读任务用探索档，需要动手才用可写档
- 涉及看图/截图的任务确认所选模型支持多模态（GLM 系列不支持图片）；模型用语义档/自定义 profile，不硬编码模型名
- 派发必须要求带回证据：文件路径、行号、关键发现、命令输出，以及「没查哪些范围」；子代理结论不得原样转述为最终答案
- 并行派发修改类任务时写明各自文件范围，不许交叉；并发别贪多，默认上限 4，结束的及时回收；子代理不得再派子代理或后台 Codex 任务，协作保持单层
- 微小任务自己干，等待也是成本

旧 Windsurf Cascade（MCP subagent 可 spawn 独立 Cascade 窗口）：告诉子代理「读 main_id 对应的对话原文」而不是在 prompt 里复述上下文；被 spawn 时收到 main_id 主动读原文相关段落；mode 只读用 explore / ask，动手才用 code；用完主动 dispose（archive/delete），不留僵尸占对话位。

Devin Desktop（原生 `run_subagent` / `read_subagent`，旧 MCP subagent 已退役）：子代理看不到主线上下文、也读不到本对话原文，背景全靠 prompt（相关文件路径、Plan/Task、图片路径、本轮结论与约束、MCP 超时与截断纪律）；固定角色或模型用 `.devin/agents/<name>.md` 自定义 profile。**默认 `is_background=true` 不阻塞主线**，多个互不相干的子代理在同一条回复里一起派出才是并行，完成后用 `read_subagent(block=true)` 收；只有「下一步必须等它、且手头无其它活」才用前台阻塞。后台派发时未审批的写操作会被自动拒绝，所以后台优先派只读的探索档。

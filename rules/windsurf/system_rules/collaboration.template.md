## 代码执行

- 所有执行优先 MCP sandbox（硬超时+内存限制+输出截断），run_command 仅限需用户审批的危险操作
  · exec/session/batch 三种模式，长任务用 sandbox_launch
- ⚠️ 文件写入安全：Python open("w") 截断文件，重要文件用原子写入（先临时文件→os.replace）

## 任务分发与协作

WSF 按对话长度计价。独立可拆的活优先拆子代理，保护主线上下文预算。

### 分发判断

- **Codex CLI**：纯代码 Review / 大规模审核 / 跨文件重构（GPT 额度多且便宜）
- **子代理**：执行留痕（跑测试/截图验证）、探索调研、脏活外包（扫目录/读长文/批量分析）、并行独立模块——独立可拆就优先拆出去
- **sandbox_council**：多模型讨论/审议/方案对比（纯讨论轻量）
- **主线自己做**：需要深度上下文的活、简单小改动、多轮快速交互

### Codex

日常说的「Codex」= 本地客户端（大规模协同实现/Review/材料搜索/核查），通过报对话ID中转协作，我启动不了只能用户操作。
Codex CLI (sandbox_codex)：GPT专属通道，background=true启动+check(waitSeconds=45)。GPT需求优先走CLI不要spawn GPT子代理。

### 子代理 (subagent)

MCP subagent 可 spawn 独立 Cascade 窗口并行工作，完成后回收结果。

spawn 规范：
- 明确指定**输出路径**（报告存哪、文件写哪）
- 需要了解背景时，告诉子代理「读 main_id 对应的对话原文」，不要在 prompt 里复述上下文
- 被 spawn 为子代理时：收到 main_id 主动读对话原文相关段落和材料文件，完整不缺地完成任务
- **mode 选择**：只读任务用 explore / ask，需要动手才用 code
- ⚠️ 多模态：spawn返回model_supports_images；GLM系列不支持图片，涉及截图/看图别用GLM
- model_profile：优先用语义档（cowork/explore/frontend/review），不硬编码模型名。subagent_models 不带query看family概览，带query查具体模型

生命周期：
- spawn 的子代理用完主动 dispose（archive归档LS/delete彻底删），不留僵尸占对话位
- max_concurrent 别贪多，默认 4

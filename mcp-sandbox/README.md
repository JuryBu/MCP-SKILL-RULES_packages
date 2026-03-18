# MCP Sandbox v1.5

代码执行沙箱 MCP Server，解决 Antigravity IDE 中 run_command 的超时卡死、临时文件繁琐、输出管理粗糙等痛点。

## 功能

| 工具 | 功能 |
|------|------|
| `sandbox_exec` | 执行代码片段或系统命令，支持硬超时、内存限制、GPU、输出截断、重复输出折叠 |
| `sandbox_session` | 持久 REPL 会话，变量状态跨调用保持 |
| `sandbox_batch` | 一次调用并行执行多个任务 |
| `sandbox_status` | 查看系统状态、可用环境、GPU/CUDA 信息 |
| `sandbox_codex` | Codex CLI 专用调用，后台模式不阻塞，自动报告检查 |
| `sandbox_launch` | 长任务脱离执行（模型训练等），进程独立于 MCP，磁盘持久化 |

## 核心优势（vs run_command）

- ✅ 直接传代码字符串，不用写临时文件
- ✅ 硬超时 + 自动杀进程，不会卡死
- ✅ 内存限制，防止吃光系统内存
- ✅ 输出截断/模式控制，不爆上下文
- ✅ 连续重复输出自动折叠（`[× N 重复]`）
- ✅ maxLines 行数限制（保留头尾，折叠中间）
- ✅ 持久 REPL 会话，有状态交互
- ✅ 并行执行多任务
- ✅ GPU/CUDA 支持
- ✅ 清晰的失败原因（timeout/memory/vram/crash）

## 进程生命周期

MCP 进程与父 LS 进程绑定（ppid），与窗口同生共死：
- 窗口开着 → LS 在 → sandbox 永远不会自杀（无超时限制）
- 窗口关闭 → LS 消失 → sandbox 30s 内自动退出
- 双保险：`stdin.on('end')` 秒级响应 + `isParentAlive()` 30s 兜底

## 开发

```bash
npm install
npm run build
```

## 相关文档

- Plan_1.md — v1.0 总纲领
- Plan_2_codex_tool.md — Codex 工具详设
- Plan_4_output_quality.md — 输出质量优化
- LS-Principles.md — LS 进程原理
- Task.md — 执行任务清单

# 自动摘要校验与定点修复

自动摘要用于概括记忆正文。默认模型链路优先Grok，只有允许的候选继续回退；显式模型链路保持指定范围。候选校验拒绝完整停用通知、常见服务错误封装与空响应，正常讨论模型停用或错误的摘要仍可保存。响应长度或某个模型名称本身不会触发拒绝。

新建、更新和补缺入口保存实际provider、model、生成时间及失败来源。生成失败保留已有摘要；正文在生成期间改变时，提交前重新比较版本。`searchSummary`和记忆正文保持原职责。

## 检查确认清单

在包安装目录运行：

```text
node scripts/repair-auto-summaries.mjs --data-root /path/to/private-data --manifest /path/to/confirmed-targets.json
```

源码尚未编译时，贡献者可用 `node --import tsx`执行相同脚本。发布包使用随包编译模块，无需安装tsx。默认检查不调用模型，返回当前原摘要和两种指纹，以及确认清单本身的SHA256。

```json
{"version":1,"targets":[{"hash":"workspace-hash","memoryId":"confirmed-memory-id","expectedSummary":"exact old summary","expectedFingerprint":"current-file-fingerprint","expectedSourceFingerprint":"current-body-and-metadata-fingerprint","confirmed":true,"reason":"Confirmed service notice saved as a summary"}]}
```

仅纳入已经核实异常的条目。`expectedSummary`保留精确原值，两种指纹使用当前检查结果；正文或其它元数据变化后重新检查确认。正常摘要无需进入清单。

## 执行、恢复和还原

```text
node scripts/repair-auto-summaries.mjs --data-root /path/to/private-data --manifest /path/to/confirmed-targets.json --apply --confirm-sha256 EXACT_MANIFEST_SHA256 --chain auto
```

执行先核确认清单，再生成新摘要；提交时在同一记忆写入保护内核原摘要及正文/元数据。只修改摘要和来源字段，失败保留现值。文件写入前在数据根 `auto-summary-transactions`保存原件、目标内容及SHA256。

| 结果 | 后续动作 |
|---|---|
| `written` / `existing` | 核对摘要、正文及两级索引 |
| `stale` | 当前内容已改变，保留现值并重新检查确认 |
| `index-pending` | 保留原operationId/backupPath，沿同一事务恢复 |
| 失败、取消或结果未知 | 核原请求及事务状态，再决定下一步 |

`--recover`替代 `--apply`恢复已写文件与索引同步，模型请求为0。`--restore`还原备份，清单项另需原 `operationId`，同样不调用模型。两种模式都要求当前确认清单的SHA256；当前文件与事务状态冲突时保留现值和备份。三种修改模式互斥，恢复沿原事务，不新建重复模型请求。

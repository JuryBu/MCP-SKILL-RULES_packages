# 请求体上传等待量

Runner 支持分别配置上传时间估计与其上限，其余首个有效增量等待、空闲保护及重试次数保持现有设置。

`uploadAllowanceMs = min(maxUploadAllowanceMs, ceil(encodedBytes / 1048576 * uploadAllowanceMsPerMiB))`。`encodedBytes` 是按 Content-Encoding 编码后的实际请求体大小，单位为字节，除以 1048576 后换算为 MiB。首次有效增量的期限为现有首增量等待时间加上该上传等待量；上下文压缩（compaction）请求仍沿用现有独立期限。

环境变量 `CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB` 接受0～60000的整数，默认33555，约按每请求0.25Mbps预留上传时间；`CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS` 接受0～2146883647的整数，给其它等待保留600000ms后仍在Node定时器范围内，默认 `min(2146883647, 128 * uploadAllowanceMsPerMiB)`。默认128MiB请求上限对应4295040ms上传余量。旧配置显式设置600000ms时仍会封顶，升级时须一并核对实际配置。

也可在受管 runtime profile 的 `stateRoot` 放置私有 `codex-model-upload-policy.json`，独立 runner 则在自己的 `stateRoot` 读取。文件可选，最多 4096 字节，格式如下：

```json
{"schemaVersion":1,"uploadAllowanceMsPerMiB":33555,"maxUploadAllowanceMs":4295040}
```

同名环境变量优先于文件。文件仅在 worker 启动时读取，使用现有候选准备与受控激活入口加载新 worker，保护旧 worker 中尚在运行的请求。保留原候选、注册表与配置备份，使用同一实例的受控恢复入口回退；禁止为生效强停健康请求。通过新 worker 状态和自然业务日志中的 `encodedBytes`、`uploadAllowanceMs` 核验，磁盘配置变化单独记录为已准备。

### 按候选版本启用传输配置

需要让新候选启用WS，同时让回退版本保留原设置时，可在同一stateRoot放置 `codex-model-runtime-policy.json`。它在worker启动时读取一次，最多4096字节；`sourceCoreSha256`须为该候选 `codex-model-stream-proxy.mjs` 的完整SHA256。匹配时，仅覆盖下列四项；版本不匹配时沿用原环境和上传配置，不改父进程环境。

```json
{
  "schemaVersion": 1,
  "sourceCoreSha256": "<candidate-core-sha256>",
  "incrementalWs": true,
  "incrementalImages": true,
  "uploadAllowanceMsPerMiB": 33555,
  "maxUploadAllowanceMs": 4295040
}
```

占位值须替换为实际哈希。配置解析、类型或范围错误会阻止该候选启动，现有worker保持原设置。准备和激活候选前，应在隔离启动中核对实际runtime状态的四个值；回退后核对旧worker值。运行中的请求继续使用启动时配置。

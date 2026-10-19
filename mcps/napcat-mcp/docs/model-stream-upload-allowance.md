# 请求体上传等待量

Runner 支持分别配置上传时间估计与其上限，其余首个有效增量等待、空闲保护及重试次数保持现有设置。

`uploadAllowanceMs = min(maxUploadAllowanceMs, ceil(encodedBytes / 1048576 * uploadAllowanceMsPerMiB))`。`encodedBytes` 是按 Content-Encoding 编码后的实际请求体大小，单位为字节，除以 1048576 后换算为 MiB。首次有效增量的期限为现有首增量等待时间加上该上传等待量；上下文压缩（compaction）请求仍沿用现有独立期限。

环境变量 `CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB` 接受 0～60000 的整数，默认 1000；`CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS` 接受 0～600000 的整数，默认 `min(600000, 128 * uploadAllowanceMsPerMiB)`。默认最多缓存 128 MiB 请求体，因此 2000 和 3000 ms/MiB 对应完整范围的上限分别为 256000 和 384000 ms。更大的请求体限制或更慢估计仍须核对 600000 ms 的最高上限。

也可在受管 runtime profile 的 `stateRoot` 放置私有 `codex-model-upload-policy.json`，独立 runner 则在自己的 `stateRoot` 读取。文件可选，最多 4096 字节，格式如下：

```json
{"schemaVersion":1,"uploadAllowanceMsPerMiB":2000,"maxUploadAllowanceMs":256000}
```

同名环境变量优先于文件。文件仅在 worker 启动时读取，使用现有候选准备与受控激活入口加载新 worker，保护旧 worker 中尚在运行的请求。保留原候选、注册表与配置备份，使用同一实例的受控恢复入口回退；禁止为生效强停健康请求。通过新 worker 状态和自然业务日志中的 `encodedBytes`、`uploadAllowanceMs` 核验，磁盘配置变化单独记录为已准备。

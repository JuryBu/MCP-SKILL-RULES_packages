# Model stream waiting policy

The inner stream proxy applies the following default deadlines in version `2026-10-03.1`. Codex still owns its native retry loop; the proxy does not add upstream replays.

| Phase | Default |
| --- | --- |
| First and last attempt, waiting for first progress | 60 seconds |
| One retry after a first-progress timeout | 90 seconds |
| Other attempts, waiting for first progress | 40 seconds |
| Fresh reasoning progress followed by silence | 60 seconds |

With six attempts and repeated first-progress timeouts, the deadlines are `60, 90, 40, 40, 40, 60` seconds. The 90-second opportunity is conditional on the previous first-progress timeout; connection resets and HTTP errors do not automatically grant it. Successful responses clear the failure chain.

Rapid failures cannot consume all six attempts immediately: after the fifth failure, the proxy waits until at least 70 seconds have elapsed since the chain started before exposing the retry signal for the final attempt. It does not add 70 seconds between each retry, and it adds no delay when the chain is already older than that.

The no-first-progress chain limit is 340 seconds, preserving the former 300-second limit plus the two 20-second extensions. A single attempt remains limited to 300 seconds without meaningful progress. After meaningful progress, subsequent retries retain the original 300-second shared no-progress limit. Heartbeats do not replenish these limits; upstream silence still has a 90-second limit during an adaptive wait.

Reasoning extensions apply to fresh text/summary deltas and completed encrypted reasoning items, including supported partial frames. Duplicate or empty completed reasoning does not refresh the deadline. Ordinary text, tool preparation/completion, compaction, cancellation, and explicit terminal policy failures retain their separate behavior.

The health/status response exposes `firstLastProgressTimeoutMs`, `reasoningProgressIdleTimeoutMs`, `rapidRetryMinimumMs`, and `consecutiveWaitLimitMs` in addition to the existing base and adaptive settings. Test-sized base deadlines scale the extension defaults proportionally; larger existing deadlines are not shortened.

Deployment only replaces the inner core. The installed runner and its machine-specific integrations must be preserved. Prepare a fresh backup/plan for the actual running instance, use the existing component operator during a request gap, then verify loaded version, effective settings, ordinary traffic, and unchanged outer/AppServer identities. A previously consumed plan is not a reusable installation authorization.

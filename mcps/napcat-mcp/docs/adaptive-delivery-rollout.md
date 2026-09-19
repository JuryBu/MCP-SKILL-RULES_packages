# Adaptive delivery rollout

The model-stream proxy is an optional local component. Installing its source does not prove that Codex uses it. Check the effective provider and a correlated real request before claiming end-to-end activation. Do not change account credentials, network configuration or the global provider as a side effect of a component update.

## Component-only update

Use a clean source snapshot and resolve the complete relative import closure of `src/codex-model-stream-proxy.mjs` and `src/codex-model-stream-proxy-runner.mjs`. Include `adaptive-delivery.mjs`, the existing tool preparation/progress/profile helpers, stream recovery, observability and atomic log/file helpers. Compare every candidate file against the receiving machine, preserving private data, account bindings and tool-delivery profiles.

Before stopping the component, save exact original file bytes, existence flags, SHA256 values, startup parameters and any adaptive state file. Verify runtime, lock, listening process and runner path identify the same instance. Require an idle, non-draining proxy; do not force-stop active generation. Fence unattended starts during the brief replacement, then use the receiving machine's existing startup path with an explicit private DataRoot and Node executable. Launch persistent services outside execution wrappers that kill descendant processes when they return.

After start, verify `implementationVersion=2026-09-19.4`, normal first/progress deadlines `40000`, adaptive limit `300000`, upstream idle limit `90000`, and the original private tool-profile count. Verify the new listener matches runtime/lock identity and all update-owned maintenance/stop markers are cleared. Do not restart Desktop, App Server, NapCat, the network client or task routing merely to replace this model proxy.

On a startup or ownership failure, stop only the new component if safe, restore original bytes and prior adaptive state, and restart with the previous parameters. Keep other services untouched. If rollback cannot be verified, leave the maintenance fence and report the exact state instead of starting an unverified instance.

## Acceptance

Run a harmless request through the candidate explicitly, without changing the global provider. Confirm a genuine upstream completion, first-content time, delivery shape, retry count and process cleanup. For an affected account, confirm that a heartbeat-backed request can pass the 40-second checkpoint and complete below 300 seconds, that successful concentrated delivery is persisted, and that a subsequent request starts in the learned mode. Separate isolated CLI acceptance from normal Desktop task acceptance.

Full Desktop activation requires a separately reviewed provider switch, an exact configuration backup and a normal Codex restart. The provider must retain finite native stream retries (`stream_max_retries = 5`): the proxy signals recoverable failures to Codex instead of replaying ordinary requests itself. A zero-retry override is useful for isolated single-attempt measurements, but must not become the permanent activation default. Keep `stream_idle_timeout_ms = 150000` as the client transport-idle limit; upstream heartbeats and the proxy's independent 300-second adaptive budget serve different purposes. Verify a real Desktop request reaches the installed proxy before claiming that custom retry and idle-completion protection is active.

Concurrent short responses are not authoritative mode-change evidence: they must not suppress an earlier successful probe. Genuine newer sustained streaming evidence still supersedes older buffered completions. Test both cases. Never use a safety refusal or an incomplete response as mode-learning evidence, and never reissue restricted content as part of transport testing.

Keep cancellation, an independently silent upstream, a continuously heartbeating 300-second request, late tool commits and same-turn replay in regression coverage. Heartbeats may keep the transport alive but cannot move the absolute budget. Logging is diagnostic only, not a generated model-progress notification.

Legacy artifacts remain old snapshots until rebuilt and identified by their source commit and content hashes. A successful Git push alone does not update either machine's installed files or existing archives.

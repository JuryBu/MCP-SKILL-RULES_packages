# Runtime reliability and selective installation

## Scope

Model proxy `2026-09-24.1` adds bounded native retry for an adaptive upstream-idle timeout before replay-unsafe progress. The managed App Server retains a complete verified official runtime package instead of depending on a Desktop cache directory that an update may remove.

These changes do not authorize stopping other tasks, changing accounts, enabling active model probes, or copying another machine's private configuration. Source publication, local installation, and a receiving machine's live acceptance are separate states.

## Retry contract

Normal first-progress and progress-idle limits remain 40 seconds. Adaptive delivery retains a 90-second upstream-idle limit and a 300-second total waiting budget. An eligible idle failure uses the existing client retry path, not a second proxy-owned upstream retry loop. The chain shares its original deadline and at most six attempts including the first; cancellation or another failure branch must not reset its budget or discard replay-safety evidence.

The new idle retry requires a stable request identity and no previous content, substantive work, tool activity or compaction in the chain. An exhausted deadline, exhausted attempts or unsafe replay terminates instead. Existing quota, permanent-error, safety-policy, local-tool and compaction rules remain distinct. Before the sixth attempt, the existing rapid-failure rule only fills any shortfall to 40 seconds of total elapsed time; it does not add another 40 seconds after every failure.

## Complete runtime package

The runner verifies the official companion executables and signatures, then publishes a content-addressed runtime directory atomically. A missing, altered, incomplete or unverified candidate cannot replace the verified running package. Refresh still requires a client-free window; normal use is not interrupted to force an update. A stopped CLI runner exits only after its owned shutdown has successfully completed.

The PowerShell launcher defaults to a 45-second backend startup timeout and 120-second outer readiness wait. It forwards a total startup budget equal to the outer wait minus a 15-second readiness margin, so the default shared budget is 105 seconds rather than the former hidden 26-second cap. This shared deadline covers package preparation, signatures, candidate probes and initial readiness; each backend probe is capped by both its own timeout and the remaining shared budget. The CLI exposes `--startup-budget-ms` with the same 105-second default, and runtime state records both budgets. Changing the PowerShell outer wait changes its forwarded shared budget; a backend timeout larger than that budget is rejected before any runtime modification. Readiness returns immediately when proven, not after the full wait, and a live process or old state file is not success.

## Dependency and installation boundary

The four repair modules are not a universal four-file installer. Older installations may also lack `request-body-inspector.mjs`, its worker, `request-body-buffer.mjs`, `zstd-frame-validation.mjs`, and `model-observation-hooks.mjs`. The App Server proxy must support `pauseUpstream`, `resumeUpstream` and `setUpstreamUrl`; the published proxy also uses the existing turn-observability dependency. Verify the complete relative-module closure from both actual startup entrypoints.

The required request-parser implementation distinguishes a 64 MiB encoded request limit from a 96 MiB decoded limit, with a shared 256 MiB in-flight encoded-body budget. Parsing runs in one worker with bounded queueing, cancellation and a common wait/execute deadline. It forwards original request bytes and reports specific encoding, compression, size or JSON errors rather than collapsing all failures into invalid JSON. It does not delete images or silently truncate context. Passive observation hooks alone do not install a collector, GUI or active probe.

Before replacing anything, record the receiver's actual version, file hashes, startup entrypoints, explicit data directory, ports, owned processes, in-flight work and private-state boundaries. Different hashes require a content/API comparison, not automatic replacement. Preserve an independently runnable rollback that does not depend on the candidate or a working Desktop session. Retain the receiver's own credentials, task ledger, routes and private overrides.

Validate the frozen package in isolated state directories and loopback ports using the receiver's intended control scripts. Check startup, initialize/list RPCs, complete package identity, clean stop and rollback before coordinating any application-exit or reboot window. A cold-start hook must be receiver-specific, one-shot and serialized with its existing startup lock; never transplant another machine's process IDs, boot identity, ports or cleanup authorization.

Reject a preflight before stopping services if ownership, baseline, quiescence or rollback is uncertain. After changes, failed startup or acceptance requires the verified receiver-local rollback; unknown recovery state must remain visible rather than causing an automatic installation loop.

## Acceptance evidence

Unit and loopback tests cover the idle retry budget, mixed failures, cancellation and unsafe replay, package completeness, candidate refresh, startup deadlines and owned shutdown. The launcher parameter test checks defaults and explicit overrides without starting production. Local cold-boot acceptance has separately verified actual backend/tool paths and normal tool calls; no deliberately induced live model failure is implied by those tests.

A receiver must return its own transaction outcome, deployed hashes, running version, backend and tool-host paths, normal tool/message behavior, preserved private state, and cleanup of one-shot maintenance markers. Transport receipts, file copies and HTTP health alone are not application acceptance.

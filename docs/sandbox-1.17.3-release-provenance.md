# Sandbox 1.17.3 release provenance

The implementation is published by commits `45a5c72c49ffd9e648de3fb1f7c0b4c441b2f6bf` and `e393fda7cd90027939c2032aa12062642a2785a0`, following the Memory Store 1.24.0 update on the same main branch. The component package and verified development installation use source commit `e393fda7cd90027939c2032aa12062642a2785a0`.

## Task attribution correction

Both implementation commits incorrectly contain `Codex-Task: mcp-sandbox-main`. The registered task association is **`mcp-sandbox-maintenance-sync`**; `mcp-sandbox-main` is not a registered task. This document and its accompanying commit explicitly correct the attribution of both earlier commits. Their machine and conversation trailers remain unchanged.

Published history is retained rather than force-pushed, so the original incorrect trailers remain visible and must be interpreted with this correction. This follow-up changes release documentation only; it does not alter the tested component binaries or require another backend reload.

## Verification boundary

The release passed targeted admission/replay, real Windows process, exec/batch, cancellation, legacy-record compatibility, and large-registry lifecycle tests. The development installation passed real MCP short-command and launch lifecycle checks. Its native runner was retained because its source and build script are unchanged; this binary-byte exception is recorded in the installation manifest.

Only the Sandbox component package was validated. The existing full-toolkit package validation issue remains separately tracked, and deployment to the second machine is deferred.

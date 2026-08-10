"""WeChat database watcher — file change detection and incremental decryption.

This module provides the "automatic trigger" layer that sits between the
WeChat process writing to its encrypted databases and the ``DbObserver``
reading from decrypted copies.  It monitors the encrypted ``db_storage``
directory for file modifications, re-decrypts only the changed files, and
then hands off to the observer for message polling.

Design goals:
* No file system watchers or OS-level hooks — uses simple polling with
  mtime/size comparison, which is portable and predictable.
* Only re-decrypts files that have changed since the last scan.
* The key extraction tool is invoked once per refresh cycle (it takes
  ~3 seconds and ensures keys are current even after WeChat restarts).
* All paths are configurable via environment variables; no real paths
  appear in this source file.
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from .db_observer import DbObserver, Observation, RouteBinding
from .ledger import EventLedger


@dataclass
class FileSnapshot:
    """Snapshot of a single encrypted database file."""
    rel_path: str
    size: int
    mtime: float


@dataclass
class WatchResult:
    """Result of one watch cycle."""
    changed_files: list[str] = field(default_factory=list)
    decrypted_files: list[str] = field(default_factory=list)
    new_observations: list[Observation] = field(default_factory=list)
    elapsed_seconds: float = 0.0
    error: str | None = None


class DbWatcher:
    """Monitors encrypted WeChat databases and triggers incremental decryption.

    Parameters
    ----------
    db_dir
        Path to the encrypted ``db_storage`` directory.
    decrypted_dir
        Path to the decrypted output directory.
    keys_file
        Path to the JSON file containing extracted keys.
    bindings
        Authorised route bindings.
    ledger
        Event ledger for baseline management and event ingestion.
    """

    def __init__(
        self,
        db_dir: str | Path,
        decrypted_dir: str | Path,
        keys_file: str | Path,
        bindings: Sequence[RouteBinding],
        ledger: EventLedger,
    ) -> None:
        self.db_dir = Path(db_dir)
        self.decrypted_dir = Path(decrypted_dir)
        self.keys_file = Path(keys_file)
        self.bindings = list(bindings)
        self.ledger = ledger
        self._snapshot: dict[str, FileSnapshot] = {}
        self._observer = DbObserver(self.decrypted_dir, self.bindings)
        self._initial_scan_done = False
        self._lock = threading.Lock()

    def _scan_encrypted_files(self) -> dict[str, FileSnapshot]:
        """Build a snapshot of all .db files in the encrypted directory."""
        snapshot: dict[str, FileSnapshot] = {}
        for root, _dirs, files in os.walk(self.db_dir):
            for name in files:
                if not name.endswith(".db") or name.endswith("-wal") or name.endswith("-shm"):
                    continue
                path = os.path.join(root, name)
                rel = os.path.relpath(path, self.db_dir)
                try:
                    stat = os.stat(path)
                    snapshot[rel] = FileSnapshot(rel_path=rel, size=stat.st_size, mtime=stat.st_mtime)
                except OSError:
                    continue
        return snapshot

    def _detect_changes(self, current: dict[str, FileSnapshot]) -> list[str]:
        """Return list of files that changed since the last snapshot.

        Does NOT advance the snapshot — the caller must call
        ``_advance_snapshot()`` after successfully processing changes.
        This ensures that failed key extraction or decryption will
        retry on the next cycle instead of silently skipping.
        """
        if not self._snapshot:
            return list(current.keys())
        changed: list[str] = []
        for rel, snap in current.items():
            old = self._snapshot.get(rel)
            if old is None or old.size != snap.size or old.mtime != snap.mtime:
                changed.append(rel)
        return changed

    def _advance_snapshot(self, current: dict[str, FileSnapshot]) -> None:
        """Commit the current snapshot as the new baseline.

        Only call this after key extraction, decryption, and polling
        have all succeeded.  If this is not called, the next cycle
        will re-detect the same changes and retry.
        """
        self._snapshot = current

    def _has_message_db_changed(self, changed_files: list[str]) -> bool:
        """Check if any message-related database file has changed."""
        for f in changed_files:
            lower = f.replace("\\", "/").lower()
            if "message" in lower and lower.endswith(".db"):
                return True
        return False

    def refresh_keys(self) -> bool:
        """Re-extract keys from the running WeChat process.

        Returns True if extraction succeeded.  This calls the external
        key extraction tool via subprocess; the tool path is read from
        the ``WECHAT_KEY_TOOL`` environment variable or defaults to
        ``private-state/tools/wcdb_key_tool_windows.py`` under the data root.
        """
        import subprocess
        import sys

        tool_path = Path(
            os.environ.get(
                "WECHAT_KEY_TOOL",
                Path.home() / ".codex-toolkit" / "wechat-docs-mcp" / "private-state" / "tools" / "wcdb_key_tool_windows.py",
            )
        )
        if not tool_path.exists():
            return False
        result = subprocess.run(
            [sys.executable, str(tool_path), "extract",
             "--db-dir", str(self.db_dir),
             "--output", str(self.keys_file)],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=30,
        )
        return result.returncode == 0

    def decrypt_changed(self, changed_files: list[str]) -> list[str]:
        """Re-decrypt the database files that changed.

        Currently uses the key tool's ``decrypt`` command which re-decrypts
        all files.  In the future this could be optimized to only decrypt
        changed files, but the full decrypt takes ~10 seconds for 18 files
        which is acceptable for a polling-based watcher.
        """
        import subprocess
        import sys

        tool_path = Path(
            os.environ.get(
                "WECHAT_KEY_TOOL",
                Path.home() / ".codex-toolkit" / "wechat-docs-mcp" / "private-state" / "tools" / "wcdb_key_tool_windows.py",
            )
        )
        result = subprocess.run(
            [sys.executable, str(tool_path), "decrypt",
             "--db-dir", str(self.db_dir),
             "--keys", str(self.keys_file),
             "--output", str(self.decrypted_dir)],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=60,
        )
        if result.returncode != 0:
            return []
        return changed_files

    def poll_and_ingest(self) -> tuple[list[Observation], bool]:
        """Poll for new messages and ingest them into the ledger.

        Reads baselines from the ledger, polls the observer, ingests
        new events, and advances the baselines.

        Returns a tuple of (observations, all_succeeded).  all_succeeded
        is True only if every observation was successfully ingested (or
        was a dedup of an already-ingested event).  When False, the
        caller should not advance the file snapshot so that failed
        messages are retried on the next cycle.

        Baseline advancement uses contiguous success: if messages 4, 5, 6
        are observed and 5 fails, the baseline advances only to 4 (not 6),
        ensuring message 5 is retried on the next cycle without permanently
        skipping it.  Message 6 will be re-observed next cycle but
        deduplicated by source_fingerprint.
        """
        baselines: dict[str, int] = {}
        for binding in self.bindings:
            try:
                baselines[binding.route_id] = self.ledger.get_baseline(binding.route_id)
            except Exception:
                baselines[binding.route_id] = 0

        observations = list(self._observer.poll_new_messages(baselines))

        if not observations:
            return [], True

        # Track per-route success: which local_ids were successfully ingested
        success_ids: dict[str, set[int]] = {}
        all_obs_ids: dict[str, list[int]] = {}
        any_failure = False

        for obs in observations:
            rid = obs.route_id
            local_id = obs.payload.get("local_id", 0)
            all_obs_ids.setdefault(rid, []).append(local_id)
            try:
                self.ledger.ingest_event(
                    route_id=obs.route_id,
                    source_fingerprint=obs.source_fingerprint,
                    event_type=obs.event_type,
                    payload=obs.payload,
                    occurred_at=obs.occurred_at,
                    sensitivity=obs.sensitivity,
                    deliver_to_subscriptions=obs.payload.get("direction") != "outbound",
                )
                success_ids.setdefault(rid, set()).add(local_id)
            except Exception:
                any_failure = True

        # Advance baseline only to the highest contiguous successful local_id.
        # If there is a gap (e.g., 4 ok, 5 failed, 6 ok), baseline stops at 4
        # so message 5 is retried next cycle.  Message 6 will be re-observed
        # but deduplicated by source_fingerprint.
        for rid, observed_list in all_obs_ids.items():
            observed_sorted = sorted(observed_list)
            success_set = success_ids.get(rid, set())
            contiguous_max = baselines.get(rid, 0)
            for lid in observed_sorted:
                if lid in success_set:
                    contiguous_max = lid
                else:
                    break
            if contiguous_max > baselines.get(rid, 0):
                try:
                    self.ledger.update_baseline(rid, contiguous_max)
                except Exception:
                    any_failure = True

        return observations, not any_failure

    def watch_once(self, force_refresh: bool = False) -> WatchResult:
        """Run one complete watch cycle.

        1. Scan encrypted files for changes.
        2. If message DBs changed (or force_refresh), re-extract keys and decrypt.
        3. Poll for new messages and ingest into ledger.
        4. Only advance the file snapshot if all steps succeeded.

        On the first call, a full refresh is forced to catch messages that
        arrived while the service was offline.

        Thread-safe: acquires an internal lock so concurrent calls
        (e.g. background thread + manual wechat_poll) are serialized.

        Returns a ``WatchResult`` summarizing what happened.
        """
        with self._lock:
            return self._watch_once_impl(force_refresh)

    def _watch_once_impl(self, force_refresh: bool) -> WatchResult:
        t0 = time.time()
        result = WatchResult()

        current = self._scan_encrypted_files()
        changed = self._detect_changes(current)
        result.changed_files = changed

        # First scan: force a full refresh to catch offline messages.
        # _detect_changes returns all files when _snapshot is empty,
        # so the normal flow below will handle key extraction, decryption,
        # and polling.  We do NOT advance the snapshot here — that only
        # happens after successful processing.
        if not self._initial_scan_done:
            self._initial_scan_done = True
            force_refresh = True

        if not changed and not force_refresh:
            result.elapsed_seconds = time.time() - t0
            return result

        if not self._has_message_db_changed(changed) and not force_refresh:
            # Non-message DB changed — advance snapshot so we don't re-detect
            self._advance_snapshot(current)
            result.elapsed_seconds = time.time() - t0
            return result

        # When force_refresh with no detected changes, treat all files as
        # changed so decrypt_changed returns a non-empty list on success.
        if force_refresh and not changed:
            changed = list(current.keys())
            result.changed_files = changed

        if not self.refresh_keys():
            result.error = "Key extraction failed"
            # Do NOT advance snapshot — next cycle will retry
            result.elapsed_seconds = time.time() - t0
            return result

        result.decrypted_files = self.decrypt_changed(changed)
        if not result.decrypted_files:
            result.error = "Decryption failed"
            # Do NOT advance snapshot — next cycle will retry
            result.elapsed_seconds = time.time() - t0
            return result

        # Poll and ingest — only advance snapshot if all ingestions succeeded
        observations, ingest_ok = self.poll_and_ingest()
        result.new_observations = observations
        if ingest_ok:
            self._advance_snapshot(current)
        else:
            result.error = "Ingestion failed for some messages"
            # Do NOT advance snapshot — next cycle will retry

        result.elapsed_seconds = time.time() - t0
        return result

    def watch_loop(self, interval: float = 5.0, max_cycles: int = 0) -> None:
        """Run watch cycles in a loop.

        Parameters
        ----------
        interval
            Seconds between cycles (when no changes detected).
        max_cycles
            If > 0, stop after this many cycles.  If 0, run indefinitely.
        """
        cycle = 0
        while True:
            result = self.watch_once()
            if result.error:
                print(f"[cycle {cycle}] ERROR: {result.error}")
            elif result.new_observations:
                print(f"[cycle {cycle}] {len(result.new_observations)} new message(s)")
                for obs in result.new_observations:
                    text = obs.payload.get("visible_text", "")[:60]
                    print(f"  {obs.route_id}: [{obs.event_type}] {text}")
            elif result.changed_files:
                print(f"[cycle {cycle}] {len(result.changed_files)} file(s) changed, 0 new messages")
            else:
                pass
            cycle += 1
            if max_cycles > 0 and cycle >= max_cycles:
                break
            time.sleep(interval)

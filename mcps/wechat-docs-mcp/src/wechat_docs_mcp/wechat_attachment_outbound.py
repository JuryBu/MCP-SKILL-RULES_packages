from __future__ import annotations

import hashlib
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable, Protocol

from .outbound import (
    FocusState,
    OutboundExecutionResult,
    OutboundRefused,
    OutboundState,
    UiBackendError,
)
from .route_verifier import RouteVerifier, VerifiedRoute


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class AttachmentOutboundLedger(Protocol):
    def get_route(self, route_id: str) -> Mapping[str, Any]: ...

    def get_draft(self, draft_id: str) -> Mapping[str, Any]: ...

    def acquire_draft_execution(
        self,
        draft_id: str,
        payload: Mapping[str, Any],
        dedupe_key: str,
        execution_id: str,
        lease_expires_at: str,
        *,
        lease_scope: str = "wechat-visible-ui",
    ) -> Mapping[str, Any]: ...

    def finish_draft_execution(
        self,
        draft_id: str,
        execution_id: str,
        next_state: str,
        result: Mapping[str, Any] | None = None,
        error_code: str | None = None,
    ) -> Mapping[str, Any]: ...

    def verify_attachment_draft(
        self,
        draft_id: str,
        observation: dict[str, Any],
    ) -> Mapping[str, Any]: ...

    def mark_draft_unknown(
        self,
        draft_id: str,
        expected_states: list[str],
        error_code: str,
        result: dict[str, Any] | None = None,
    ) -> Mapping[str, Any]: ...


class AttachmentUiBackend(Protocol):
    def snapshot_environment(self) -> object: ...

    def wake(self) -> None: ...

    def locate_window(self) -> object: ...

    def window_focus_state(self, window: object) -> FocusState: ...

    def navigate_visible(self, window: object, route: VerifiedRoute) -> None: ...

    def claim_empty_draft(self, window: object, route: VerifiedRoute) -> object: ...

    def write_owned_attachment(
        self,
        window: object,
        draft_handle: object,
        route: VerifiedRoute,
        path: Path,
    ) -> None: ...

    def focus_state(
        self,
        window: object,
        draft_handle: object,
        route: VerifiedRoute,
    ) -> FocusState: ...

    def send_owned_attachment(self, window: object, draft_handle: object) -> None: ...

    def clear_owned_attachment(self, window: object, draft_handle: object) -> None: ...

    def restore_environment(self, snapshot: object) -> None: ...

    def environment_observation(self) -> dict[str, Any]: ...


class AttachmentDatabaseVerifier(Protocol):
    def baseline(self, route: VerifiedRoute) -> int: ...

    def verify(
        self,
        route: VerifiedRoute,
        kind: str,
        payload: Mapping[str, Any],
        baseline_local_id: int,
    ) -> dict[str, Any]: ...


class SafeAttachmentOutbound:
    def __init__(
        self,
        ledger: AttachmentOutboundLedger,
        route_verifier: RouteVerifier,
        backend: AttachmentUiBackend,
        database_verifier: AttachmentDatabaseVerifier,
        upload_root: str | Path,
        execution_gate: Callable[[], bool] | None = None,
    ) -> None:
        self._ledger = ledger
        self._route_verifier = route_verifier
        self._backend = backend
        self._database_verifier = database_verifier
        self._upload_root = Path(upload_root).resolve()
        self._execution_gate = execution_gate

    def _require_execution_gate(self) -> None:
        if self._execution_gate is not None and not self._execution_gate():
            raise OutboundRefused(
                "ATTACHMENT_OUTBOUND_DISABLED",
                "附件 outbound 动态 gate 已关闭",
            )

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _md5(path: Path) -> str:
        digest = hashlib.md5()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _validate_payload(self, kind: str, payload: Mapping[str, Any]) -> Path:
        if kind not in {"wechat_file", "wechat_image"}:
            raise OutboundRefused("ATTACHMENT_KIND_INVALID", "草稿不是文件或图片发送")
        required = {"transfer_id", "file_name", "byte_count", "sha256", "content_md5", "local_path"}
        if not required.issubset(payload):
            raise OutboundRefused("ATTACHMENT_PAYLOAD_INVALID", "附件草稿字段不完整")
        source = Path(str(payload["local_path"])).resolve()
        if not source.is_file() or not _inside(source, self._upload_root):
            raise OutboundRefused(
                "ATTACHMENT_UPLOAD_PATH_NOT_ALLOWED",
                "附件来源文件不在允许的 upload root 内",
            )
        if source.name != payload["file_name"]:
            raise OutboundRefused("ATTACHMENT_SOURCE_CHANGED", "附件来源文件不存在或名称已变化")
        if source.stat().st_size != int(payload["byte_count"]):
            raise OutboundRefused("ATTACHMENT_SOURCE_CHANGED", "附件字节数已变化")
        if self._sha256(source) != payload["sha256"]:
            raise OutboundRefused("ATTACHMENT_SOURCE_CHANGED", "附件 SHA-256 已变化")
        if self._md5(source) != str(payload["content_md5"]).lower():
            raise OutboundRefused("ATTACHMENT_SOURCE_CHANGED", "附件 MD5 已变化")
        return source

    @staticmethod
    def _focus_is_verified(value: FocusState | str) -> bool:
        try:
            return FocusState(value) is FocusState.VERIFIED
        except ValueError:
            return False

    def execute(
        self,
        *,
        draft_id: str,
        payload: Mapping[str, Any],
        dedupe_key: str,
        lease_expires_at: str,
        execution_id: str | None = None,
    ) -> OutboundExecutionResult:
        draft = self._ledger.get_draft(draft_id)
        if draft.get("state") != OutboundState.APPROVED.value:
            raise OutboundRefused("DRAFT_NOT_APPROVED", "draft 未处于 APPROVED")
        if draft.get("payload") != dict(payload):
            raise OutboundRefused("DRAFT_CHANGED", "执行附件与批准草稿不一致")
        owner_authorization_refs = draft.get("owner_authorization_refs")
        if not isinstance(owner_authorization_refs, list) or not owner_authorization_refs:
            raise OutboundRefused("OWNER_AUTH_REQUIRED", "批准记录缺少 owner_authorization_refs")
        route_id = draft.get("route_id")
        kind = str(draft.get("kind") or "")
        if not isinstance(route_id, str) or not route_id:
            raise OutboundRefused("DRAFT_ROUTE_INVALID", "draft 缺少唯一 route_id")
        source = self._validate_payload(kind, payload)
        capability = "image" if kind == "wechat_image" else "file"
        route = self._route_verifier.verify(route_id, self._ledger.get_route(route_id), capability)
        active_execution_id = execution_id or str(uuid.uuid4())
        self._ledger.acquire_draft_execution(
            draft_id,
            payload,
            dedupe_key,
            active_execution_id,
            lease_expires_at,
            lease_scope="wechat-visible-ui",
        )

        state = OutboundState.FAILED
        error_code: str | None = None
        send_action_invoked = False
        send_may_have_occurred = False
        cleanup_performed = False
        cleanup_error_code: str | None = None
        restore_succeeded = True
        restore_error_code: str | None = None
        draft_handle: object | None = None
        window: object | None = None
        snapshot: object | None = None
        baseline_local_id: int | None = None
        local_observation: dict[str, Any] | None = None

        try:
            self._require_execution_gate()
            baseline_local_id = self._database_verifier.baseline(route)
            snapshot = self._backend.snapshot_environment()
        except Exception as error:
            error_code = getattr(error, "code", "ATTACHMENT_PREFLIGHT_FAILED")
        else:
            try:
                self._backend.wake()
                window = self._backend.locate_window()
                if not self._focus_is_verified(self._backend.window_focus_state(window)):
                    raise UiBackendError("WINDOW_FOCUS_UNVERIFIED", "微信窗口焦点无法确认")
                self._backend.navigate_visible(window, route)
                source = self._validate_payload(kind, payload)
                draft_handle = self._backend.claim_empty_draft(window, route)
                self._backend.write_owned_attachment(window, draft_handle, route, source)
                if not self._focus_is_verified(self._backend.focus_state(window, draft_handle, route)):
                    raise UiBackendError("ATTACHMENT_DRAFT_ROUTE_UNVERIFIED", "附件草稿无法证明属于目标 route")
                self._require_execution_gate()
                send_action_invoked = True
                try:
                    self._backend.send_owned_attachment(window, draft_handle)
                except UiBackendError as error:
                    send_may_have_occurred = error.send_may_have_occurred
                    raise
                except Exception:
                    send_may_have_occurred = True
                    raise
                else:
                    send_may_have_occurred = True
                state = OutboundState.SEND_ATTEMPTED
                if baseline_local_id is not None:
                    try:
                        local_observation = self._database_verifier.verify(
                            route,
                            kind,
                            payload,
                            baseline_local_id,
                        )
                        local_observation["baseline_local_id"] = baseline_local_id
                    except Exception as error:
                        error_code = getattr(
                            error,
                            "code",
                            "ATTACHMENT_DATABASE_CONFIRMATION_FAILED",
                        )
                        state = OutboundState.UNKNOWN
            except UiBackendError as error:
                error_code = error.code
                if send_may_have_occurred or error.send_may_have_occurred:
                    state = OutboundState.UNKNOWN
            except Exception as error:
                error_code = getattr(error, "code", "ATTACHMENT_UI_BACKEND_EXCEPTION")
                if send_may_have_occurred:
                    state = OutboundState.UNKNOWN
            finally:
                if draft_handle is not None and not send_may_have_occurred and window is not None:
                    try:
                        if self._focus_is_verified(
                            self._backend.focus_state(window, draft_handle, route)
                        ):
                            self._backend.clear_owned_attachment(window, draft_handle)
                            cleanup_performed = True
                    except Exception:
                        cleanup_error_code = "ATTACHMENT_OWNED_DRAFT_CLEANUP_FAILED"
                        if error_code is None:
                            error_code = cleanup_error_code
                        state = OutboundState.FAILED
                if snapshot is not None:
                    try:
                        self._backend.restore_environment(snapshot)
                    except Exception:
                        restore_succeeded = False
                        restore_error_code = (
                            "RESTORE_FAILED_AFTER_SEND" if send_may_have_occurred else "RESTORE_FAILED"
                        )
                        if error_code is None:
                            error_code = restore_error_code
                        state = OutboundState.UNKNOWN if send_may_have_occurred else OutboundState.FAILED

        observation_getter = getattr(self._backend, "environment_observation", None)
        environment_observation = observation_getter() if callable(observation_getter) else {}
        audit_result = {
            "route_id": route_id,
            "execution_id": active_execution_id,
            "transfer_id": payload.get("transfer_id"),
            "send_action_invoked": send_action_invoked,
            "cleanup_performed": cleanup_performed,
            "cleanup_error_code": cleanup_error_code,
            "restore_succeeded": restore_succeeded,
            "restore_error_code": restore_error_code,
            "baseline_local_id": baseline_local_id,
            "environment_observation": environment_observation,
        }
        self._ledger.finish_draft_execution(
            draft_id,
            active_execution_id,
            state.value,
            result=audit_result,
            error_code=error_code,
        )

        if local_observation is not None:
            audit_result["local_attachment_observation"] = local_observation
        if (
            local_observation is not None
            and restore_succeeded
            and state is OutboundState.SEND_ATTEMPTED
        ):
            error_code = "ATTACHMENT_REMOTE_CONFIRMATION_REQUIRED"
            state = OutboundState.UNKNOWN
        if send_may_have_occurred and state is OutboundState.UNKNOWN:
            self._ledger.mark_draft_unknown(
                draft_id,
                [OutboundState.SEND_ATTEMPTED.value, OutboundState.UNKNOWN.value],
                error_code or "ATTACHMENT_DATABASE_CONFIRMATION_FAILED",
                audit_result,
            )

        return OutboundExecutionResult(
            draft_id=draft_id,
            execution_id=active_execution_id,
            route_id=route_id,
            state=state,
            error_code=error_code,
            send_action_invoked=send_action_invoked,
            cleanup_performed=cleanup_performed,
            restore_succeeded=restore_succeeded,
            cleanup_error_code=cleanup_error_code,
            restore_error_code=restore_error_code,
        )

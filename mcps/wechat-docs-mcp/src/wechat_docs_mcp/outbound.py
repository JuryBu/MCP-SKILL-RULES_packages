from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from .route_verifier import RouteVerifier, VerifiedRoute


class OutboundState(StrEnum):
    PREPARED = "PREPARED"
    APPROVED = "APPROVED"
    EXECUTING = "EXECUTING"
    SEND_ATTEMPTED = "SEND_ATTEMPTED"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    UNKNOWN = "UNKNOWN"


class FocusState(StrEnum):
    VERIFIED = "VERIFIED"
    MISMATCH = "MISMATCH"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class OutboundCapabilities:
    visible_ui: bool = True
    experimental_hidden_wm_char: bool = False
    hidden_after_verified_navigation: bool = True


@dataclass(frozen=True)
class OutboundExecutionResult:
    draft_id: str
    execution_id: str
    route_id: str
    state: OutboundState
    error_code: str | None
    send_action_invoked: bool
    cleanup_performed: bool
    restore_succeeded: bool
    cleanup_error_code: str | None = None
    restore_error_code: str | None = None


class OutboundRefused(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class UiBackendError(RuntimeError):
    def __init__(self, code: str, message: str, *, send_may_have_occurred: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.send_may_have_occurred = send_may_have_occurred


class OutboundLedger(Protocol):
    def get_route(self, route_id: str) -> Mapping[str, Any]: ...

    def get_draft(self, draft_id: str) -> Mapping[str, Any]: ...

    def acquire_draft_execution(
        self,
        draft_id: str,
        payload: Mapping[str, Any],
        dedupe_key: str,
        execution_id: str,
        lease_expires_at: str,
    ) -> Mapping[str, Any]: ...

    def finish_draft_execution(
        self,
        draft_id: str,
        execution_id: str,
        next_state: str,
        result: Mapping[str, Any] | None = None,
        error_code: str | None = None,
    ) -> Mapping[str, Any]: ...

    def verify_text_draft(
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


class TextDatabaseVerifier(Protocol):
    def baseline(self, route: VerifiedRoute) -> int: ...

    def verify(
        self,
        route: VerifiedRoute,
        text: str,
        baseline_local_id: int,
    ) -> dict[str, Any]: ...


class VisibleUiBackend(Protocol):
    def snapshot_environment(self) -> object: ...

    def wake(self) -> None: ...

    def locate_window(self) -> object: ...

    def window_focus_state(self, window: object) -> FocusState: ...

    def navigate_visible(self, window: object, route: VerifiedRoute) -> None: ...

    def focus_state(self, window: object, route: VerifiedRoute) -> FocusState: ...

    def claim_empty_draft(self, window: object, route: VerifiedRoute) -> object: ...

    def write_owned_draft(self, window: object, draft_handle: object, text: str) -> None: ...

    def send_owned_draft(self, window: object, draft_handle: object) -> None: ...

    def clear_owned_draft(self, window: object, draft_handle: object) -> None: ...

    def restore_environment(self, snapshot: object) -> None: ...

    def environment_observation(self) -> dict[str, Any]: ...


class SafeTextOutbound:
    capabilities = OutboundCapabilities()

    def __init__(
        self,
        ledger: OutboundLedger,
        route_verifier: RouteVerifier,
        backend: VisibleUiBackend,
        database_verifier: TextDatabaseVerifier | None = None,
    ) -> None:
        self._ledger = ledger
        self._route_verifier = route_verifier
        self._backend = backend
        self._database_verifier = database_verifier

    @staticmethod
    def _validate_payload(payload: Mapping[str, Any]) -> str:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise OutboundRefused("INVALID_TEXT_PAYLOAD", "文字发送 payload 必须包含非空 text")
        attachments = payload.get("attachments")
        if attachments not in (None, [], ()):
            raise OutboundRefused("TEXT_ONLY", "文字发送骨架不接受附件")
        return text

    @staticmethod
    def _focus_is_verified(value: FocusState | str) -> bool:
        try:
            return FocusState(value) is FocusState.VERIFIED
        except ValueError:
            return False

    def _require_verified_focus(self, window: object, route: VerifiedRoute) -> None:
        if not self._focus_is_verified(self._backend.focus_state(window, route)):
            raise UiBackendError("FOCUS_UNVERIFIED", "窗口或焦点身份无法确认")

    def _require_verified_window_focus(self, window: object) -> None:
        if not self._focus_is_verified(self._backend.window_focus_state(window)):
            raise UiBackendError("WINDOW_FOCUS_UNVERIFIED", "微信窗口焦点无法确认")

    def execute_text(
        self,
        *,
        draft_id: str,
        payload: Mapping[str, Any],
        dedupe_key: str,
        lease_expires_at: str,
        execution_id: str | None = None,
    ) -> OutboundExecutionResult:
        text = self._validate_payload(payload)
        draft = self._ledger.get_draft(draft_id)
        if draft.get("state") != OutboundState.APPROVED.value:
            raise OutboundRefused("DRAFT_NOT_APPROVED", "draft 未处于 APPROVED")
        owner_authorization_refs = draft.get("owner_authorization_refs")
        if not isinstance(owner_authorization_refs, list) or not owner_authorization_refs:
            raise OutboundRefused("OWNER_AUTH_REQUIRED", "批准记录缺少 owner_authorization_refs")
        route_id = draft.get("route_id")
        if not isinstance(route_id, str) or not route_id:
            raise OutboundRefused("DRAFT_ROUTE_INVALID", "draft 缺少唯一 route_id")

        ledger_route = self._ledger.get_route(route_id)
        verified_route = self._route_verifier.verify(route_id, ledger_route, "text")
        active_execution_id = execution_id or str(uuid.uuid4())
        self._ledger.acquire_draft_execution(
            draft_id,
            payload,
            dedupe_key,
            active_execution_id,
            lease_expires_at,
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
        baseline_local_id: int | None = None
        database_observation: dict[str, Any] | None = None

        try:
            if self._database_verifier is not None:
                baseline_local_id = self._database_verifier.baseline(verified_route)
            snapshot = self._backend.snapshot_environment()
        except Exception as error:
            error_code = getattr(error, "code", "ENV_SNAPSHOT_FAILED")
        else:
            try:
                self._backend.wake()
                window = self._backend.locate_window()
                self._require_verified_window_focus(window)
                self._backend.navigate_visible(window, verified_route)
                self._require_verified_focus(window, verified_route)
                draft_handle = self._backend.claim_empty_draft(window, verified_route)
                self._require_verified_focus(window, verified_route)
                self._backend.write_owned_draft(window, draft_handle, text)
                self._require_verified_focus(window, verified_route)
                send_action_invoked = True
                try:
                    self._backend.send_owned_draft(window, draft_handle)
                except UiBackendError as error:
                    send_may_have_occurred = error.send_may_have_occurred
                    raise
                except Exception:
                    send_may_have_occurred = True
                    raise
                else:
                    send_may_have_occurred = True
                state = OutboundState.SEND_ATTEMPTED
                if baseline_local_id is not None and self._database_verifier is not None:
                    try:
                        database_observation = self._database_verifier.verify(
                            verified_route,
                            text,
                            baseline_local_id,
                        )
                        database_observation["baseline_local_id"] = baseline_local_id
                    except Exception as error:
                        error_code = getattr(error, "code", "TEXT_DATABASE_CONFIRMATION_FAILED")
                        state = OutboundState.UNKNOWN
            except UiBackendError as error:
                error_code = error.code
                if send_may_have_occurred or error.send_may_have_occurred:
                    state = OutboundState.UNKNOWN
            except Exception:
                error_code = "UI_BACKEND_EXCEPTION"
                if send_may_have_occurred:
                    state = OutboundState.UNKNOWN
            finally:
                if draft_handle is not None and not send_may_have_occurred and window is not None:
                    try:
                        if self._focus_is_verified(self._backend.focus_state(window, verified_route)):
                            self._backend.clear_owned_draft(window, draft_handle)
                            cleanup_performed = True
                    except Exception:
                        cleanup_error_code = "OWNED_DRAFT_CLEANUP_FAILED"
                        if error_code is None:
                            error_code = cleanup_error_code
                        state = OutboundState.FAILED
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

        if database_observation is not None and restore_succeeded and state is OutboundState.SEND_ATTEMPTED:
            try:
                verified = self._ledger.verify_text_draft(draft_id, database_observation)
                state = OutboundState(str(verified["state"]))
                error_code = verified.get("error_code")
            except Exception as error:
                error_code = getattr(error, "code", "TEXT_DATABASE_CONFIRMATION_FAILED")
                self._ledger.mark_draft_unknown(
                    draft_id,
                    [OutboundState.SEND_ATTEMPTED.value, OutboundState.UNKNOWN.value],
                    error_code,
                    audit_result,
                )
                state = OutboundState.UNKNOWN
        elif send_may_have_occurred and state is OutboundState.UNKNOWN:
            self._ledger.mark_draft_unknown(
                draft_id,
                [OutboundState.SEND_ATTEMPTED.value, OutboundState.UNKNOWN.value],
                error_code or "TEXT_DATABASE_CONFIRMATION_FAILED",
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

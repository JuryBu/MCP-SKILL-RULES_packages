from __future__ import annotations

import hmac
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from .ledger import payload_sha256


class DocumentMonitorPolicyStatus(StrEnum):
    VERIFIED = "VERIFIED"
    NOT_FOUND = "NOT_FOUND"
    AMBIGUOUS = "AMBIGUOUS"
    UNVERIFIED = "UNVERIFIED"


class DocumentMonitorPolicyError(RuntimeError):
    def __init__(self, status: DocumentMonitorPolicyStatus, reason: str) -> None:
        super().__init__(reason)
        self.code = status.value
        self.status = status


@dataclass(frozen=True)
class VerifiedDocumentMonitorPolicy:
    policy_ref: str
    resource_kind: str
    resource_key_sha256: str
    poll_tool: str
    poll_arguments_sha256: str


class PrivateBindingDocumentMonitorVerifier:
    def __init__(self, binding: Mapping[str, Any]) -> None:
        self._binding = binding

    def summary(self) -> dict[str, int]:
        policies = self._policies()
        return {
            "configured_policy_count": len(policies),
            "active_policy_count": sum(
                policy.get("state") == "active" and policy.get("listen") is True
                for policy in policies
            ),
        }

    def verify(
        self,
        resource_kind: str,
        resource_key: str,
        poll_tool: str,
        poll_arguments: Mapping[str, Any],
        policy_ref: str,
    ) -> VerifiedDocumentMonitorPolicy:
        return self._verify_hashes(
            resource_kind,
            payload_sha256(resource_key.strip()),
            poll_tool,
            payload_sha256(dict(poll_arguments)),
            policy_ref,
        )

    def verify_stored(self, monitor: Mapping[str, Any]) -> VerifiedDocumentMonitorPolicy:
        poll_arguments = monitor.get("poll_arguments")
        if not isinstance(poll_arguments, Mapping):
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.UNVERIFIED,
                "monitor 账本中的 poll_arguments 无效",
            )
        return self._verify_hashes(
            str(monitor.get("resource_kind") or ""),
            str(monitor.get("resource_key_sha256") or ""),
            str(monitor.get("poll_tool") or ""),
            payload_sha256(dict(poll_arguments)),
            str(monitor.get("policy_ref") or ""),
        )

    def _verify_hashes(
        self,
        resource_kind: str,
        resource_key_sha256: str,
        poll_tool: str,
        poll_arguments_sha256: str,
        policy_ref: str,
    ) -> VerifiedDocumentMonitorPolicy:
        if self._binding.get("schemaVersion") not in {1, 2}:
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.UNVERIFIED,
                "private binding schemaVersion 不受支持",
            )
        if not policy_ref.strip():
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.UNVERIFIED,
                "文档监视 policy_ref 不能为空",
            )
        candidates = [
            policy
            for policy in self._policies()
            if hmac.compare_digest(str(policy.get("policy_ref") or ""), policy_ref)
        ]
        if not candidates:
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.NOT_FOUND,
                "policy_ref 不在 private binding 的 Tencent Docs allowlist 中",
            )
        if len(candidates) != 1:
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.AMBIGUOUS,
                "private binding 中存在重复的文档监视 policy_ref",
            )
        policy = candidates[0]
        if policy.get("state") != "active" or policy.get("listen") is not True:
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.UNVERIFIED,
                "文档监视策略未同时启用 active 和 listen",
            )
        configured_key_hash = self._configured_hash(
            policy,
            raw_name="resource_key",
            hash_name="resource_key_sha256",
        )
        configured_arguments_hash = self._configured_hash(
            policy,
            raw_name="poll_arguments",
            hash_name="poll_arguments_sha256",
        )
        checks = (
            str(policy.get("resource_kind") or "").strip().casefold()
            == resource_kind.strip().casefold(),
            hmac.compare_digest(configured_key_hash, resource_key_sha256),
            str(policy.get("poll_tool") or "").strip() == poll_tool.strip(),
            hmac.compare_digest(configured_arguments_hash, poll_arguments_sha256),
        )
        if not all(checks):
            raise DocumentMonitorPolicyError(
                DocumentMonitorPolicyStatus.UNVERIFIED,
                "请求的资源、官方工具或参数与 private binding allowlist 不一致",
            )
        return VerifiedDocumentMonitorPolicy(
            policy_ref=policy_ref,
            resource_kind=resource_kind.strip().casefold(),
            resource_key_sha256=resource_key_sha256,
            poll_tool=poll_tool.strip(),
            poll_arguments_sha256=poll_arguments_sha256,
        )

    def _policies(self) -> list[Mapping[str, Any]]:
        tencent_docs = self._binding.get("tencentDocs")
        if not isinstance(tencent_docs, Mapping):
            return []
        policies = tencent_docs.get("monitors")
        if not isinstance(policies, Sequence) or isinstance(policies, (str, bytes, bytearray)):
            return []
        return [policy for policy in policies if isinstance(policy, Mapping)]

    @staticmethod
    def _configured_hash(policy: Mapping[str, Any], *, raw_name: str, hash_name: str) -> str:
        configured_hash = policy.get(hash_name)
        if isinstance(configured_hash, str) and configured_hash.strip():
            return configured_hash.strip().casefold()
        raw_value = policy.get(raw_name)
        if raw_name == "resource_key" and isinstance(raw_value, str) and raw_value.strip():
            return payload_sha256(raw_value.strip())
        if raw_name == "poll_arguments" and isinstance(raw_value, Mapping):
            return payload_sha256(dict(raw_value))
        raise DocumentMonitorPolicyError(
            DocumentMonitorPolicyStatus.UNVERIFIED,
            f"private binding 文档策略缺少 {raw_name} 或 {hash_name}",
        )

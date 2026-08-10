from __future__ import annotations

import pytest

from wechat_docs_mcp.document_policy import (
    DocumentMonitorPolicyError,
    PrivateBindingDocumentMonitorVerifier,
)
from wechat_docs_mcp.ledger import payload_sha256


def policy(*, schema_version: int = 2) -> dict[str, object]:
    return {
        "schemaVersion": schema_version,
        "tencentDocs": {
            "monitors": [
                {
                    "policy_ref": "private-policy",
                    "resource_kind": "sheet",
                    "resource_key": "synthetic-file-id",
                    "poll_tool": "manage.query_file_info",
                    "poll_arguments": {"file_id": "synthetic-file-id"},
                    "state": "active",
                    "listen": True,
                }
            ]
        },
    }


@pytest.mark.parametrize("schema_version", [1, 2])
def test_private_document_policy_supports_current_private_binding_versions(
    schema_version: int,
) -> None:
    verified = PrivateBindingDocumentMonitorVerifier(policy(schema_version=schema_version)).verify(
        "sheet",
        "synthetic-file-id",
        "manage.query_file_info",
        {"file_id": "synthetic-file-id"},
        "private-policy",
    )

    assert verified.resource_key_sha256 == payload_sha256("synthetic-file-id")


def test_hash_only_private_document_policy_is_supported() -> None:
    binding = policy()
    monitor = binding["tencentDocs"]["monitors"][0]
    monitor["resource_key_sha256"] = payload_sha256(monitor.pop("resource_key"))
    monitor["poll_arguments_sha256"] = payload_sha256(monitor.pop("poll_arguments"))

    verified = PrivateBindingDocumentMonitorVerifier(binding).verify(
        "sheet",
        "synthetic-file-id",
        "manage.query_file_info",
        {"file_id": "synthetic-file-id"},
        "private-policy",
    )

    assert verified.poll_arguments_sha256 == payload_sha256({"file_id": "synthetic-file-id"})


def test_private_document_policy_rejects_changed_poll_arguments() -> None:
    verifier = PrivateBindingDocumentMonitorVerifier(policy())

    with pytest.raises(DocumentMonitorPolicyError) as raised:
        verifier.verify(
            "sheet",
            "synthetic-file-id",
            "manage.query_file_info",
            {"file_id": "different-file-id"},
            "private-policy",
        )

    assert raised.value.code == "UNVERIFIED"


def test_private_document_policy_rejects_duplicate_policy_refs() -> None:
    binding = policy()
    binding["tencentDocs"]["monitors"].append(
        dict(binding["tencentDocs"]["monitors"][0])
    )

    with pytest.raises(DocumentMonitorPolicyError) as raised:
        PrivateBindingDocumentMonitorVerifier(binding).verify(
            "sheet",
            "synthetic-file-id",
            "manage.query_file_info",
            {"file_id": "synthetic-file-id"},
            "private-policy",
        )

    assert raised.value.code == "AMBIGUOUS"

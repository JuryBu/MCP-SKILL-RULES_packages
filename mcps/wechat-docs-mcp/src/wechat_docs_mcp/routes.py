from __future__ import annotations

from typing import Any


def evaluate_route_enrollment(binding: dict[str, Any], observations: list[dict[str, Any]]) -> dict[str, Any]:
    exact = [
        item
        for item in observations
        if item.get("chat_name") == binding.get("exact_title")
        and item.get("chat_type") == binding.get("expected_chat_type")
    ]
    if len(exact) != 1:
        return {"state": "quarantine", "reason": "AMBIGUOUS_EXACT_TITLE", "match_count": len(exact)}
    observed = exact[0]
    expected_count = binding.get("expected_member_count")
    if expected_count is not None and observed.get("group_member_count") != expected_count:
        return {"state": "quarantine", "reason": "MEMBER_COUNT_MISMATCH"}
    expected_fingerprint = binding.get("member_fingerprint_sha256")
    if expected_fingerprint and observed.get("member_fingerprint_sha256") != expected_fingerprint:
        return {"state": "quarantine", "reason": "MEMBER_FINGERPRINT_MISMATCH"}
    return {"state": "active", "observation": observed}

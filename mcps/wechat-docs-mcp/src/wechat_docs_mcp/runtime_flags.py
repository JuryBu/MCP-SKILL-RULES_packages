from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path


_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"", "0", "false", "no", "off"}


def resolve_private_runtime_flag(
    data_root: Path,
    config_key: str,
    environment_key: str,
    *,
    environ: Mapping[str, str] | None = None,
) -> bool:
    values = os.environ if environ is None else environ
    if environment_key in values:
        normalized = values[environment_key].strip().lower()
        if normalized in _TRUE_VALUES:
            return True
        if normalized in _FALSE_VALUES:
            return False
        return False

    runtime_path = data_root / "config" / "service-runtime.json"
    try:
        document = json.loads(runtime_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(document, dict):
        return False
    value = document.get(config_key)
    return value if isinstance(value, bool) else False


def resolve_private_runtime_gate(data_root: Path, config_key: str) -> bool:
    runtime_path = data_root / "config" / "service-runtime.json"
    try:
        document = json.loads(runtime_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(document, dict):
        return False
    value = document.get(config_key)
    return value if isinstance(value, bool) else False


def resolve_private_runtime_environment_value(
    data_root: Path,
    environment_key: str,
    default: str,
    *,
    environ: Mapping[str, str] | None = None,
) -> object:
    values = os.environ if environ is None else environ
    runtime_path = data_root / "config" / "service-runtime.json"
    try:
        document = json.loads(runtime_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return values.get(environment_key, default)
    if isinstance(document, dict):
        runtime_environment = document.get("environment")
        if isinstance(runtime_environment, dict) and environment_key in runtime_environment:
            return runtime_environment[environment_key]
    return values.get(environment_key, default)

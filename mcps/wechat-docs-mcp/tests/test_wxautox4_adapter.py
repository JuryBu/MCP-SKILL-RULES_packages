from __future__ import annotations

import subprocess
from types import SimpleNamespace

from wechat_docs_mcp.wxautox4_adapter import WxAutoAdapter


def test_wxautox4_subprocess_is_created_without_a_console_window(tmp_path, monkeypatch) -> None:
    executable = tmp_path / "wxautox4.exe"
    executable.write_bytes(b"synthetic")
    captured: dict[str, object] = {}
    no_window_flag = 0x08000000
    monkeypatch.setattr(subprocess, "CREATE_NO_WINDOW", no_window_flag, raising=False)

    def fake_run(arguments: list[str], **kwargs: object) -> SimpleNamespace:
        captured["arguments"] = arguments
        captured.update(kwargs)
        return SimpleNamespace(returncode=0, stdout="{}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    adapter = WxAutoAdapter(executable, tmp_path / "wxautox4.lock")

    assert adapter.run_json(["status", "--json"]) == {}
    assert captured["creationflags"] == no_window_flag

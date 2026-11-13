import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

output = Path(tempfile.gettempdir()) / "sandbox-cmd-metrics-20261113"
receipt = output / "actual-metrics.json"
if "--child" in sys.argv:
    completed = subprocess.run([str(output / "text-metrics-test.exe"), str(receipt)], capture_output=True, timeout=15)
    (output / "native-test-stderr.txt").write_bytes(completed.stderr)
    raise SystemExit(completed.returncode)
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0
subprocess.run([str(Path(os.environ["WINDIR"]) / "System32" / "conhost.exe"), sys.executable,
                str(Path(__file__).resolve()), "--child"], startupinfo=startup,
               creationflags=subprocess.CREATE_NEW_CONSOLE, check=True, timeout=20)
deadline = time.monotonic() + 3
while not receipt.exists() and time.monotonic() < deadline:
    time.sleep(0.05)
result = json.loads(receipt.read_text(encoding="utf-8-sig"))
print(json.dumps(result, ensure_ascii=True))
assert result["passed"], result

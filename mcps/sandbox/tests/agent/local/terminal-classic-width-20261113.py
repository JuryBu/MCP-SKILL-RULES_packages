import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


class Coord(ctypes.Structure):
    _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short)]


class Rect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_short), ("top", ctypes.c_short),
                ("right", ctypes.c_short), ("bottom", ctypes.c_short)]


class BufferInfo(ctypes.Structure):
    _fields_ = [("size", Coord), ("cursor", Coord), ("attributes", wintypes.WORD),
                ("window", Rect), ("maximum", Coord)]


class FontInfo(ctypes.Structure):
    _fields_ = [("size", wintypes.ULONG), ("index", wintypes.DWORD), ("cell", Coord),
                ("family", wintypes.UINT), ("weight", wintypes.UINT), ("face", wintypes.WCHAR * 32)]


class CharacterInfo(ctypes.Structure):
    _fields_ = [("character", wintypes.WCHAR), ("attributes", wintypes.WORD)]


def checked(success):
    if not success:
        raise ctypes.WinError(ctypes.get_last_error())


def measure():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    user = ctypes.WinDLL("user32", use_last_error=True)
    signatures = {
        "CreateFileW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                         wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE], wintypes.HANDLE),
        "CreateConsoleScreenBuffer": ([wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                       wintypes.DWORD, ctypes.c_void_p], wintypes.HANDLE),
        "GetConsoleWindow": ([], wintypes.HWND),
        "GetConsoleOutputCP": ([], wintypes.UINT),
        "SetConsoleOutputCP": ([wintypes.UINT], wintypes.BOOL),
        "GetConsoleScreenBufferInfo": ([wintypes.HANDLE, ctypes.POINTER(BufferInfo)], wintypes.BOOL),
        "SetConsoleCursorPosition": ([wintypes.HANDLE, Coord], wintypes.BOOL),
        "WriteConsoleW": ([wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD,
                           ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        "GetCurrentConsoleFontEx": ([wintypes.HANDLE, wintypes.BOOL, ctypes.POINTER(FontInfo)], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        "SetConsoleMode": ([wintypes.HANDLE, wintypes.DWORD], wintypes.BOOL),
        "SetConsoleWindowInfo": ([wintypes.HANDLE, wintypes.BOOL, ctypes.POINTER(Rect)], wintypes.BOOL),
        "SetConsoleScreenBufferSize": ([wintypes.HANDLE, Coord], wintypes.BOOL),
        "ReadConsoleOutputW": ([wintypes.HANDLE, ctypes.POINTER(CharacterInfo), Coord, Coord,
                                ctypes.POINTER(Rect)], wintypes.BOOL),
    }
    for name, signature in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = signature
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    window = kernel.GetConsoleWindow()
    if window and user.IsWindowVisible(window):
        raise RuntimeError("Probe console must stay invisible")
    output = kernel.CreateFileW("CONOUT$", 0xC0000000, 3, None, 3, 0, None)
    if output == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        font = FontInfo()
        font.size = ctypes.sizeof(FontInfo)
        checked(kernel.GetCurrentConsoleFontEx(output, False, ctypes.byref(font)))
        initial_cp = kernel.GetConsoleOutputCP()
        result = {"pid": os.getpid(), "visible": False, "font": font.face,
                  "cell": [font.cell.x, font.cell.y], "initialCodePage": initial_cp, "measurements": []}
        for code_page in dict.fromkeys([initial_cp, 65001, 936]):
            checked(kernel.SetConsoleOutputCP(code_page))
            widths = {}
            for character in "A中×÷…→·─╭▏éΩ≤￥":
                checked(kernel.SetConsoleCursorPosition(output, Coord(0, 0)))
                written = wintypes.DWORD()
                checked(kernel.WriteConsoleW(output, character, len(character), ctypes.byref(written), None))
                info = BufferInfo()
                checked(kernel.GetConsoleScreenBufferInfo(output, ctypes.byref(info)))
                widths[character] = info.cursor.x
            result["measurements"].append({"codePage": code_page, "widths": widths})
        inactive = kernel.CreateConsoleScreenBuffer(0xC0000000, 3, None, 1, None)
        if inactive == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            inactive_widths = {}
            for character in widths:
                checked(kernel.SetConsoleCursorPosition(inactive, Coord(0, 0)))
                written = wintypes.DWORD()
                checked(kernel.WriteConsoleW(inactive, character, len(character), ctypes.byref(written), None))
                info = BufferInfo()
                checked(kernel.GetConsoleScreenBufferInfo(inactive, ctypes.byref(info)))
                inactive_widths[character] = info.cursor.x
            result["inactiveBufferMatches"] = inactive_widths == widths
            assert result["inactiveBufferMatches"], inactive_widths
        finally:
            kernel.CloseHandle(inactive)
        environment = dict(os.environ, CMD_WIDTH_METRICS_JSON=json.dumps(widths, ensure_ascii=True))
        fixture = Path(__file__).with_name("terminal-classic-wrap-20261113.mjs")
        payload = json.loads(subprocess.check_output(["node", "--import", "tsx", str(fixture), "--payload"],
                                                    env=environment, encoding="utf-8"))
        checked(kernel.SetConsoleCursorPosition(output, Coord(0, 0)))
        checked(kernel.SetConsoleWindowInfo(output, True, ctypes.byref(Rect(0, 0, 79, 24))))
        checked(kernel.SetConsoleScreenBufferSize(output, Coord(100, 100)))
        checked(kernel.SetConsoleWindowInfo(output, True, ctypes.byref(Rect(0, 0, 99, 33))))
        checked(kernel.SetConsoleMode(output, 7))
        result["replay"] = {}
        for name in ["baseline", "candidate"]:
            frame = payload[name]
            written = wintypes.DWORD()
            checked(kernel.WriteConsoleW(output, frame, len(frame), ctypes.byref(written), None))
            cells = (CharacterInfo * (100 * 34))()
            region = Rect(0, 0, 99, 33)
            checked(kernel.ReadConsoleOutputW(output, cells, Coord(100, 34), Coord(0, 0), ctypes.byref(region)))
            rows = []
            expected = payload["baselineLines" if name == "baseline" else "lines"]
            for index in range(len(expected)):
                row = payload["detailRow"] + index
                rows.append("".join(cells[row * 100 + column].character for column in range(37, 100)
                                    if not cells[row * 100 + column].attributes & 0x200).rstrip())
            result["replay"][name] = {"expected": expected, "actual": rows, "matches": rows == expected}
        assert result["replay"]["candidate"]["matches"], result["replay"]["candidate"]
        result["replay"]["originalMarkdownPreserved"] = True
        frame = payload["release"]
        written = wintypes.DWORD()
        checked(kernel.WriteConsoleW(output, frame, len(frame), ctypes.byref(written), None))
        cells = (CharacterInfo * (100 * 34))()
        checked(kernel.ReadConsoleOutputW(output, cells, Coord(100, 34), Coord(0, 0), ctypes.byref(Rect(0, 0, 99, 33))))
        result["exit"] = {"viewportBlank": all(cell.character == " " for cell in cells),
                          "uniformAttributes": len({cell.attributes for cell in cells}) == 1}
        assert result["exit"]["viewportBlank"] and result["exit"]["uniformAttributes"], result["exit"]
        checked(kernel.SetConsoleCursorPosition(output, Coord(0, 0)))
        history = "SHELL-HISTORY-PRESERVED"
        checked(kernel.WriteConsoleW(output, history, len(history), ctypes.byref(written), None))
        checked(kernel.SetConsoleCursorPosition(output, Coord(0, 40)))
        checked(kernel.SetConsoleWindowInfo(output, True, ctypes.byref(Rect(0, 40, 99, 73))))
        checked(kernel.WriteConsoleW(output, payload["candidate"], len(payload["candidate"]), ctypes.byref(written), None))
        checked(kernel.WriteConsoleW(output, payload["release"], len(payload["release"]), ctypes.byref(written), None))
        region = Rect(0, 40, 99, 73)
        checked(kernel.ReadConsoleOutputW(output, cells, Coord(100, 34), Coord(0, 0), ctypes.byref(region)))
        history_cells = (CharacterInfo * 100)()
        checked(kernel.ReadConsoleOutputW(output, history_cells, Coord(100, 1), Coord(0, 0), ctypes.byref(Rect(0, 0, 99, 0))))
        info = BufferInfo()
        checked(kernel.GetConsoleScreenBufferInfo(output, ctypes.byref(info)))
        result["scrolledExit"] = {"viewportTop": info.window.top, "cursor": [info.cursor.x, info.cursor.y],
                                  "viewportBlank": all(cell.character == " " for cell in cells),
                                  "historyPreserved": "".join(cell.character for cell in history_cells).startswith(history)}
        assert result["scrolledExit"]["viewportBlank"] and result["scrolledExit"]["historyPreserved"]
        assert info.window.top == 40 and info.cursor.y == 40, result["scrolledExit"]
        return result
    finally:
        kernel.CloseHandle(output)


if __name__ == "__main__":
    if os.name != "nt":
        raise SystemExit("Windows console required")
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        Path(sys.argv[2]).write_text(json.dumps(measure(), ensure_ascii=True, indent=2), encoding="utf-8")
    else:
        with tempfile.TemporaryDirectory(prefix="sandbox-cmd-width-") as temporary:
            result_path = Path(temporary) / "widths.json"
            command = [sys.executable, str(Path(__file__).resolve()), "--child", str(result_path)]
            startup = None
            flags = subprocess.CREATE_NO_WINDOW
            if "--classic" in sys.argv:
                command.insert(0, str(Path(os.environ["SystemRoot"]) / "System32" / "conhost.exe"))
                startup = subprocess.STARTUPINFO()
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = 0
                flags = subprocess.CREATE_NEW_CONSOLE
            subprocess.run(command, creationflags=flags, startupinfo=startup, check=True, timeout=15)
            result = json.loads(result_path.read_text(encoding="utf-8"))
            print(json.dumps(result, ensure_ascii=True, indent=2))

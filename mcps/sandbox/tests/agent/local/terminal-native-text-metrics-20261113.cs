using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class NativeTextMetricsTest
{
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Info { public Coord Size, Cursor; public ushort Attributes; public Rect Window; public Coord Maximum; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out Info info);
    [DllImport("kernel32.dll")] static extern bool SetConsoleWindowInfo(IntPtr output, bool absolute, ref Rect rectangle);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static int Main(string[] arguments)
    {
        try {
        if (IsWindowVisible(GetConsoleWindow())) throw new Exception("Test must remain hidden");
        IntPtr console = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        try {
            Info before, after; GetConsoleScreenBufferInfo(console, out before);
            using (var metrics = new AgentGraphics.TextMeasurer(console)) {
                if (!metrics.Update("×÷…→·─╭▏éΩ≤中e\u0301")) throw new Exception("No initial measurement");
                var widths = metrics.Widths;
                if (widths["×"] != 2 || widths["÷"] != 2 || widths["…"] != 2 || widths["→"] != 2 || widths["─"] != 1 || widths["é"] != 1 || widths["中"] != 2 || !widths.ContainsKey("e\u0301")) throw new Exception("Incorrect actual native widths: " + new JavaScriptSerializer().Serialize(widths));
                if (metrics.Update(null)) throw new Exception("Stable metrics should be cached");
                GetConsoleScreenBufferInfo(console, out after);
                bool cursorPreserved = before.Cursor.X == after.Cursor.X && before.Cursor.Y == after.Cursor.Y && before.Window.Top == after.Window.Top;
                if (!cursorPreserved) throw new Exception("Visible console changed during inactive-buffer measurement");
                var characters = new StringBuilder();
                for (int code = 0x3400; code < 0x4000; code++) characters.Append((char)code);
                metrics.Update(characters.ToString());
                bool bounded = metrics.Widths.Count <= 2048;
                if (!bounded) throw new Exception("Unbounded character cache");
                Rect window = after.Window; window.Bottom--;
                if (!SetConsoleWindowInfo(console, true, ref window) || !metrics.Update("×÷")) throw new Exception("Geometry did not refresh metrics");
                if (metrics.Widths.Count != 2) throw new Exception("Old font/geometry cache retained");
                File.WriteAllText(arguments[0], new JavaScriptSerializer().Serialize(new { passed = true, cursorPreserved = cursorPreserved, boundedCache = bounded, geometryRefreshed = true, widths = widths }), Encoding.UTF8);
            }
        } finally { CloseHandle(console); }
        return 0;
        } catch (Exception error) { File.WriteAllText(arguments[0], new JavaScriptSerializer().Serialize(new { passed = false, error = error.ToString() }), Encoding.UTF8); return 1; }
    }
}

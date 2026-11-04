using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class AgentGraphics
{
    [StructLayout(LayoutKind.Sequential)] internal struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct SmallRect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct BufferInfo { public Coord Size, Cursor; public ushort Attributes; public SmallRect Window; public Coord Maximum; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct FontInfo { public uint Size, Index; public Coord FontSize; public int Family, Weight; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Face; }
    [StructLayout(LayoutKind.Sequential)] internal struct SelectionInfo { public uint Flags; public Coord Anchor; public SmallRect Selection; }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct ProcessEntry { public uint Size, Usage, ProcessId; public IntPtr DefaultHeap; public uint ModuleId, Threads, ParentProcessId; public int BasePriority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint process);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out BufferInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool GetCurrentConsoleFontEx(IntPtr output, bool maximum, ref FontInfo info);
    [DllImport("kernel32.dll")] static extern bool GetConsoleSelectionInfo(out SelectionInfo info);
    [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int left, int top, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr window, bool enable);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window, IntPtr rectangle, IntPtr region, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 6 * 1024 * 1024 };
    static TextWriter Output;
    static void Emit(object value) { lock (Output) { Output.WriteLine(Json.Serialize(value)); Output.Flush(); } }

    sealed class Surface : Control
    {
        readonly IntPtr host;
        public Bitmap Frame;
        public Surface(IntPtr hostWindow) { host = hostWindow; Enabled = false; BackColor = Color.FromArgb(25, 24, 22); SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); }
        protected override CreateParams CreateParams { get { CreateParams parameters = base.CreateParams; parameters.Parent = host; parameters.Style = 0x40000000 | 0x08000000; parameters.ExStyle |= 0x08000000; return parameters; } }
        protected override void OnPaint(PaintEventArgs paint) { paint.Graphics.Clear(BackColor); if (Frame == null) return; double scale = Math.Min((double)ClientSize.Width / Frame.Width, (double)ClientSize.Height / Frame.Height); int width = Math.Max(1, (int)(Frame.Width * scale)); int height = Math.Max(1, (int)(Frame.Height * scale)); paint.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor; paint.Graphics.PixelOffsetMode = PixelOffsetMode.Half; paint.Graphics.DrawImage(Frame, new Rectangle((ClientSize.Width - width) / 2, (ClientSize.Height - height) / 2, width, height), 0, 0, Frame.Width, Frame.Height, GraphicsUnit.Pixel); }
        protected override void Dispose(bool disposing) { if (disposing && Frame != null) { Frame.Dispose(); Frame = null; } base.Dispose(disposing); }
    }

    static int Number(Dictionary<string, object> input, string key) { return Convert.ToInt32(input[key]); }
    static bool IsActualParent(int processId) { IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); if (snapshot == new IntPtr(-1)) return false; try { ProcessEntry entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) }; if (!Process32First(snapshot, ref entry)) return false; do { if (entry.ProcessId == (uint)Process.GetCurrentProcess().Id) return entry.ParentProcessId == (uint)processId; } while (Process32Next(snapshot, ref entry)); return false; } finally { CloseHandle(snapshot); } }
    [STAThread] static int Main(string[] arguments)
    {
        Output = Console.Out;
        TextReader input = Console.In;
        Surface surface = null;
        IntPtr console = new IntPtr(-1);
        System.Windows.Forms.Timer timer = null;
        IntPtr ownedHost = IntPtr.Zero;
        try
        {
            if (arguments.Length != 2 || arguments[0] != "--parent-pid") throw new ArgumentException("Expected --parent-pid PID");
            int parentId = int.Parse(arguments[1]);
            if (!IsActualParent(parentId)) throw new InvalidOperationException("Only the actual launching parent console is allowed");
            Process parent = Process.GetProcessById(parentId);
            long parentStarted = parent.StartTime.ToUniversalTime().Ticks;
            FreeConsole();
            if (!AttachConsole((uint)parentId)) throw new InvalidOperationException("Parent has no attachable console");
            uint[] clients = new uint[1024]; uint clientCount = GetConsoleProcessList(clients, (uint)clients.Length);
            if (clientCount > clients.Length || Array.IndexOf(clients, (uint)parentId) < 0) throw new InvalidOperationException("Parent console identity mismatch");
            IntPtr host = GetConsoleWindow();
            StringBuilder className = new StringBuilder(128); GetClassName(host, className, className.Capacity);
            if (host == IntPtr.Zero || !IsWindowVisible(host) || className.ToString() != "ConsoleWindowClass") throw new InvalidOperationException("Visible classic Conhost required; pseudoconsole uses terminal image protocol");
            ownedHost = host;
            SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(host));
            console = CreateFile("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (console == new IntPtr(-1)) throw new InvalidOperationException("Console geometry unavailable");
            surface = new Surface(host); surface.CreateControl(); IntPtr surfaceHandle = surface.Handle;
            EnableWindow(surfaceHandle, false);
            int column = 0, row = 0, columns = 0, rows = 0, anchorTop = -1, anchorLeft = -1;
            string previousGeometry = null, hiddenReason = null;
            bool closed = false;
            Action<string> hide = reason => { ShowWindow(surfaceHandle, 0); if (hiddenReason != reason) { hiddenReason = reason; RedrawWindow(host, IntPtr.Zero, IntPtr.Zero, 0x0105); Emit(new { type = "hidden", reason = reason }); } };
            Action refresh = () => {
                if (closed) return;
                if (parent.HasExited || parent.StartTime.ToUniversalTime().Ticks != parentStarted || !IsWindow(host)) { closed = true; Application.ExitThread(); return; }
                BufferInfo buffer; FontInfo font = new FontInfo { Size = (uint)Marshal.SizeOf(typeof(FontInfo)) }; Rect client; SelectionInfo selection;
                if (!IsWindowVisible(host) || !GetConsoleScreenBufferInfo(console, out buffer) || !GetCurrentConsoleFontEx(console, false, ref font) || !GetClientRect(host, out client)) { hide("geometry-unavailable"); return; }
                if (surface.Frame == null || columns < 1 || rows < 1) { hide("no-frame"); return; }
                if (GetConsoleSelectionInfo(out selection) && selection.Flags != 0) { hide("selection"); return; }
                if (buffer.Window.Top != anchorTop || buffer.Window.Left != anchorLeft) { hide("viewport-scrolled"); return; }
                int viewportColumns = buffer.Window.Right - buffer.Window.Left + 1, viewportRows = buffer.Window.Bottom - buffer.Window.Top + 1;
                int cellWidth = viewportColumns > 0 ? (int)Math.Round((double)client.Right / viewportColumns) : 0;
                int cellHeight = viewportRows > 0 ? client.Bottom / viewportRows : 0;
                int left = column * cellWidth, top = row * cellHeight, width = columns * cellWidth, height = rows * cellHeight;
                if (cellWidth < 1 || cellHeight < 1 || left < 0 || top < 0 || left + width > client.Right || top + height > client.Bottom) { hide("rectangle-outside-client"); return; }
                int cursorColumn = buffer.Cursor.X - buffer.Window.Left, cursorRow = buffer.Cursor.Y - buffer.Window.Top;
                if (cursorColumn >= column && cursorColumn < column + columns && cursorRow >= row && cursorRow < row + rows) { hide("cursor-inside-image"); return; }
                string geometry = left + "," + top + "," + width + "," + height;
                SetWindowPos(surfaceHandle, IntPtr.Zero, left, top, width, height, 0x0054);
                ShowWindow(surfaceHandle, 4); surface.Invalidate(); surface.Update(); hiddenReason = null;
                if (geometry != previousGeometry) { previousGeometry = geometry; Emit(new { type = "geometry", left = left, top = top, width = width, height = height, cellWidth = cellWidth, cellHeight = cellHeight, logicalFontWidth = font.FontSize.X, logicalFontHeight = font.FontSize.Y, clientWidth = client.Right, clientHeight = client.Bottom, viewportColumns = viewportColumns, viewportRows = viewportRows, viewportTop = buffer.Window.Top, viewportLeft = buffer.Window.Left }); }
            };
            Action<string> message = line => {
                try {
                    var command = Json.Deserialize<Dictionary<string, object>>(line);
                    string type = (string)command["type"];
                    if (type == "close") { closed = true; Application.ExitThread(); return; }
                    if (type == "hide") { columns = 0; hide("requested"); return; }
                    if (type != "frame") throw new ArgumentException("Unknown graphics message");
                    int width = Number(command, "width"), height = Number(command, "height");
                    int nextColumn = Number(command, "column"), nextRow = Number(command, "row"), nextColumns = Number(command, "columns"), nextRows = Number(command, "rows");
                    if (width < 1 || height < 1 || width > 1024 || height > 1024 || width * height > 1048576 || nextColumn < 0 || nextRow < 0 || nextColumns < 1 || nextRows < 1) throw new ArgumentException("Invalid frame dimensions or rectangle");
                    byte[] pixels = Convert.FromBase64String((string)command["pixels"]);
                    if (pixels.Length != width * height * 4) throw new ArgumentException("Invalid BGRA byte count");
                    Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                    BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                    try { Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); } finally { bitmap.UnlockBits(data); }
                    Bitmap previous = surface.Frame; surface.Frame = bitmap; if (previous != null) previous.Dispose();
                    column = nextColumn; row = nextRow; columns = nextColumns; rows = nextRows;
                    BufferInfo buffer; if (!GetConsoleScreenBufferInfo(console, out buffer)) throw new InvalidOperationException("Console viewport unavailable");
                    if (anchorTop < 0 || (command.ContainsKey("reanchor") && Convert.ToBoolean(command["reanchor"]))) { anchorTop = buffer.Window.Top; anchorLeft = buffer.Window.Left; }
                    refresh();
                    Emit(new { type = "frame", width = width, height = height });
                } catch (Exception error) { hide("invalid-message"); Emit(new { type = "error", message = error.Message }); }
            };
            timer = new System.Windows.Forms.Timer { Interval = 60 }; timer.Tick += (sender, eventArgs) => refresh(); timer.Start();
            Thread reader = new Thread(() => { try { string line; while ((line = input.ReadLine()) != null) { if (line.Length > 6 * 1024 * 1024) break; string captured = line; surface.BeginInvoke(new Action(() => message(captured))); } } catch (Exception) { } finally { try { surface.BeginInvoke(new Action(() => Application.ExitThread())); } catch (Exception) { } } }); reader.IsBackground = true; reader.Start();
            Emit(new { type = "ready", hostHwnd = host.ToInt64(), surfaceHwnd = surfaceHandle.ToInt64(), parentPid = parentId, helperPid = Process.GetCurrentProcess().Id, hostClass = className.ToString(), inputDisabled = true });
            Application.Run();
            return 0;
        }
        catch (Exception error) { Emit(new { type = "unavailable", message = error.Message }); return 2; }
        finally { if (timer != null) timer.Dispose(); if (surface != null) surface.Dispose(); if (ownedHost != IntPtr.Zero && IsWindow(ownedHost)) RedrawWindow(ownedHost, IntPtr.Zero, IntPtr.Zero, 0x0105); if (console != new IntPtr(-1)) CloseHandle(console); FreeConsole(); Emit(new { type = "closed" }); }
    }
}

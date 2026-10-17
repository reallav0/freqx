// Windows input helper. Only the configured PTT key is observed; no keystrokes are logged.
// Parent EOF, heartbeat expiry, focus loss, and physical takeover release synthetic ownership.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class AutoPushToTalk {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputData { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputData data; }
    [StructLayout(LayoutKind.Sequential)] struct KeyHookData { public uint key, scan, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHookData { public Point point; public uint data, flags, time; public UIntPtr extra; }
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    delegate void WinEventProc(IntPtr hook, uint type, IntPtr window, int objectId, int child, uint thread, uint time);
    delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint milliseconds, IntPtr callback);
    [DllImport("user32.dll")] static extern bool KillTimer(IntPtr window, UIntPtr id);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192 };
    static readonly Queue<string> commands = new Queue<string>();
    static readonly UIntPtr marker = new UIntPtr(0x46585054);
    static readonly HookProc keyCallback = KeyboardEvent, mouseCallback = MouseEvent;
    static readonly WinEventProc focusCallback = FocusChanged;
    static IntPtr inputHook, focusHook;
    static UIntPtr timer;
    static int key;
    static uint parentId;
    static string target;
    static bool active, synthetic, physical, closing;
    static uint mainThread;
    static long lastPing;
    static void Write(object value) {
        // Parent shutdown can close stdout before a blocked key-up succeeds.
        // Reporting must never interrupt native input cleanup.
        try { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
        catch (System.IO.IOException) { }
        catch (ObjectDisposedException) { }
    }
    static string ProcessName(IntPtr window) {
        uint id; GetWindowThreadProcessId(window, out id);
        if (id == 0 || id == parentId) return "";
        try { using (var process = Process.GetProcessById((int)id)) return process.ProcessName + ".exe"; } catch { return ""; }
    }
    static bool FocusMatches() {
        if (String.IsNullOrEmpty(target) || !String.Equals(ProcessName(GetForegroundWindow()), target, StringComparison.OrdinalIgnoreCase)) return false;
        if (key == 5 || key == 6) {
            Point point; if (!GetCursorPos(out point) || !String.Equals(ProcessName(WindowFromPoint(point)), target, StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }
    static int KeyCode(string code) {
        if (code != null && code.Length == 4 && code.StartsWith("Key") && code[3] >= 'A' && code[3] <= 'Z') return code[3];
        if (code != null && code.Length == 6 && code.StartsWith("Digit") && code[5] >= '0' && code[5] <= '9') return code[5];
        int f; if (code != null && code.StartsWith("F") && Int32.TryParse(code.Substring(1), out f) && f >= 1 && f <= 24) return 0x6F + f;
        if (code == "Space") return 0x20;
        if (code == "Mouse4") return 5;
        if (code == "Mouse5") return 6;
        throw new ArgumentException("Choose a letter, number, function key, Space, Mouse 4, or Mouse 5.");
    }
    static void Send(bool down) {
        var input = new Input();
        if (key == 5 || key == 6) {
            input.type = 0;
            input.data.mouse = new Mouse { data = key == 5 ? 1u : 2u, flags = down ? 0x0080u : 0x0100u, extra = marker };
        } else {
            input.type = 1;
            input.data.keyboard = new Keyboard { key = (ushort)key, flags = down ? 0u : 2u, extra = marker };
        }
        if (SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
            throw new InvalidOperationException("Windows blocked the talk key. Match Freqx's permission level to the selected app.");
    }
    static void RemoveHooks() {
        if (timer != UIntPtr.Zero) { KillTimer(IntPtr.Zero, timer); timer = UIntPtr.Zero; }
        if (inputHook != IntPtr.Zero) { UnhookWindowsHookEx(inputHook); inputHook = IntPtr.Zero; }
        if (focusHook != IntPtr.Zero) { UnhookWinEvent(focusHook); focusHook = IntPtr.Zero; }
    }
    static void Release() {
        active = false;
        if (synthetic && !physical) {
            try { Send(false); }
            catch {
                // Keep ownership and retry when Windows permits input again.
                // Losing this flag on a blocked key-up could leave a key stuck.
                if (timer == UIntPtr.Zero) timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 100, IntPtr.Zero);
                throw;
            }
        }
        synthetic = false; RemoveHooks();
    }
    static void Drop(string message) {
        try { Release(); Write(new { type = "state", status = "waiting", message = message }); }
        catch (Exception error) { Write(new { type = "state", status = "error", message = error.Message }); }
    }
    static void PhysicalEvent(bool down) {
        physical = down;
        // A real press takes ownership. Never send a synthetic up over the user's hold.
        if (active || synthetic) {
            synthetic = false; Drop("Talk key is under manual control. Auto PTT resumes on the next clip.");
            if (closing) PostThreadMessage(mainThread, 0x8002, UIntPtr.Zero, IntPtr.Zero);
        }
    }
    static IntPtr KeyboardEvent(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0 && (active || synthetic)) {
            var data = (KeyHookData)Marshal.PtrToStructure(lParam, typeof(KeyHookData));
            if (data.key == key && (data.flags & 0x10) == 0) {
                int type = wParam.ToInt32(); if (type == 0x100 || type == 0x104) PhysicalEvent(true);
                else if (type == 0x101 || type == 0x105) PhysicalEvent(false);
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    static IntPtr MouseEvent(int code, IntPtr wParam, IntPtr lParam) {
        if (code >= 0 && (active || synthetic)) {
            var data = (MouseHookData)Marshal.PtrToStructure(lParam, typeof(MouseHookData));
            if ((data.flags & 1) == 0 && (data.data >> 16) == (key == 5 ? 1u : 2u)) {
                if (wParam.ToInt32() == 0x20B) PhysicalEvent(true);
                else if (wParam.ToInt32() == 0x20C) PhysicalEvent(false);
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }
    static void FocusChanged(IntPtr hook, uint type, IntPtr window, int objectId, int child, uint thread, uint time) {
        if (active && !FocusMatches()) Drop("Waiting for the selected app. Start another clip when it is focused.");
    }
    static bool Hold(string code, string process) {
        Release(); key = KeyCode(code); target = process;
        if (String.IsNullOrEmpty(target) || target.Length > 128 || target.IndexOfAny(new char[] { '/', '\\', ':', '\n', '\r' }) >= 0 || !target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Choose a target app.");
        if (!FocusMatches()) return false;
        inputHook = SetWindowsHookEx(key == 5 || key == 6 ? 14 : 13, key == 5 || key == 6 ? mouseCallback : keyCallback, GetModuleHandle(null), 0);
        focusHook = SetWinEventHook(3, 3, IntPtr.Zero, focusCallback, 0, 0, 0);
        if (inputHook == IntPtr.Zero || focusHook == IntPtr.Zero) { RemoveHooks(); throw new InvalidOperationException("Windows input monitoring could not start."); }
        physical = (GetAsyncKeyState(key) & 0x8000) != 0;
        active = true; lastPing = Environment.TickCount;
        if (!FocusMatches()) { Release(); return false; }
        try {
            if (!physical) { Send(true); synthetic = true; }
            timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 100, IntPtr.Zero);
            if (timer == UIntPtr.Zero) throw new InvalidOperationException("Talk-key watchdog could not start.");
        } catch { Release(); throw; }
        return true;
    }
    static void ListApps() {
        var apps = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window)) return true;
            var title = new StringBuilder(256); GetWindowText(window, title, title.Capacity);
            string name = ProcessName(window);
            if (title.Length > 0 && name.Length > 0 && apps.Count < 256 && !apps.ContainsKey(name)) apps.Add(name, title.ToString());
            return true;
        }, IntPtr.Zero);
        var result = new List<object>(); foreach (var item in apps) result.Add(new { processName = item.Key, title = item.Value });
        Write(new { apps = result });
    }
    static void Command(string line) {
        string id = "";
        try {
            var command = json.Deserialize<Dictionary<string, object>>(line);
            if (command.ContainsKey("id")) id = Convert.ToString(command["id"]);
            string type = Convert.ToString(command["type"]);
            if (type == "ping") { lastPing = Environment.TickCount; return; }
            bool held = false;
            if (type == "hold") held = Hold(Convert.ToString(command["key"]), Convert.ToString(command["targetProcess"]));
            else if (type == "release") Release();
            else throw new ArgumentException("Unknown PTT command.");
            Write(new { type = "reply", id = id, ok = true, holding = held });
        } catch (Exception error) {
            try { Release(); } catch { }
            Write(new { type = "reply", id = id, ok = false, error = error.Message });
        }
    }
    static int Main(string[] arguments) {
        try {
            Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
            if (arguments.Length != 2 || !UInt32.TryParse(arguments[1], out parentId)) throw new ArgumentException("A parent process is required.");
            if (arguments[0] == "--list") { ListApps(); return 0; }
            if (arguments[0] != "--session") throw new ArgumentException("Unknown mode.");
            uint threadId = mainThread = GetCurrentThreadId(); Message message; PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
            var reader = new Thread(delegate() {
                try { string line; while ((line = Console.ReadLine()) != null) {
                    if (line.Length > 4096) break;
                    lock (commands) { if (commands.Count >= 256) break; commands.Enqueue(line); }
                    PostThreadMessage(threadId, 0x8001, UIntPtr.Zero, IntPtr.Zero);
                } } catch { }
                PostThreadMessage(threadId, 0x8002, UIntPtr.Zero, IntPtr.Zero);
            });
            reader.IsBackground = true; reader.Start(); Write(new { type = "ready" });
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
                if (message.message == 0x8002) {
                    closing = true;
                    try { Release(); } catch (Exception error) { Write(new { type = "state", status = "error", message = error.Message }); }
                    if (!synthetic) break;
                } else if (message.message == 0x8001 && !closing) {
                    while (true) { string line; lock (commands) { if (commands.Count == 0) break; line = commands.Dequeue(); } Command(line); }
                } else if (message.message == 0x0113) {
                    if (!active && synthetic) {
                        try { Release(); } catch { }
                        if (closing && !synthetic) break;
                    } else if (active) {
                        if (unchecked((uint)(Environment.TickCount - (int)lastPing)) > 3000) Drop("Playback stopped responding; the talk key was released.");
                        else if (!FocusMatches()) Drop("Waiting for the selected app.");
                    }
                }
            }
            Release(); return 0;
        } catch (Exception error) { try { Release(); } catch { } Console.Error.WriteLine(error.Message); return 1; }
    }
}

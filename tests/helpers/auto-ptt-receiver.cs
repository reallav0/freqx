// Isolated input receiver for PTT integration checks. Never sends input outside its own window.
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
class Receiver : Form {
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Union data; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
    static JavaScriptSerializer json = new JavaScriptSerializer();
    static Receiver form;
    static IntPtr previous;
    static bool externalDown;
    static Point previousPointer, testPointer;
    static bool pointerMoved;
    static void FocusReceiver() {
        uint process; uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out process), current = GetCurrentThreadId();
        bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
        try { form.Show(); ShowWindow(form.Handle, 9); form.Activate(); SetForegroundWindow(form.Handle); }
        finally { if (attached) AttachThreadInput(current, foreground, false); }
    }
    static void Write(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
    protected override void WndProc(ref Message message) {
        if ((message.Msg == 0x100 || message.Msg == 0x101) && message.WParam.ToInt32() == 135)
            Write(new { type = "key", down = message.Msg == 0x100 });
        base.WndProc(ref message);
    }
    class MouseFilter : IMessageFilter {
        public bool PreFilterMessage(ref Message message) {
            if ((message.Msg == 0x20B || message.Msg == 0x20C) && ((message.WParam.ToInt64() >> 16) & 0xffff) == 1)
                Write(new { type = "mouse", down = message.Msg == 0x20B });
            return false;
        }
    }
    static void InputKey(bool down) {
        if (GetForegroundWindow() != form.Handle && down) return;
        var input = new Input { type = 1, data = new Union { keyboard = new Keyboard { key = 135, flags = down ? 0u : 2u } } };
        SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))); externalDown = down;
    }
    [STAThread] static void Main() {
        previous = GetForegroundWindow();
        Application.AddMessageFilter(new MouseFilter());
        form = new Receiver { Text = "Freqx automatic push-to-talk test", Width = 460, Height = 150, KeyPreview = true };
        form.Controls.Add(new Label { Text = "Isolated Freqx input test. No audio devices are opened.", Dock = DockStyle.Fill, TextAlign = System.Drawing.ContentAlignment.MiddleCenter });
        form.Shown += delegate {
            ShowWindow(form.Handle, 5); FocusReceiver(); Write(new { type = "ready", handle = form.Handle.ToInt64() });
            var reader = new Thread(delegate() {
                string command; while ((command = Console.ReadLine()) != null) {
                    string value = command;
                    form.BeginInvoke((Action)delegate {
                        if (value == "focus") { FocusReceiver(); Write(new { type = "focus", focused = GetForegroundWindow() == form.Handle }); }
                        else if (value == "hide") { form.Hide(); Write(new { type = "hidden" }); }
                        else if (value == "down") InputKey(true);
                        else if (value == "up") InputKey(false);
                        else if (value == "pointer") {
                            GetCursorPos(out previousPointer); Rect rect; GetWindowRect(form.Handle, out rect);
                            testPointer = new Point { x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2 };
                            SetCursorPos(testPointer.x, testPointer.y); pointerMoved = true; Write(new { type = "pointer" });
                        }
                        else if (value == "state") Write(new { type = "state", down = (GetAsyncKeyState(135) & 0x8000) != 0, focused = GetForegroundWindow() == form.Handle });
                        else if (value == "close") form.Close();
                    });
                }
                if (!form.IsDisposed) form.BeginInvoke((Action)delegate { form.Close(); });
            }); reader.IsBackground = true; reader.Start();
        };
        form.FormClosing += delegate {
            if (externalDown) InputKey(false);
            Point current; GetCursorPos(out current);
            if (pointerMoved && current.x == testPointer.x && current.y == testPointer.y) SetCursorPos(previousPointer.x, previousPointer.y);
            if (GetForegroundWindow() == form.Handle) SetForegroundWindow(previous);
        };
        Application.Run(form);
    }
}

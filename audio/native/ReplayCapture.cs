// Independent stereo WASAPI capture for Instant Replay. No microphone or playback.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

namespace FreqxReplayNative {
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevices {
    void EnumAudioEndpoints(int flow, uint mask, out ICollection devices);
    void GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICollection { void GetCount(out uint count); void Item(uint index, out IDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevice {
    void Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    void OpenPropertyStore(uint access, out IProperties store);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); void GetState(out uint state);
}
[StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
[StructLayout(LayoutKind.Explicit, Size = 24)] struct Variant {
    [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer;
    [FieldOffset(8)] public uint blobSize; [FieldOffset(16)] public IntPtr blob;
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IProperties { void GetCount(out uint count); void GetAt(uint index, out PropertyKey key); void GetValue(ref PropertyKey key, out Variant value); }
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IClient {
    void Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
    void GetBufferSize(out uint frames); void GetStreamLatency(out long latency); void GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
    void GetMixFormat(out IntPtr format); void GetDevicePeriod(out long period, out long minimum);
    void Start(); void Stop(); void Reset(); void SetEventHandle(IntPtr handle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICapture {
    void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong timestamp);
    void ReleaseBuffer(uint frames); void GetNextPacketSize(out uint frames);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISessions {
    void GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr control);
    void GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr volume);
    void GetSessionEnumerator(out ISessionList sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISessionList { void GetCount(out int count); void GetSession(int index, out ISession session); }
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISession {
    void GetState(out int state); void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetDisplayName(IntPtr name, IntPtr context); void GetIconPath(out IntPtr path); void SetIconPath(IntPtr path, IntPtr context);
    void GetGroupingParam(out Guid group); void SetGroupingParam(IntPtr group, IntPtr context);
    void RegisterAudioSessionNotification(IntPtr listener); void UnregisterAudioSessionNotification(IntPtr listener);
    void GetSessionIdentifier(out IntPtr id); void GetSessionInstanceIdentifier(out IntPtr id); void GetProcessId(out uint id);
}
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivation { void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object client); }
[ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICompleted { [PreserveSig] int ActivateCompleted(IActivation operation); }
[ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgile { }
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class Completion : ICompleted, IAgile {
    public ManualResetEvent done = new ManualResetEvent(false); public object client; public int result;
    public int ActivateCompleted(IActivation operation) {
        try { operation.GetActivateResult(out result, out client); }
        catch (Exception error) { result = Marshal.GetHRForException(error); }
        finally { done.Set(); } return 0;
    }
}
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct VersionInfo {
    public uint size, major, minor, build, platform;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string text;
}
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
    public uint size, usage, id; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
}
class Program {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
    [DllImport("ntdll.dll")] static extern int RtlGetVersion(ref VersionInfo version);
    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode)] static extern int ActivateAudioInterfaceAsync(string path, ref Guid iid, ref Variant parameters, ICompleted completed, out IActivation operation);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static volatile bool stopping;
    static string stage = "Audio device initialization";
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static bool ProcessCaptureSupported() { var version = new VersionInfo(); version.size = (uint)Marshal.SizeOf(version); return RtlGetVersion(ref version) == 0 && version.build >= 20348; }
    static string Label(IDevice device) {
        IProperties store = null;
        try { device.OpenPropertyStore(0, out store); var key = new PropertyKey { format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), id = 14 }; Variant value;
            store.GetValue(ref key, out value); try { return value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : "Playback device"; } finally { PropVariantClear(ref value); }
        } finally { Release(store); }
    }
    static Dictionary<uint, ProcessEntry> Processes() {
        var result = new Dictionary<uint, ProcessEntry>(); var handle = CreateToolhelp32Snapshot(2, 0);
        if (handle == new IntPtr(-1)) return result;
        try { var entry = new ProcessEntry(); entry.size = (uint)Marshal.SizeOf(entry);
            if (Process32First(handle, ref entry)) do { result[entry.id] = entry; } while (Process32Next(handle, ref entry));
        } finally { CloseHandle(handle); } return result;
    }
    static uint Root(uint id, Dictionary<uint, ProcessEntry> processes) {
        ProcessEntry entry, parent; int limit = 32;
        while (limit-- > 0 && processes.TryGetValue(id, out entry) && processes.TryGetValue(entry.parent, out parent)
            && entry.parent != id && String.Equals(entry.executable, parent.executable, StringComparison.OrdinalIgnoreCase)) id = entry.parent;
        return id;
    }
    static void List(IDevices enumerator) {
        ICollection devices = null; var sources = new List<object>(); var pids = new HashSet<uint>(); var processes = Processes(); bool supported = ProcessCaptureSupported();
        if (supported) sources.Add(new { kind = "desktop", id = "desktop", label = "Desktop audio (all apps)" });
        try {
            enumerator.EnumAudioEndpoints(0, 1, out devices); uint count; devices.GetCount(out count);
            for (uint index = 0; index < count; index++) {
                IDevice device = null; ISessions manager = null; ISessionList sessions = null;
                try {
                    devices.Item(index, out device); string id; device.GetId(out id);
                    sources.Add(new { kind = "device", id = id, label = Label(device) });
                    if (!supported) continue;
                    var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"); object instance; device.Activate(ref iid, 23, IntPtr.Zero, out instance);
                    manager = (ISessions)instance; manager.GetSessionEnumerator(out sessions); int size; sessions.GetCount(out size);
                    for (int item = 0; item < size; item++) {
                        ISession session = null;
                        try { sessions.GetSession(item, out session); uint pid; int state; session.GetState(out state); session.GetProcessId(out pid);
                            if (pid == 0 || state == 2) continue; pid = Root(pid, processes); if (!pids.Add(pid)) continue;
                            using (var process = Process.GetProcessById((int)pid)) {
                                string name = process.ProcessName; if (!String.IsNullOrWhiteSpace(process.MainWindowTitle)) name += " - " + process.MainWindowTitle;
                                sources.Add(new { kind = "application", id = pid.ToString(), label = name, processId = pid });
                            }
                        } catch (Exception) { } finally { Release(session); }
                    }
                } catch (COMException) { } finally { Release(sessions); Release(manager); Release(device); }
            }
        } finally { Release(devices); }
        Console.WriteLine(json.Serialize(new { processCaptureSupported = supported, sources = sources }));
    }
    static IClient ProcessClient(uint process, bool include) {
        if (!ProcessCaptureSupported()) throw new Exception("All-app and individual-app capture requires Windows build 20348 or later. Select a playback device instead.");
        IntPtr blob = Marshal.AllocHGlobal(12); IActivation operation = null; var completion = new Completion();
        Marshal.WriteInt32(blob, 0, 1); Marshal.WriteInt32(blob, 4, unchecked((int)process)); Marshal.WriteInt32(blob, 8, include ? 0 : 1);
        var parameters = new Variant { type = 65, blobSize = 12, blob = blob }; var iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        try {
            stage = "Application audio activation";
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref parameters, completion, out operation));
            if (!completion.done.WaitOne(6000)) throw new Exception("Application audio capture startup timed out.");
            stage = "Application audio activation result";
            Marshal.ThrowExceptionForHR(completion.result); return (IClient)completion.client;
        } finally { if (completion.done.WaitOne(0)) { Marshal.FreeHGlobal(blob); completion.done.Dispose(); Release(operation); } GC.KeepAlive(completion); }
    }
    static void Capture(IDevices enumerator, string kind, string id) {
        IDevice device = null; IClient client = null; ICapture capture = null; IntPtr format = Marshal.AllocHGlobal(18); bool started = false;
        using (var ready = new EventWaitHandle(false, EventResetMode.AutoReset)) try {
            if (kind == "device") { enumerator.GetDevice(id, out device); var iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"); object instance; device.Activate(ref iid, 23, IntPtr.Zero, out instance); client = (IClient)instance; }
            else { uint pid; if (kind == "desktop") pid = (uint)Process.GetCurrentProcess().Id; else if (kind != "application" || !UInt32.TryParse(id, out pid) || pid == 0) throw new Exception("Invalid application source."); client = ProcessClient(pid, kind == "application"); }
            byte[] waveFormat = new byte[18]; Array.Copy(BitConverter.GetBytes((ushort)3), 0, waveFormat, 0, 2); Array.Copy(BitConverter.GetBytes((ushort)2), 0, waveFormat, 2, 2);
            Array.Copy(BitConverter.GetBytes(48000), 0, waveFormat, 4, 4); Array.Copy(BitConverter.GetBytes(384000), 0, waveFormat, 8, 4);
            Array.Copy(BitConverter.GetBytes((ushort)8), 0, waveFormat, 12, 2); Array.Copy(BitConverter.GetBytes((ushort)32), 0, waveFormat, 14, 2); Marshal.Copy(waveFormat, 0, format, 18);
            stage = "Stereo audio format initialization";
            client.Initialize(0, 0x88060000, 0, 0, format, IntPtr.Zero); client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
            var captureId = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"); object service; client.GetService(ref captureId, out service); capture = (ICapture)service;
            client.Start(); started = true;
            Console.Error.WriteLine(json.Serialize(new { type = "ready", sampleRate = 48000, channels = 2, id = id, kind = kind }));
            new Thread(() => { try { Console.ReadLine(); } catch { } stopping = true; }) { IsBackground = true }.Start();
            var writer = new BinaryWriter(Console.OpenStandardOutput()); var pcm = new float[960]; var bytes = new byte[3840]; var packet = new float[48000]; int accumulated = 0; var heartbeat = Stopwatch.StartNew();
            while (!stopping) {
                if (heartbeat.ElapsedMilliseconds >= 1000) { Console.Error.WriteLine("{\"type\":\"heartbeat\"}"); heartbeat.Restart(); }
                ready.WaitOne(10); uint available; capture.GetNextPacketSize(out available);
                while (available > 0 && !stopping) {
                    IntPtr data; uint frames, flags; ulong position, timestamp; capture.GetBuffer(out data, out frames, out flags, out position, out timestamp);
                    try {
                        int size = checked((int)frames * 2); if (size > packet.Length) throw new Exception("Unexpected audio capture packet size.");
                        if ((flags & 2) == 0) Marshal.Copy(data, packet, 0, size);
                        if ((flags & 1) != 0) { accumulated = 0; writer.Write((uint)0); writer.Flush(); }
                        for (int sample = 0; sample < size; sample++) {
                            float value = (flags & 2) != 0 ? 0 : packet[sample]; pcm[accumulated++] = float.IsNaN(value) || float.IsInfinity(value) ? 0 : Math.Max(-1f, Math.Min(1f, value));
                            if (accumulated == pcm.Length) { Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length); writer.Write((uint)bytes.Length); writer.Write(bytes); writer.Flush(); accumulated = 0; }
                        }
                    } finally { capture.ReleaseBuffer(frames); }
                    capture.GetNextPacketSize(out available);
                }
            }
        } finally { if (started) try { client.Stop(); } catch { } Marshal.FreeHGlobal(format); Release(capture); Release(client); Release(device); }
    }
    [MTAThread] static int Main(string[] args) {
        IDevices enumerator = null;
        try { enumerator = (IDevices)new Enumerator();
            if (args.Length == 1 && args[0] == "list") List(enumerator);
            else if (args.Length == 3 && args[0] == "capture") Capture(enumerator, args[1], args[2]);
            else throw new Exception("Usage: ReplayCapture list | capture <desktop|application|device> <id>"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(json.Serialize(new { type = "error", message = stage + ": " + error.Message })); return 1; }
        finally { Release(enumerator); }
    }
}
}

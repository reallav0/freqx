// Windows WASAPI render-endpoint loopback. No microphone access or playback.
// Build with the .NET Framework compiler; runtime is included in Windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDeviceEnumerator {
    void EnumAudioEndpoints(int flow, uint mask, out IDeviceCollection devices);
    void GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDeviceCollection { void GetCount(out uint count); void Item(uint index, out IDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevice {
    void Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    void OpenPropertyStore(uint access, out IPropertyStore store);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out uint state);
}
[StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
[StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { void GetCount(out uint count); void GetAt(uint index, out PropertyKey key); void GetValue(ref PropertyKey key, out PropVariant value); }
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
    void Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
    void GetMixFormat(out IntPtr format);
    void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    void Start(); void Stop(); void Reset(); void SetEventHandle(IntPtr handle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICaptureClient {
    void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong timestamp);
    void ReleaseBuffer(uint frames);
    void GetNextPacketSize(out uint frames);
}

class LoopbackCapture {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    static volatile bool stopping;
    static JavaScriptSerializer json = new JavaScriptSerializer();
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static string DeviceId(IDevice device) { string id; device.GetId(out id); return id; }
    static string Label(IDevice device) {
        IPropertyStore store = null;
        try {
            device.OpenPropertyStore(0, out store);
            var key = new PropertyKey { format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), id = 14 };
            PropVariant value;
            store.GetValue(ref key, out value);
            try { return value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : "Playback device"; }
            finally { PropVariantClear(ref value); }
        } finally { Release(store); }
    }
    static void List(IDeviceEnumerator enumerator) {
        IDeviceCollection devices = null;
        IDevice primary = null;
        IDevice communication = null;
        string defaultId = "", communicationsId = "";
        try {
            try { enumerator.GetDefaultAudioEndpoint(0, 1, out primary); defaultId = DeviceId(primary); } catch (COMException) { }
            try { enumerator.GetDefaultAudioEndpoint(0, 2, out communication); communicationsId = DeviceId(communication); } catch (COMException) { }
            enumerator.EnumAudioEndpoints(0, 1, out devices);
            uint count; devices.GetCount(out count);
            var result = new List<object>();
            for (uint index = 0; index < count; index++) {
                IDevice device = null;
                try {
                    devices.Item(index, out device);
                    string id = DeviceId(device);
                    result.Add(new { id = id, label = Label(device), isDefault = id == defaultId, isCommunications = id == communicationsId });
                } finally { Release(device); }
            }
            Console.WriteLine(json.Serialize(result));
        } finally { Release(devices); Release(primary); Release(communication); }
    }
    static void Capture(IDeviceEnumerator enumerator, string id) {
        IDevice device = null;
        IAudioClient client = null;
        ICaptureClient capture = null;
        IntPtr format = IntPtr.Zero;
        bool started = false;
        try {
            enumerator.GetDevice(id, out device);
            var iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            object instance; device.Activate(ref iid, 23, IntPtr.Zero, out instance);
            client = (IAudioClient)instance;
            client.GetMixFormat(out format);
            int tag = (ushort)Marshal.ReadInt16(format, 0);
            int channels = (ushort)Marshal.ReadInt16(format, 2);
            int rate = Marshal.ReadInt32(format, 4);
            int blockAlign = (ushort)Marshal.ReadInt16(format, 12);
            int bits = (ushort)Marshal.ReadInt16(format, 14);
            if (tag == 65534) tag = Marshal.ReadInt32(format, 24); // WAVEFORMATEXTENSIBLE SubFormat
            if (rate < 8000 || rate > 192000 || channels < 1 || channels > 16 ||
                !((tag == 3 && bits == 32) || (tag == 1 && (bits == 16 || bits == 24 || bits == 32)))) throw new Exception("Unsupported endpoint PCM format.");
            // Shared-mode loopback, 100 ms capacity, poll at 2 ms. No output is generated.
            client.Initialize(0, 0x20000, 1000000, 0, format, IntPtr.Zero);
            iid = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
            object service; client.GetService(ref iid, out service);
            capture = (ICaptureClient)service;
            string label = Label(device);
            client.Start(); started = true;
            Console.Error.WriteLine(json.Serialize(new { type = "ready", sampleRate = rate, channels = 1, id = id, label = label }));
            new Thread(() => { try { Console.ReadLine(); } catch { } stopping = true; }) { IsBackground = true }.Start();
            var output = Console.OpenStandardOutput();
            var writer = new BinaryWriter(output);
            int frameSize = rate / 100;
            var pcm = new float[frameSize];
            var bytes = new byte[frameSize * 4];
            int accumulated = 0;
            var heartbeat = Stopwatch.StartNew();
            byte[] packet = new byte[rate / 10 * blockAlign];
            while (!stopping) {
                if (heartbeat.ElapsedMilliseconds >= 1000) { Console.Error.WriteLine("{\"type\":\"heartbeat\"}"); heartbeat.Restart(); }
                uint available; capture.GetNextPacketSize(out available);
                if (available == 0) { Thread.Sleep(2); continue; }
                while (available > 0 && !stopping) {
                    IntPtr data; uint frames, flags; ulong position, timestamp;
                    capture.GetBuffer(out data, out frames, out flags, out position, out timestamp);
                    try {
                        int size = checked((int)frames * blockAlign);
                        if (size > packet.Length) throw new Exception("Unexpected WASAPI packet size.");
                        if ((flags & 2) == 0) Marshal.Copy(data, packet, 0, size);
                        // Discontinuity resets the browser reference queue.
                        if ((flags & 1) != 0) { accumulated = 0; writer.Write((uint)0); writer.Flush(); }
                        for (int frame = 0; frame < frames; frame++) {
                            float sample = 0;
                            if ((flags & 2) == 0) for (int channel = 0; channel < channels; channel++) {
                                int offset = frame * blockAlign + channel * (bits / 8);
                                float value;
                                if (tag == 3) value = BitConverter.ToSingle(packet, offset);
                                else if (bits == 16) value = BitConverter.ToInt16(packet, offset) / 32768f;
                                else if (bits == 32) value = BitConverter.ToInt32(packet, offset) / 2147483648f;
                                else { int n = packet[offset] | (packet[offset + 1] << 8) | (packet[offset + 2] << 16); value = ((n << 8) >> 8) / 8388608f; }
                                if (!float.IsNaN(value) && !float.IsInfinity(value)) sample += value / channels;
                            }
                            pcm[accumulated++] = Math.Max(-1f, Math.Min(1f, sample));
                            if (accumulated == frameSize) {
                                Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
                                writer.Write((uint)bytes.Length); writer.Write(bytes); writer.Flush(); accumulated = 0;
                            }
                        }
                    } finally { capture.ReleaseBuffer(frames); }
                    capture.GetNextPacketSize(out available);
                }
            }
        } finally {
            if (started) try { client.Stop(); } catch { }
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            Release(capture); Release(client); Release(device);
        }
    }
    [MTAThread] static int Main(string[] args) {
        IDeviceEnumerator enumerator = null;
        try {
            enumerator = (IDeviceEnumerator)new DeviceEnumerator();
            if (args.Length == 1 && args[0] == "list") List(enumerator);
            else if (args.Length == 2 && args[0] == "capture") Capture(enumerator, args[1]);
            else throw new Exception("Usage: LoopbackCapture list | capture <render endpoint id>");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(json.Serialize(new { type = "error", message = error.Message })); return 1; }
        finally { Release(enumerator); }
    }
}

using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Security.Principal;

// Use the WPF window's own message pump for notification-area interaction.
sealed class NativeTray : IDisposable
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Data {
        public uint Size; public IntPtr Window; public uint Id, Flags, Callback; public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Version;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Title;
        public uint InfoFlags; public Guid Guid; public IntPtr BalloonIcon;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern bool Shell_NotifyIcon(uint action, ref Data data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string message);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr buffer, int length, out int needed);
    public static bool IsLowIntegrity() {
        using (var identity = WindowsIdentity.GetCurrent()) {
            int size; GetTokenInformation(identity.Token, 25, IntPtr.Zero, 0, out size);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(identity.Token, 25, buffer, size, out size)) return false;
                string sid = new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
                return int.Parse(sid.Substring(sid.LastIndexOf('-') + 1)) < 8192;
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    readonly HwndSource source;
    readonly uint taskbarCreated = RegisterWindowMessage("TaskbarCreated");
    Data data;
    bool disposed;
    public bool Registered { get; private set; }
    public event Action Click;
    public event Action ContextMenu;
    public NativeTray(Window window, IntPtr icon, string title = "小鲸工作台 · 点击打开") {
        var handle = new WindowInteropHelper(window).EnsureHandle();
        source = HwndSource.FromHwnd(handle); source.AddHook(Hook);
        data = new Data { Size = (uint)Marshal.SizeOf(typeof(Data)), Window = handle, Id = 1, Flags = 1 | 2 | 4 | 128, Callback = 0x800B, Icon = icon, Tip = title, Info = "", Title = "" };
        Ensure();
    }
    public bool Ensure() {
        if (disposed) return false;
        // MODIFY also detects a missing icon after Explorer has restarted.
        Registered = Shell_NotifyIcon(1, ref data) || Shell_NotifyIcon(0, ref data);
        if (Registered) { var version = data; version.Version = 4; Shell_NotifyIcon(4, ref version); }
        return Registered;
    }
    IntPtr Hook(IntPtr handle, int message, IntPtr wParam, IntPtr lParam, ref bool handled) {
        if ((uint)message == taskbarCreated) { Registered = false; Ensure(); }
        if (message == 0x800B) {
            int action = (int)((long)lParam & 0xFFFF);
            if (action == 0x202 || action == 0x203 || action == 0x400 || action == 0x401) { SetForegroundWindow(handle); if (Click != null) Click(); handled = true; }
            if (action == 0x205 || action == 0x7B) { SetForegroundWindow(handle); if (ContextMenu != null) ContextMenu(); handled = true; }
        }
        return IntPtr.Zero;
    }
    public void Dispose() { if (disposed) return; disposed = true; Shell_NotifyIcon(2, ref data); source.RemoveHook(Hook); }
}

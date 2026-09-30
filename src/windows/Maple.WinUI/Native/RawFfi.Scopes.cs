using System.Runtime.InteropServices;

namespace Maple.WinUI.Native;

/// <summary>Host-owned bounded scope sample ABI for #3885; no full-frame readback.</summary>
[StructLayout(LayoutKind.Sequential)]
public unsafe struct MapleScopeStats
{
    public ulong frame;
    public uint total;
    public uint _pad;
    public uint* bins_ptr;
    public uint bins_len;
    public uint snapshot_width;
    public uint snapshot_height;
    public uint snapshot_len;
    public byte* snapshot_ptr;
}

public static unsafe partial class RawFfi
{
    /// <summary>448 values: 64-bin RGB counts, then 64-column luma and RGB means.</summary>
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_scope_panel_reduce(byte* rgb, uint rgbLength, uint width, uint height,
        double* output, uint outputLength);

    /// <summary>1 = sample copied, 0 = pending/busy with output unchanged; negative = error.</summary>
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_gpu_live_poll_scope(MapleGpuLiveSession* session, MapleScopeStats* output);
}

using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Maple.WinUI.Native;

// Native-detail integration for #3876; viewport scheduling is tracked by that issue.
public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, EntryPoint = "maple_apply_chain_and_encode_window_f32")]
    public static extern int ApplyWindow(float* input, uint width, uint height,
        MapleAdjustmentParams* parameters, MapleToneCurves* curves, IntPtr film,
        float strength, MapleChainWindow* window, float* output);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, EntryPoint = "maple_apply_chain_and_encode_window_f32")]
    public static extern int ApplyWindow(float* input, uint width, uint height,
        MapleAdjustmentParams* parameters, MapleToneCurves* curves, FilmLutHandle film,
        float strength, MapleChainWindow* window, float* output);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int maple_open_raw_handle(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath, out IntPtr handle);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void maple_close_raw_handle(IntPtr handle);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_raw_handle_geometry(RawDetailHandle handle, out MapleRawGeometry geometry);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_render_handle_scene_linear_tile_ae_f32(
        RawDetailHandle handle, uint x, uint y, uint width, uint height,
        uint outputWidth, uint outputHeight, int qualityPreview,
        float decodedTemperature, float decodedTint, float aeGain,
        MapleSceneLinearBufferF32* output);
}

[StructLayout(LayoutKind.Sequential)]
public struct MapleChainWindow
{
    public uint X;
    public uint Y;
    public uint FullWidth;
    public uint FullHeight;
}

[StructLayout(LayoutKind.Sequential)]
public struct MapleRawGeometry
{
    public uint SensorWidth;
    public uint SensorHeight;
    public uint CropX;
    public uint CropY;
    public uint CropWidth;
    public uint CropHeight;
}

public sealed class RawDetailHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private RawDetailHandle(IntPtr value) : base(true) => SetHandle(value);

    public static RawDetailHandle Open(string rawPath, string? xmpPath)
    {
        var result = RawFfi.maple_open_raw_handle(rawPath, xmpPath, out var value);
        if (result != 0)
            throw new InvalidDataException($"Native detail open failed ({result}): {RawFfi.LastError()}");
        if (value == IntPtr.Zero)
            throw new InvalidDataException("Native detail open returned an empty handle.");
        return new RawDetailHandle(value);
    }

    protected override bool ReleaseHandle()
    {
        RawFfi.maple_close_raw_handle(handle);
        return true;
    }
}

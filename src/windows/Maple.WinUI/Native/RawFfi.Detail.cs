using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Maple.WinUI.Native;

// Native-detail integration for #3876; viewport scheduling is tracked by that issue.
public static unsafe partial class RawFfi
{
    // `haze` is IntPtr.Zero or the frame's dehaze maps (#3287), required when
    // dehaze is engaged globally or in a mask layer.
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, EntryPoint = "maple_apply_chain_and_encode_window_f32")]
    public static extern int ApplyWindow(float* input, uint width, uint height,
        MapleAdjustmentParams* parameters, MapleToneCurves* curves, IntPtr film,
        float strength, MapleChainWindow* window, IntPtr haze, float* output);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, EntryPoint = "maple_apply_chain_and_encode_window_f32")]
    public static extern int ApplyWindow(float* input, uint width, uint height,
        MapleAdjustmentParams* parameters, MapleToneCurves* curves, FilmLutHandle film,
        float strength, MapleChainWindow* window, IntPtr haze, float* output);

    /// <summary>The whole frame's dehaze maps a native-detail window recovers
    /// with (#3287); <paramref name="haze"/> is IntPtr.Zero when no dehaze is
    /// engaged. Free with <see cref="maple_haze_map_free"/>.</summary>
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_scene_linear_chain_haze_map_f32(float* frame, uint width, uint height,
        MapleAdjustmentParams* parameters, MapleToneCurves* curves, out IntPtr haze);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern void maple_haze_map_free(IntPtr haze);

    /// <summary>A digest of everything the haze maps for
    /// <paramref name="parameters"/> depend on except the frame's pixels
    /// (#3287); 0 when no dehaze is engaged. Allocates nothing.</summary>
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern ulong maple_scene_linear_chain_haze_key(
        MapleAdjustmentParams* parameters, MapleToneCurves* curves);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern uint maple_scene_linear_chain_window_reach_px(
        MapleAdjustmentParams* parameters, MapleChainWindow* window);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int maple_open_raw_handle(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? xmpPath, out IntPtr handle);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void maple_close_raw_handle(IntPtr handle);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_raw_handle_geometry(RawDetailHandle handle, out MapleRawGeometry geometry);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern uint maple_raw_handle_orientation(RawDetailHandle handle);

    /// <summary>A capture tile (#5377): pixels in the fixed as-shot basis
    /// with no exposure gain, rendered with the whole-frame decode's creative
    /// stage. Free with <see cref="maple_free_scene_linear_buffer_f32"/>.</summary>
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_render_handle_capture_tile_f32(
        RawDetailHandle handle, uint x, uint y, uint width, uint height,
        uint outputWidth, uint outputHeight, int qualityPreview,
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

/// <summary>An owned <c>MapleHazeMap</c> (#3287), freed when the last user
/// releases it.</summary>
public sealed class HazeMapHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    internal HazeMapHandle(IntPtr value) : base(true) => SetHandle(value);

    protected override bool ReleaseHandle()
    {
        RawFfi.maple_haze_map_free(handle);
        return true;
    }
}

using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Native;

public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_decode_raster_base_file_f32(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint maxLongEdge,
        IntPtr cancellation, MapleSceneLinearBufferF32* output);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_validate_raster_adjustments(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string xmp);
}

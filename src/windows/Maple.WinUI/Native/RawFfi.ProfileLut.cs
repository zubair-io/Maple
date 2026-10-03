using System.Runtime.InteropServices;

namespace Maple.WinUI.Native;

public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_apply_display_lut_rgba_f32(
        float* rgba, nuint rgbaLength, float* lut, nuint lutLength, uint size);
}

using System.Runtime.InteropServices;

namespace Maple.WinUI.Native;

public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_resolve_imported_white_balance_file(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? rawPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string xmp,
        float* outputPair);
}

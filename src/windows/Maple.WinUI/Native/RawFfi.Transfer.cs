using System.Runtime.InteropServices;

namespace Maple.WinUI.Native;

public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_as_shot_white_balance_file(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath, float* pair);
}

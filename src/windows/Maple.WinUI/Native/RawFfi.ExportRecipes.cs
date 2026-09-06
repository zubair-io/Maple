using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Native;

public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_validate_export_recipe(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string recipeJson);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_export_recipe_filename_buf(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string recipeJson,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string originalStem,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? capturedAt,
        ulong sequenceIndex, byte* output, nuint capacity, nuint* length);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_export_recipe_to_file(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string rawPath,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string xmpXml,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string recipeJson,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? filmDirectory,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string stagingPath);
}

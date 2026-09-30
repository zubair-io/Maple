using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Maple.WinUI.Native;

public static unsafe partial class RawFfi
{
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_film_lut_decode(byte* bytes, nuint length, float* output, nuint capacity);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr maple_film_lut_create(uint size, float* data, nuint length);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void maple_film_lut_destroy(IntPtr handle);

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    public static extern int maple_apply_chain_and_encode_display_curves_film_f32(
        float* input, uint width, uint height, MapleAdjustmentParams* parameters,
        MapleToneCurves* curves, FilmLutHandle film, float strength, float* output);
}

/// <summary>Retains the immutable CPU lattice across a native render call.</summary>
public sealed class FilmLutHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private FilmLutHandle(IntPtr value) : base(true) => SetHandle(value);

    internal static unsafe FilmLutHandle Create(uint size, float[] data)
    {
        fixed (float* pointer = data)
        {
            var value = RawFfi.maple_film_lut_create(size, pointer, (nuint)data.Length);
            if (value == IntPtr.Zero) throw new InvalidDataException(RawFfi.LastError());
            return new FilmLutHandle(value);
        }
    }

    protected override bool ReleaseHandle()
    {
        RawFfi.maple_film_lut_destroy(handle);
        return true;
    }
}

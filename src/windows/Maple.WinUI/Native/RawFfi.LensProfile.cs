using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Native
{
    /// <summary>
    /// Imported LCP (#2435 / #3480) and bundled Lensfun (#3564 / #3568) lens
    /// profiles — the C# mirrors of raw-ffi/src/lens_profile.rs. Every
    /// JSON-returning entry hands back a heap string the caller owns and
    /// must release exactly once through
    /// <see cref="maple_free_lens_profile_json"/>; `0` = success, any other
    /// code carries its message in <see cref="RawFfi.maple_last_error"/> on
    /// the calling thread. `Services/LensProfileStore.cs` is the only caller.
    /// </summary>
    public static unsafe partial class RawFfi
    {
        /// <summary>Drop every profile registered in this process. Isolated
        /// render workers call it between jobs; the shell never does, since
        /// a decode and an AMaZE upgrade of two photos can be in flight
        /// together and each relies on its own registered profile.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_lens_profile_clear_cache();

        /// <summary>Parse a sidecar with the render-side XMP reader and report
        /// `{"reference": "...", "enabled": bool}` — the selection exactly as
        /// a develop of that sidecar would see it. `xml` is the raw UTF-8
        /// document, at most 32 MiB.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_lens_profile_selected(
            byte[] xml, nuint length, out IntPtr outJson);

        /// <summary>Register user-owned LCP bytes (UTF-8, 1 byte – 32 MiB) in
        /// the process cache. Success JSON: `version`, `reference`
        /// (`lcp1:&lt;BLAKE3 hex&gt;` of the exact bytes), `make`, `camera`,
        /// `lens`, `name`, `sampleCount`. 1 = bad length, 2 = not UTF-8,
        /// 8 = unparseable profile / cache full.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_lens_profile_register(
            byte[] xml, nuint length, out IntPtr outJson);

        /// <summary>Resolve a registered reference against the RAW at
        /// `path` (its real capture metadata; decoded through the shared
        /// decode cache, so a call after a develop is warm). Success JSON:
        /// `source` (`lensfun` | `lcp` | `embedded` | `none`), `lens` /
        /// `dbVersion` (present only on the `lensfun` branch), `confidence`
        /// (`in-range` | `approximate` | `embedded`), `hasDistortion` /
        /// `hasCa` / `hasVignetting`, `approximations[]`, `unsupported[]`,
        /// and per family (`distortion` / `ca` / `vignetting`) the
        /// interpolated calibration samples. An empty reference asks for
        /// the automatic match (the bundled Lensfun database, #3564) rather
        /// than reporting the embedded state alone. 8 = not registered,
        /// camera/lens mismatch, or an unsupported model — `maple_last_error`
        /// says which.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_lens_profile_resolve_file(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string reference,
            out IntPtr outJson);

        /// <summary>Every bundled Lensfun lens the RAW's camera body can
        /// carry (#3564/#3568), for the Lens panel's dropdown: success JSON
        /// `[{"slug","maker","model"}]`, `[]` for an unknown body. Each
        /// `slug` is the exact suffix of a `lensfun1:&lt;slug&gt;` reference
        /// this build's `select` would write.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern int maple_lens_profile_compatible(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
            out IntPtr outJson);

        /// <summary>Release a JSON string returned by any entry above. Null
        /// is accepted.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern void maple_free_lens_profile_json(IntPtr json);
    }
}

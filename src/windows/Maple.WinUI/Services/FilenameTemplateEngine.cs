// FilenameTemplateEngine.cs — thin wrapper over the shared
// `maple_render_filename_template_buf` FFI entry (`raw-ffi/src/filename.rs`),
// issue #2642. Same raw-core batch-rename engine the Self Hosted API calls
// via bun:ffi (`src/api/src/ffi/raw_ffi.ts`'s `renderFilenameTemplate`) and
// the one Windows' own single-rename validation already reaches
// (`maple_validate_filename`, Services/FilenameValidation.cs) — one
// implementation, three thin P/Invoke-or-FFI shims, per CLAUDE.md's "One
// Rust core" principle. Do NOT hand-roll a second token parser here.
//
// Deliberately lives in Services/, NOT Services/FileOperations/: it calls
// into Native/RawFfi.cs, and that directory's wildcard link into
// Maple.WinUI.Tests.csproj must stay free of anything touching RawFfi (see
// that project's header comment on the #2632 linking incident this
// mirrors). Maple.WinUI.Tests exercises BatchRenameLogic
// (Services/FileOperations/BatchRenameLogic.cs) against a fake
// RenderFilenameTemplateFunc instead — this class itself is untested for
// the same reason FilenameValidation.cs is: a direct P/Invoke pass-through
// with no logic of its own beyond marshalling and the LastError() readback.

using System;
using System.Runtime.InteropServices;
using System.Text;
using Maple.WinUI.Native;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.Services
{
    public static class FilenameTemplateEngine
    {
        /// <summary>Caller-owned output buffer size for
        /// `maple_render_filename_template_buf`. 1 KiB comfortably covers
        /// any output that could ever pass validation (every target
        /// filesystem caps names near 255 bytes) — matches the API's own
        /// `RENDER_OUT_CAP` (`src/api/src/ffi/raw_ffi.ts`). A degenerate
        /// token-repeating template that overflows it gets a clean
        /// buffer-too-small rejection (error code 9), not a truncated
        /// name.</summary>
        private const int RenderOutCap = 1024;

        /// <summary>Render one filename from a batch-rename template via the
        /// shared raw-core engine. <paramref name="capturedAtWire"/> is EXIF
        /// `DateTimeOriginal`'s `"YYYY:MM:DD HH:MM:SS"` wire format, or
        /// null — a null/unparseable value renders every `{date:FORMAT}`
        /// token as the engine's documented fallback text rather than
        /// failing the whole render.</summary>
        public static FilenameRenderOutcome Render(
            string template,
            string originalStem,
            string ext,
            string? capturedAtWire,
            ulong sequenceStart,
            ulong sequenceIndex,
            int sequencePadWidth)
        {
            var padWidth = sequencePadWidth < 0 ? (nuint)0 : (nuint)sequencePadWidth;
            var buffer = Marshal.AllocHGlobal(RenderOutCap);
            try
            {
                var rc = RawFfi.maple_render_filename_template_buf(
                    template, originalStem, ext, capturedAtWire,
                    sequenceStart, sequenceIndex, padWidth,
                    buffer, (nuint)RenderOutCap, out var outLen);
                if (rc == 0)
                {
                    var bytes = new byte[(int)outLen];
                    Marshal.Copy(buffer, bytes, 0, (int)outLen);
                    return FilenameRenderOutcome.Success(Encoding.UTF8.GetString(bytes));
                }
                return FilenameRenderOutcome.Failure(rc, RawFfi.LastError() ?? "Template rendering failed.");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}

// FilenameValidation.cs — thin wrapper over the shared `maple_validate_filename`
// FFI entry (`raw-ffi/src/filename.rs`), issue #2639. The same
// Windows-reserved-name / trailing-dot / path-separator rule set the
// batch-rename engine (#2628) and the Self Hosted API's `/rename` route
// (#2636) already enforce — a manually-typed inline rename gets IDENTICAL
// rejection behaviour rather than a hand-rolled second rule set. Mirrors
// Apple's `FilenameValidation.swift`.
//
// Deliberately NOT unit-tested: it is a direct P/Invoke pass-through with no
// logic of its own beyond the call and the LastError() readback (Apple's
// counterpart is untested for the same reason). `RenameLogic`
// (Services/FileOperations/RenameLogic.cs) carries the pure stem/extension
// logic inline rename also needs, and that one IS covered by
// Maple.WinUI.Tests.

using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    public static class FilenameValidation
    {
        /// <summary>Null when <paramref name="name"/> is a valid single
        /// filesystem path component (non-empty, no path separator, no
        /// leading dot, no trailing dot or space, not an OS-reserved device
        /// name). Otherwise the human-readable rejection reason from
        /// `maple_last_error()`, ready to surface next to the rename
        /// field.</summary>
        public static string? ValidationError(string name)
        {
            var rc = RawFfi.maple_validate_filename(name);
            return rc == 0 ? null : (RawFfi.LastError() ?? $"'{name}' is not a valid file name.");
        }
    }
}

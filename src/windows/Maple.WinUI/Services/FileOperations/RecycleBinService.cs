// RecycleBinService.cs — the real Windows Recycle Bin (issue #2632), for
// local fixed drives. Delete → Trash on Windows is a syscall, not
// copy-verify-delete, because the OS owns that semantics and the result
// stays recoverable from Explorer — matching macOS's `FileManager.trashItem`
// (see `LocalFileOperations+Trash.swift`) and what a desktop user expects.
//
// P/Invokes shell32's legacy `SHFileOperationW` with `FOF_ALLOWUNDO`, the
// same technique Windows Explorer itself has used for "Send to Recycle Bin"
// since Windows 95 — declared the same way `RawFfi.cs` P/Invokes
// raw_ffi.dll elsewhere in this project (a `static class` of `DllImport`
// externs, no COM). `SHFileOperationW` (not the newer `IFileOperation` COM
// interface) is the deliberate choice here: it is ONE flat function call
// with a plain struct, not a COM vtable to marshal, and it fully supports
// `FOF_ALLOWUNDO` — the only capability this service needs. `IFileOperation`
// is the Explorer-recommended API for anything progress-UI-related, but this
// call is silent and single-item, which is exactly `SHFileOperationW`'s
// sweet spot.

using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services.FileOperations
{
    public sealed class RecycleBinService : IRecycleBinService
    {
        public static readonly RecycleBinService Instance = new();

        // shellapi.h: FO_DELETE, FOF_* flags. wFunc is a UINT; the FOF_*
        // flags are a WORD (ushort) — both per the documented
        // SHFILEOPSTRUCTW layout.
        private const uint FoDelete = 0x0003;
        private const ushort FofAllowUndo = 0x0040;      // send to Recycle Bin instead of a hard delete
        private const ushort FofNoConfirmation = 0x0010; // no "are you sure?" prompt
        private const ushort FofSilent = 0x0004;         // no progress dialog
        private const ushort FofNoErrorUi = 0x0400;       // no error dialog — failures are reported via the return code
        private const ushort FofNoConfirmMkDir = 0x0200;  // irrelevant here (no directory creation), kept for parity with common FOF combos

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SHFILEOPSTRUCTW
        {
            public IntPtr hwnd;
            public uint wFunc;
            [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
            [MarshalAs(UnmanagedType.LPWStr)] public string? pTo;
            public ushort fFlags;
            [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
            public IntPtr hNameMappings;
            [MarshalAs(UnmanagedType.LPWStr)] public string? lpszProgressTitle;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int SHFileOperationW(ref SHFILEOPSTRUCTW fileOp);

        /// <summary>
        /// Send every path in <paramref name="paths"/> to the Recycle Bin in
        /// ONE `SHFileOperationW` call. `pFrom` accepts multiple entries in
        /// a single buffer — each path separated by one `'\0'`, the whole
        /// list terminated by a DOUBLE `'\0'` — which is what lets a
        /// primary and its sidecar be handed to the shell together instead
        /// of as two independent calls with a partial-failure window between
        /// them. `string.Join("\0", paths)` produces the single-null
        /// separators; the explicit trailing `"\0"` plus the P/Invoke
        /// marshaler's own string terminator together produce the required
        /// trailing double-null.
        /// </summary>
        public bool TrySendToRecycleBin(params string[] paths)
        {
            if (paths.Length == 0) return true;

            try
            {
                var op = new SHFILEOPSTRUCTW
                {
                    hwnd = IntPtr.Zero,
                    wFunc = FoDelete,
                    pFrom = string.Join('\0', paths) + "\0",
                    pTo = null,
                    fFlags = (ushort)(FofAllowUndo | FofNoConfirmation | FofSilent | FofNoErrorUi | FofNoConfirmMkDir),
                };
                var result = SHFileOperationW(ref op);
                return result == 0 && !op.fAnyOperationsAborted;
            }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or MarshalDirectiveException)
            {
                // Non-Windows or a malformed marshal — never the caller's
                // problem to diagnose; fall back to `.maple/trash/<rel>`.
                return false;
            }
        }
    }
}

// The cldapi/kernel32 half of the #4756 sweep: answers "is this path
// Maple's own registered sync root?" and removes an item when — and only
// when — the handle it just probed says it is an in-sync placeholder
// (or a never-populated placeholder directory) for CloudFilesSyncRoot. Kept out of CloudFilesSyncRootCleanup.cs so the
// walk itself stays linkable into Maple.WinUI.Tests.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Maple.WinUI.Services.CloudFiles
{
    internal static class CloudFilesPlaceholderProbe
    {
        internal static CleanupProbes Probes { get; } =
            new(TryRemoveUnmodifiedPlaceholder, TryRemoveUnpopulatedPlaceholderDirectory);

        /// <summary>True only when the path is inside a registered sync root
        /// whose provider name is Maple's — another provider's root at the
        /// same path must not be adopted (and later swept).</summary>
        internal static bool IsMapleSyncRoot(string path)
        {
            if (!Directory.Exists(path))
                return false;
            var info = new byte[CfApi.CF_SYNC_ROOT_PROVIDER_INFO_SIZE];
            var hr = CfApi.CfGetSyncRootInfoByPath(
                path, CfApi.CF_SYNC_ROOT_INFO_PROVIDER, info, (uint)info.Length, out var returned);
            if (hr != 0 || returned < CfApi.CF_SYNC_ROOT_PROVIDER_INFO_NAME_OFFSET + 2)
                return false;
            var name = Encoding.Unicode.GetString(
                info, CfApi.CF_SYNC_ROOT_PROVIDER_INFO_NAME_OFFSET, CfApi.CF_SYNC_ROOT_PROVIDER_INFO_NAME_BYTES);
            return name.Split('\0')[0] == CloudFilesSyncRoot.ProviderName;
        }

        /// <summary>A placeholder the platform still marks in-sync — Maple
        /// created it and nothing has written to it since, so the server
        /// copy is authoritative. Plain files carry no reparse tag and a
        /// written-to placeholder loses its in-sync bit; both are not
        /// eligible. Applies to files and to empty directories alike.</summary>
        internal static RemovalOutcome TryRemoveUnmodifiedPlaceholder(string path) =>
            RemoveIfState(path, CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER | CfApi.CF_PLACEHOLDER_STATE_IN_SYNC);

        /// <summary>A directory placeholder Explorer never opened: still
        /// partial, so nothing local exists beneath it. Removing it outright
        /// avoids the FETCH_PLACEHOLDERS round-trip enumeration would cost.</summary>
        internal static RemovalOutcome TryRemoveUnpopulatedPlaceholderDirectory(string path) =>
            RemoveIfState(path, CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER
                | CfApi.CF_PLACEHOLDER_STATE_IN_SYNC
                | CfApi.CF_PLACEHOLDER_STATE_PARTIAL);

        /// <summary>Classifies and deletes through one handle: the state is
        /// read from the handle and the delete disposition is set on that
        /// same handle, so whatever the path names afterwards is untouched.
        /// Deletion takes effect when the handle closes.</summary>
        private static RemovalOutcome RemoveIfState(string path, uint required)
        {
            using var handle = Win32.OpenReparsePoint(path);
            var (attributes, reparseTag) = Win32.ReadAttributeTag(handle, path);
            var state = CfApi.CfGetPlaceholderStateFromAttributeTag(attributes, reparseTag);
            if (state == CfApi.CF_PLACEHOLDER_STATE_INVALID || (state & required) != required)
                return RemovalOutcome.NotEligible;
            return Win32.MarkForDeletion(handle) ? RemovalOutcome.Removed : RemovalOutcome.Failed;
        }

        private static class Win32
        {
            private const uint FILE_READ_ATTRIBUTES = 0x80;
            private const uint DELETE = 0x00010000;
            private const uint FILE_SHARE_ALL = 0x7;
            private const uint OPEN_EXISTING = 3;
            private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
            private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
            private const int FileDispositionInfo = 4;
            private const int FileAttributeTagInfo = 9;

            [StructLayout(LayoutKind.Sequential)]
            private struct FILE_ATTRIBUTE_TAG_INFO
            {
                public uint FileAttributes;
                public uint ReparseTag;
            }

            [StructLayout(LayoutKind.Sequential)]
            private struct FILE_DISPOSITION_INFO
            {
                public byte DeleteFile;   // BOOLEAN
            }

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
            private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
                string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
                uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

            [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
            private static extern bool GetFileInformationByHandleEx(
                Microsoft.Win32.SafeHandles.SafeFileHandle file, int infoClass,
                ref FILE_ATTRIBUTE_TAG_INFO info, uint bufferSize);

            [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
            private static extern bool SetFileInformationByHandle(
                Microsoft.Win32.SafeHandles.SafeFileHandle file, int infoClass,
                ref FILE_DISPOSITION_INFO info, uint bufferSize);

            /// <summary>Opens the reparse point itself (never the
            /// placeholder's data, so nothing hydrates) with just enough
            /// access to read its tag and mark it for deletion.</summary>
            internal static Microsoft.Win32.SafeHandles.SafeFileHandle OpenReparsePoint(string path)
            {
                var handle = CreateFileW(
                    path, FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
                if (handle.IsInvalid)
                    throw new IOException($"CreateFileW failed ({Marshal.GetLastWin32Error()}) for {path}");
                return handle;
            }

            internal static (uint Attributes, uint ReparseTag) ReadAttributeTag(
                Microsoft.Win32.SafeHandles.SafeFileHandle handle, string path)
            {
                var info = new FILE_ATTRIBUTE_TAG_INFO();
                if (!GetFileInformationByHandleEx(
                        handle, FileAttributeTagInfo, ref info, (uint)Marshal.SizeOf<FILE_ATTRIBUTE_TAG_INFO>()))
                    throw new IOException($"GetFileInformationByHandleEx failed ({Marshal.GetLastWin32Error()}) for {path}");
                return (info.FileAttributes, info.ReparseTag);
            }

            /// <summary>False when the system refuses — read-only attribute,
            /// a non-empty directory, a sharing conflict.</summary>
            internal static bool MarkForDeletion(Microsoft.Win32.SafeHandles.SafeFileHandle handle)
            {
                var disposition = new FILE_DISPOSITION_INFO { DeleteFile = 1 };
                return SetFileInformationByHandle(
                    handle, FileDispositionInfo, ref disposition, (uint)Marshal.SizeOf<FILE_DISPOSITION_INFO>());
            }
        }
    }
}

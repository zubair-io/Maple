// The cldapi/kernel32 half of the #4756 sweep: answers "is this path
// Maple's own registered sync root?", "is this file an in-sync placeholder
// Maple may delete?" and "is this directory an unpopulated placeholder?"
// for CloudFilesSyncRoot. Kept out of CloudFilesSyncRootCleanup.cs so the
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
            new(IsUnmodifiedPlaceholder, IsUnpopulatedPlaceholderDirectory);

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
        /// written-to placeholder loses its in-sync bit; both read false.</summary>
        internal static bool IsUnmodifiedPlaceholder(string path) =>
            HasState(path, CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER | CfApi.CF_PLACEHOLDER_STATE_IN_SYNC);

        /// <summary>A directory placeholder Explorer never opened: still
        /// partial, so nothing local exists beneath it. Deleting it outright
        /// avoids the FETCH_PLACEHOLDERS round-trip enumeration would cost.</summary>
        internal static bool IsUnpopulatedPlaceholderDirectory(string path) =>
            HasState(path, CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER
                | CfApi.CF_PLACEHOLDER_STATE_IN_SYNC
                | CfApi.CF_PLACEHOLDER_STATE_PARTIAL);

        private static bool HasState(string path, uint required)
        {
            var (attributes, reparseTag) = Win32.ReadAttributeTag(path);
            var state = CfApi.CfGetPlaceholderStateFromAttributeTag(attributes, reparseTag);
            return state != CfApi.CF_PLACEHOLDER_STATE_INVALID && (state & required) == required;
        }

        private static class Win32
        {
            private const uint FILE_READ_ATTRIBUTES = 0x80;
            private const uint FILE_SHARE_ALL = 0x7;
            private const uint OPEN_EXISTING = 3;
            private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
            private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
            private const int FileAttributeTagInfo = 9;

            [StructLayout(LayoutKind.Sequential)]
            private struct FILE_ATTRIBUTE_TAG_INFO
            {
                public uint FileAttributes;
                public uint ReparseTag;
            }

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
            private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
                string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
                uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

            [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
            private static extern bool GetFileInformationByHandleEx(
                Microsoft.Win32.SafeHandles.SafeFileHandle file, int infoClass,
                ref FILE_ATTRIBUTE_TAG_INFO info, uint bufferSize);

            /// <summary>Attributes plus reparse tag without triggering
            /// hydration: the handle opens the reparse point itself, never
            /// the placeholder's data.</summary>
            internal static (uint Attributes, uint ReparseTag) ReadAttributeTag(string path)
            {
                using var handle = CreateFileW(
                    path, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
                if (handle.IsInvalid)
                    throw new IOException($"CreateFileW failed ({Marshal.GetLastWin32Error()}) for {path}");
                var info = new FILE_ATTRIBUTE_TAG_INFO();
                if (!GetFileInformationByHandleEx(
                        handle, FileAttributeTagInfo, ref info, (uint)Marshal.SizeOf<FILE_ATTRIBUTE_TAG_INFO>()))
                    throw new IOException($"GetFileInformationByHandleEx failed ({Marshal.GetLastWin32Error()}) for {path}");
                return (info.FileAttributes, info.ReparseTag);
            }
        }
    }
}

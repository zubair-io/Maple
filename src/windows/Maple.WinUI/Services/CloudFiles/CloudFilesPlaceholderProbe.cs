// The cldapi/kernel32 half of the #4756 sweep: answers "is this path a
// registered sync root?" and "is this file an in-sync placeholder Maple
// may delete?" for CloudFilesSyncRoot. Kept out of CloudFilesSyncRootCleanup.cs
// so the walk itself stays linkable into Maple.WinUI.Tests.

using System;
using System.IO;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services.CloudFiles
{
    internal static class CloudFilesPlaceholderProbe
    {
        internal static bool IsRegisteredSyncRoot(string path)
        {
            if (!Directory.Exists(path))
                return false;
            long syncRootFileId = 0;
            var hr = CfApi.CfGetSyncRootInfoByPath(
                path, CfApi.CF_SYNC_ROOT_INFO_BASIC, ref syncRootFileId, sizeof(long), out _);
            return hr == 0;
        }

        /// <summary>A placeholder the platform still marks in-sync — Maple
        /// created it and nothing has written to it since, so the server
        /// copy is authoritative. Plain files carry no reparse tag and a
        /// written-to placeholder loses its in-sync bit; both read false.</summary>
        internal static bool IsUnmodifiedPlaceholder(string path)
        {
            var (attributes, reparseTag) = Win32.ReadAttributeTag(path);
            var state = CfApi.CfGetPlaceholderStateFromAttributeTag(attributes, reparseTag);
            const uint required = CfApi.CF_PLACEHOLDER_STATE_PLACEHOLDER | CfApi.CF_PLACEHOLDER_STATE_IN_SYNC;
            return state != CfApi.CF_PLACEHOLDER_STATE_INVALID && (state & required) == required;
        }

        private static class Win32
        {
            private const uint GENERIC_READ_ATTRIBUTES = 0x80; // FILE_READ_ATTRIBUTES
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
                    path, GENERIC_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
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

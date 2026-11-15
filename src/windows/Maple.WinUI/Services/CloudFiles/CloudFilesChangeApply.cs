using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace Maple.WinUI.Services.CloudFiles;

/// <summary>Small cldapi surface used by the change-feed applier. Kept
/// separate so containment and action planning are testable without a sync
/// root, while the actual directory invalidation always goes through cldapi.</summary>
internal static class CloudFilesChangeApply
{
    internal static bool IsWithin(string root, string path)
    {
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var fullPath = Path.GetFullPath(path);
        if (string.Equals(fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                normalizedRoot, StringComparison.OrdinalIgnoreCase)) return true;
        var fullRoot = normalizedRoot + Path.DirectorySeparatorChar;
        return fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase);
    }

    internal static bool MetadataMatches(string path, PlaceholderEntry entry)
    {
        try
        {
            var info = new FileInfo(path);
            if (entry.IsDirectory != Directory.Exists(path)) return false;
            if (!entry.IsDirectory && info.Length != entry.Size) return false;
            return Math.Abs((info.LastWriteTimeUtc - entry.MtimeUtc).TotalMilliseconds) < 1;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    internal static bool EnableOnDemandPopulation(string directory)
    {
        var hr = CfApi.CfOpenFileWithOplock(directory, CfApi.CF_OPEN_FILE_FLAG_EXCLUSIVE, out var handle);
        if (hr != 0 || handle == IntPtr.Zero)
        {
            DiagLog.Write($"[cloudfiles] directory refresh open 0x{hr:X8}: {directory}");
            return false;
        }
        try
        {
            hr = CfApi.CfUpdatePlaceholder(
                handle, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero, 0,
                CfApi.CF_UPDATE_FLAG_ENABLE_ON_DEMAND_POPULATION,
                IntPtr.Zero, IntPtr.Zero);
            if (hr != 0) DiagLog.Write($"[cloudfiles] enable population 0x{hr:X8}: {directory}");
            return hr == 0;
        }
        finally { CfApi.CfCloseHandle(handle); }
    }

    /// <summary>Apply fresh server metadata to a previously created file
    /// placeholder. The exclusive oplock prevents racing an editor; the
    /// in-sync verify bit and DEHYDRATE flag make local edits and pins fail
    /// closed without replacing their bytes.</summary>
    internal static bool UpdatePlaceholder(string path, PlaceholderEntry entry) =>
        UpdatePlaceholder(path, entry, out _);

    internal static bool UpdatePlaceholder(string path, PlaceholderEntry entry, out int result)
    {
        result = unchecked((int)0x80004005);
        if (!CloudFilesPlaceholderProbe.CanSafelyMutate(path)) return false;
        var hr = CfApi.CfOpenFileWithOplock(path, CfApi.CF_OPEN_FILE_FLAG_EXCLUSIVE, out var handle);
        if (hr != 0 || handle == IntPtr.Zero) { result = hr; return false; }
        var identity = Encoding.Unicode.GetBytes(entry.Address);
        var idHandle = GCHandle.Alloc(identity, GCHandleType.Pinned);
        try
        {
            var time = entry.MtimeUtc.ToFileTimeUtc();
            var metadata = new CfApi.CF_FS_METADATA
            {
                FileSize = Math.Max(0, entry.Size),
                BasicInfo = new CfApi.FILE_BASIC_INFO
                {
                    CreationTime = time, LastAccessTime = time, LastWriteTime = time, ChangeTime = time,
                    FileAttributes = entry.IsDirectory ? 0x10u : 0x80u,
                },
            };
            var metadataHandle = GCHandle.Alloc(metadata, GCHandleType.Pinned);
            try
            {
                hr = CfApi.CfUpdatePlaceholder(
                    handle, metadataHandle.AddrOfPinnedObject(), idHandle.AddrOfPinnedObject(),
                    (uint)identity.Length, IntPtr.Zero, 0,
                    CfApi.CF_UPDATE_FLAG_VERIFY_IN_SYNC | CfApi.CF_UPDATE_FLAG_MARK_IN_SYNC |
                        (entry.IsDirectory ? 0u : CfApi.CF_UPDATE_FLAG_DEHYDRATE),
                    IntPtr.Zero, IntPtr.Zero);
            }
            finally { metadataHandle.Free(); }
            if (hr != 0) DiagLog.Write($"[cloudfiles] placeholder update 0x{hr:X8}: {path}");
            result = hr;
            return hr == 0;
        }
        finally
        {
            idHandle.Free();
            CfApi.CfCloseHandle(handle);
        }
    }
}

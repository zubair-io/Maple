using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

namespace Maple.WinUI.Services.Export;

public static class ExportPaths
{
    public static string DirectoryPath(string path)
    {
        var info = new DirectoryInfo(Path.GetFullPath(path));
        if (!info.Exists) throw new DirectoryNotFoundException($"Export folder is unavailable: {path}");
        if (info.Parent == null) return info.FullName;
        var resolved = new DirectoryInfo(Path.Combine(DirectoryPath(info.Parent.FullName), info.Name));
        return resolved.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? resolved.FullName;
    }

    public static string FilePath(string path)
    {
        var absolute = Path.GetFullPath(path);
        var resolved = Path.Combine(DirectoryPath(Path.GetDirectoryName(absolute)!), Path.GetFileName(absolute));
        return File.Exists(resolved)
            ? new FileInfo(resolved).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? resolved
            : resolved;
    }

    public static string Hash(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public static string? ExistingHash(string path) => File.Exists(path) ? Hash(path) : null;

    public static HashSet<string> OriginalPaths(ExportQueueJob job) => job.ProtectedOriginals
        .Concat(job.Entries.Select(e => e.Input.SourcePath)).Where(File.Exists)
        .Select(FilePath).ToHashSet(StringComparer.OrdinalIgnoreCase);

    public static void ProtectOriginals(HashSet<string> originals, ExportQueueItem item)
    {
        var destination = FilePath(item.OutputPath);
        if (originals.Contains(destination))
            throw new IOException($"Export destination is an original photo: {item.OutputPath}");
        if (originals.Contains(FilePath(item.TempPath)))
            throw new IOException($"Export staging path is an original photo: {item.TempPath}");
    }

    public static string StagingPath(string directory, string jobId, ulong index) =>
        Path.Combine(directory, $".maple-export-{jobId}-{index}.tmp");

    public static void DeleteStaging(ExportQueueItem item)
    {
        if (File.Exists(item.TempPath)) File.Delete(item.TempPath);
    }
}

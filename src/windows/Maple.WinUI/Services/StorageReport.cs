using System;
using System.IO;
using System.Linq;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// WinUI-free helpers behind the Settings window's Storage section
    /// (MN3, #3052): human-readable byte formatting and a best-effort
    /// recursive directory size. Linked into Maple.WinUI.Tests via explicit
    /// &lt;Compile Include&gt; (the same split every Mui *Logic/Math class
    /// uses) so the formatting rules are exercisable without a live Window.
    /// </summary>
    public static class StorageReport
    {
        /// <summary>1024-based, one decimal from MB up ("312 KB",
        /// "1.4 GB"), whole numbers below. Negative counts are treated
        /// as 0 (a size probe that failed partway).</summary>
        public static string FormatBytes(long bytes)
        {
            var value = Math.Max(0, bytes);
            if (value < 1024) return $"{value} B";
            if (value < 1024L * 1024) return $"{value / 1024.0:0} KB";
            if (value < 1024L * 1024 * 1024) return $"{value / (1024.0 * 1024):0.#} MB";
            return $"{value / (1024.0 * 1024 * 1024):0.#} GB";
        }

        /// <summary>Total size of every shared thumbnail cache
        /// (`.maple\thumbs`, #3083) under <paramref name="libraryRoot"/> —
        /// the caches live beside the photos, one per folder, so this walks
        /// the tree for `.maple` directories and sums their `thumbs`
        /// subdirectories. Null when the root itself is missing or cannot be
        /// enumerated at all; inaccessible subtrees are skipped
        /// (IgnoreInaccessible), matching
        /// <see cref="TryDirectorySizeBytes"/>'s contract.</summary>
        public static long? TryMapleThumbsSizeBytes(string libraryRoot)
        {
            try
            {
                if (!Directory.Exists(libraryRoot))
                    return null;
                var options = new EnumerationOptions
                {
                    RecurseSubdirectories = true,
                    IgnoreInaccessible = true,
                    AttributesToSkip = 0,
                };
                return new DirectoryInfo(libraryRoot)
                    .EnumerateDirectories(".maple", options)
                    .Sum(mapleDir =>
                        TryDirectorySizeBytes(Path.Combine(mapleDir.FullName, "thumbs")) ?? 0);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>Recursive size of a directory, or null when it does not
        /// exist or cannot be enumerated at all (network share offline, root
        /// access denied). Inaccessible subdirectories/files are skipped by
        /// the enumeration itself (IgnoreInaccessible) rather than aborting
        /// the whole probe, and nothing is filtered by attribute — hidden
        /// and system files count toward the size (EnumerationOptions
        /// defaults would silently skip them).</summary>
        public static long? TryDirectorySizeBytes(string path)
        {
            try
            {
                if (!Directory.Exists(path))
                    return null;
                var options = new EnumerationOptions
                {
                    RecurseSubdirectories = true,
                    IgnoreInaccessible = true,
                    AttributesToSkip = 0,
                };
                return new DirectoryInfo(path).EnumerateFiles("*", options)
                    .Sum(file =>
                    {
                        try { return file.Length; }
                        catch (IOException) { return 0; }
                        catch (UnauthorizedAccessException) { return 0; }
                    });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }
    }
}

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

        /// <summary>Recursive size of a directory, or null when it does not
        /// exist or cannot be enumerated (network share offline, access
        /// denied). Individual unreadable files are skipped rather than
        /// failing the whole probe.</summary>
        public static long? TryDirectorySizeBytes(string path)
        {
            try
            {
                if (!Directory.Exists(path))
                    return null;
                return Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories)
                    .Sum(file =>
                    {
                        try { return new FileInfo(file).Length; }
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

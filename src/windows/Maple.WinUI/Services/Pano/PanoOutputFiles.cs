using System;
using System.IO;

namespace Maple.WinUI.Services.Pano;

/// <summary>Where a stitch writes beside the user's frames. The name is
/// chosen so neither output exists yet, which is what makes deleting the
/// master after a failed or cancelled run safe: it is only ever a file that
/// run created.</summary>
public static class PanoOutputFiles
{
    public static string UniqueBaseName(string folder, string baseName)
    {
        if (!Taken(folder, baseName))
            return baseName;
        for (var i = 2; ; i++)
        {
            var candidate = $"{baseName}-{i}";
            if (!Taken(folder, candidate))
                return candidate;
        }
    }

    public static string MasterPath(string folder, string baseName) => Path.Combine(folder, $"{baseName}-master.png");

    public static string JpegPath(string folder, string baseName) => Path.Combine(folder, $"{baseName}.jpg");

    /// <summary>Removes the master a failed or cancelled run left behind;
    /// null when it is gone, otherwise why it could not be removed.</summary>
    public static string? DiscardPartial(string masterPath)
    {
        try
        {
            File.Delete(masterPath);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            DiagLog.Write($"[pano] could not remove {masterPath}: {ex.Message}");
            return $"The unfinished file {Path.GetFileName(masterPath)} could not be removed: {ex.Message}";
        }
    }

    private static bool Taken(string folder, string baseName) =>
        File.Exists(JpegPath(folder, baseName)) || File.Exists(MasterPath(folder, baseName));
}

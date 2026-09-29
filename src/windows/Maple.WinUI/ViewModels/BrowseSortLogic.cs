using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.WinUI.ViewModels;

public enum BrowseSort { Name, CapturedNewest, CapturedOldest, Rating }

/// <summary>Stable ordering shared by Browse and viewer traversal. Missing capture
/// dates use the existing file-modified fallback, never a fabricated capture date.</summary>
public static class BrowseSortLogic
{
    public static IOrderedEnumerable<PhotoItem> Order(IEnumerable<PhotoItem> photos, BrowseSort sort)
    {
        var ordered = sort switch
        {
            BrowseSort.CapturedNewest => photos.OrderByDescending(p => p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime()),
            BrowseSort.CapturedOldest => photos.OrderBy(p => p.CaptureDate ?? p.FileModifiedUtc.ToLocalTime()),
            BrowseSort.Rating => photos.OrderByDescending(p => p.Rating),
            _ => photos.OrderBy(p => p.FileName, StringComparer.OrdinalIgnoreCase),
        };
        return ordered.ThenBy(p => p.FileName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(p => p.FilePath, StringComparer.OrdinalIgnoreCase);
    }
}

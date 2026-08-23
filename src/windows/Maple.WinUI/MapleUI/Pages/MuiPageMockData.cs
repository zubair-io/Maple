using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One folder/source in the shared fictional library the
    /// Windows Pages wave (#3012) reuses across Browse/Editor/Document/
    /// Search/TV Timeline/TV Map so a reviewer sees the same photographer's
    /// catalog (not a fresh disconnected dataset) as they click through the
    /// gallery's Pages tab. Plain data — WinUI-free so
    /// <see cref="MuiBrowsePageReducer"/> and friends can filter it without
    /// a live Window, and so it links into Maple.WinUI.Tests the same way
    /// the wave's other pure-logic files do.</summary>
    public sealed record MuiMockFolder(string Id, string Label, string IconName, string? ParentId, int? CountOverride = null);

    /// <summary>One photo in the shared fictional library. <see cref="R"/>/
    /// <see cref="G"/>/<see cref="B"/> stand in for a decoded thumbnail (a
    /// solid swatch, same synthesized-bitmap approach
    /// MuiGalleryWindow.xaml.cs's own SolidBitmap already uses) —
    /// <see cref="GeoX"/>/<see cref="GeoY"/> are normalized 0..1 map
    /// coordinates for the Map Surface organism.</summary>
    public sealed record MuiMockAsset(
        string Id, string Filename, string FolderId, DateOnly CapturedOn, int Rating,
        double GeoX, double GeoY, byte R, byte G, byte B);

    /// <summary>The shared fictional catalog: a wedding photographer's
    /// library spanning one wedding shoot, a landscape road trip, and a
    /// studio session — reused verbatim by every page that needs "a
    /// library" rather than each page inventing its own unrelated mock
    /// set. See the type docs above for why this stays WinUI-free.</summary>
    public static class MuiPageMockLibrary
    {
        public static readonly IReadOnlyList<MuiMockFolder> Folders = new[]
        {
            new MuiMockFolder("wedding", "Ridgeline Farm Wedding", "folder", null),
            new MuiMockFolder("wedding-ceremony", "Ceremony", "folder", "wedding"),
            new MuiMockFolder("wedding-reception", "Reception", "folder", "wedding"),
            new MuiMockFolder("iceland", "Iceland Roadtrip 2026", "map-pin", null),
            new MuiMockFolder("studio", "Studio Portraits", "camera", null),
        };

        public static readonly IReadOnlyList<MuiMockAsset> Assets = new[]
        {
            new MuiMockAsset("a-4181", "DSC_4181.dng", "wedding-ceremony", new DateOnly(2026, 6, 12), 5, 0.52, 0.30, 0x8B, 0x6A, 0x4E),
            new MuiMockAsset("a-4182", "DSC_4182.dng", "wedding-ceremony", new DateOnly(2026, 6, 12), 4, 0.53, 0.31, 0x9A, 0x77, 0x58),
            new MuiMockAsset("a-4183", "DSC_4183.dng", "wedding-ceremony", new DateOnly(2026, 6, 12), 5, 0.54, 0.30, 0x88, 0x63, 0x47),
            new MuiMockAsset("a-4210", "DSC_4210.dng", "wedding-reception", new DateOnly(2026, 6, 12), 3, 0.55, 0.33, 0x6E, 0x4F, 0x7A),
            new MuiMockAsset("a-4211", "DSC_4211.dng", "wedding-reception", new DateOnly(2026, 6, 12), 4, 0.56, 0.34, 0x75, 0x55, 0x82),
            new MuiMockAsset("a-4213", "DSC_4213.dng", "wedding-reception", new DateOnly(2026, 6, 12), 5, 0.57, 0.33, 0x6A, 0x4A, 0x76),
            new MuiMockAsset("a-5050", "DSC_5050.dng", "iceland", new DateOnly(2026, 7, 3), 5, 0.18, 0.62, 0x3E, 0x5C, 0x6E),
            new MuiMockAsset("a-5051", "DSC_5051.dng", "iceland", new DateOnly(2026, 7, 4), 4, 0.21, 0.58, 0x46, 0x66, 0x77),
            new MuiMockAsset("a-5052", "DSC_5052.dng", "iceland", new DateOnly(2026, 7, 4), 3, 0.24, 0.55, 0x39, 0x52, 0x63),
            new MuiMockAsset("a-5053", "DSC_5053.dng", "iceland", new DateOnly(2026, 7, 6), 5, 0.30, 0.49, 0x4F, 0x70, 0x80),
            new MuiMockAsset("a-6001", "DSC_6001.dng", "studio", new DateOnly(2026, 5, 20), 4, 0.70, 0.20, 0x7A, 0x6E, 0x62),
            new MuiMockAsset("a-6002", "DSC_6002.dng", "studio", new DateOnly(2026, 5, 20), 5, 0.71, 0.21, 0x83, 0x76, 0x69),
        };

        /// <summary>Every leaf/root folder id an asset can carry counted
        /// from the live asset list, plus each parent folder's own count
        /// rolled up from its children — what a real Sidebar's badge
        /// counts would come from, rather than a hand-maintained number
        /// that could drift from the asset list above.</summary>
        public static int CountFor(string folderId)
        {
            var direct = Assets.Count(a => a.FolderId == folderId);
            var childIds = Folders.Where(f => f.ParentId == folderId).Select(f => f.Id).ToList();
            return direct + childIds.Sum(CountFor);
        }
    }
}

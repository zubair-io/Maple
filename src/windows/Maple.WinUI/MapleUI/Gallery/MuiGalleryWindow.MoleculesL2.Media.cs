using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>Media-cell-family specimens for the Molecules L2 gallery
    /// page (wave N4, #3012) — see MuiGalleryWindow.MoleculesL2.cs for the
    /// section split rationale. MediaCell, Card, FilmstripRow,
    /// FilmstripRail — every specimen here is fully live: rating/flag
    /// clicks, rename commits, and filmstrip selection all mutate the
    /// actual control state rather than a static snapshot, since each of
    /// these controls owns its own two-way properties.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2MediaSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Media"));

            AddSpecimen(panel, "Media Cell", "Thumbnail with badges, rating, selection, inline rename.", Row(
                new MuiMediaCell
                {
                    Source = SolidBitmap(0x3A, 0x7C, 0xA8),
                    Alt = "Harbor at dusk",
                    Filename = "IMG_0231.dng",
                    Badges = new[] { "RAW" },
                },
                new MuiMediaCell
                {
                    Source = SolidBitmap(0x4A, 0x8C, 0x5E),
                    Alt = "Trailhead",
                    Filename = "IMG_0244.dng",
                    Selected = true,
                    Rating = 4,
                    Flag = MuiRatingFlagState.Pick,
                    Badges = new[] { "RAW", "PANO" },
                },
                new MuiMediaCell
                {
                    Source = SolidBitmap(0xC4, 0x49, 0x3A),
                    Alt = "Studio test shot",
                    Filename = "IMG_0250.dng",
                    Flag = MuiRatingFlagState.Reject,
                }));

            AddSpecimen(panel, "Card", "Image + title + metadata tile.", Row(
                new MuiCard
                {
                    Width = 220,
                    Source = SolidBitmap(0x9C, 0x6A, 0xC4),
                    Alt = "Kyoto template",
                    Title = "Golden Hour Portrait",
                    Subtitle = "12 photos · Updated 2d ago",
                    BadgeLabel = "12",
                },
                new MuiCard
                {
                    Width = 220,
                    Source = SolidBitmap(0xB8, 0x8A, 0x3A),
                    Alt = "Desert template",
                    Title = "Desert Minimal",
                    Subtitle = "No overrides",
                }));

            AddSpecimen(panel, "Filmstrip Row", "Horizontal scrolling thumbnails, selection follows activeId.",
                BuildFilmstripRowDemo());

            AddSpecimen(panel, "Filmstrip Rail", "Collapsible vertical thumbnails, same active-follow contract.",
                BuildFilmstripRailDemo());
        }

        private static IReadOnlyList<MuiFilmstripItem> FilmstripDemoItems() => new[]
        {
            new MuiFilmstripItem("f1", SolidBitmap(0x3A, 0x7C, 0xA8), "Frame 1"),
            new MuiFilmstripItem("f2", SolidBitmap(0x4A, 0x8C, 0x5E), "Frame 2"),
            new MuiFilmstripItem("f3", SolidBitmap(0xC4, 0x49, 0x3A), "Frame 3"),
            new MuiFilmstripItem("f4", SolidBitmap(0xB8, 0x8A, 0x3A), "Frame 4"),
            new MuiFilmstripItem("f5", SolidBitmap(0x9C, 0x6A, 0xC4), "Frame 5"),
        };

        private static UIElement BuildFilmstripRowDemo() =>
            new MuiFilmstripRow { Items = FilmstripDemoItems(), ActiveId = "f2" };

        private static UIElement BuildFilmstripRailDemo() =>
            new MuiFilmstripRail { Items = FilmstripDemoItems(), ActiveId = "f3", Height = 260 };
    }
}

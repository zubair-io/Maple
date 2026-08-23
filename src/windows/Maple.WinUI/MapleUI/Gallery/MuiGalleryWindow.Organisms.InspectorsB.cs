using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.3 Inspectors gallery specimens, part 2 (Film
    /// Panel, Presets Panel, Scopes Panel, Backlinks Panel, Version
    /// History Panel, Thread Panel) — wave N6 (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsInspectorsBSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Film Panel", "Category Chip Row + look Cards + Strength slider.", TemplateFrame(
                new MuiFilmPanel
                {
                    Categories = new[] { new MuiChip("all", "All"), new MuiChip("bw", "Black & white") },
                    SelectedCategoryId = "all",
                    Looks = new[] { new MuiFilmLook("kodak", "all", "Kodak Portra"), new MuiFilmLook("trix", "bw", "Tri-X 400") },
                    SelectedLookId = "kodak",
                    Strength = 80,
                }, 320, 260));

            AddSpecimen(panel, "Presets Panel", "Saved presets with Apply/Delete, save-as Dialog.", TemplateFrame(
                new MuiPresetsPanel
                {
                    Presets = new[]
                    {
                        new MuiPreset("p1", "Moody portrait", DateTimeOffset.Now.AddDays(-3)),
                        new MuiPreset("p2", "Bright & airy", DateTimeOffset.Now.AddDays(-20)),
                    },
                }, 260, 200));

            AddSpecimen(panel, "Scopes Panel", "Pinned four-up Histogram/Waveform/Parade/Vectorscope.", TemplateFrame(
                new MuiScopesPanel
                {
                    RedValues = SampleHistogramLane(1.05),
                    GreenValues = SampleHistogramLane(1.0),
                    BlueValues = SampleHistogramLane(0.9),
                    LumaValues = SampleHistogramLane(1.0),
                    Samples = SampleVectorscopeSamples(),
                }, 340, 240));

            AddSpecimen(panel, "Backlinks Panel", "Inbound references, or an Empty State.", Row(
                TemplateFrame(new MuiBacklinksPanel { Backlinks = new[] { new MuiBacklink("b1", "Wedding board — Card #12", "grid-sm") } }, 220, 90),
                TemplateFrame(new MuiBacklinksPanel { Backlinks = Array.Empty<MuiBacklink>() }, 220, 90)));

            AddSpecimen(panel, "Version History Panel", "Restorable versions, current marked, confirm Dialog.", TemplateFrame(
                new MuiVersionHistoryPanel
                {
                    Versions = new[]
                    {
                        new MuiAssetVersion("v3", "Current edit", DateTimeOffset.Now, IsCurrent: true),
                        new MuiAssetVersion("v2", "Before crop", DateTimeOffset.Now.AddHours(-2)),
                        new MuiAssetVersion("v1", "Import", DateTimeOffset.Now.AddDays(-1)),
                    },
                }, 300, 180));

            AddSpecimen(panel, "Thread Panel", "Reply thread — Chat Message list + composer.", TemplateFrame(
                new MuiThreadPanel
                {
                    Replies = new[]
                    {
                        new MuiThreadReply("Ada", "Can we brighten the shadows a touch?", DateTimeOffset.Now.AddMinutes(-12)),
                        new MuiThreadReply("You", "Done — pushed +15.", DateTimeOffset.Now.AddMinutes(-8), Own: true),
                    },
                }, 300, 260));
        }

        private static IReadOnlyList<MuiVectorscopeSample> SampleVectorscopeSamples()
        {
            var samples = new List<MuiVectorscopeSample>();
            for (var i = 0; i < 24; i++)
            {
                var t = i / 24.0 * Math.PI * 2;
                samples.Add(new MuiVectorscopeSample(0.5 + 0.4 * Math.Cos(t), 0.5 + 0.4 * Math.Sin(t), 0.5));
            }
            return samples;
        }
    }
}

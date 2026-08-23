using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Enrichment-panel-family specimens for the Molecules L2
    /// gallery page (wave N4, #3012) — see MuiGalleryWindow.MoleculesL2.cs
    /// for the section split rationale. SettingsRow, EmbedShell,
    /// DescriptionField, TranscriptBlock, FacesRow, PlaceRow.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2EnrichmentSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Enrichment"));

            AddSpecimen(panel, "Settings Row", "Collapsible labeled setting.", Column(
                new MuiSettingsRow
                {
                    Label = "Auto-import",
                    IconName = "folder",
                    Description = "Watch this folder and import new RAWs automatically.",
                    RowContent = new MuiText { Text = "Interval: 5 minutes", Variant = MuiTextVariant.Body },
                    IsExpanded = true,
                },
                new MuiSettingsRow { Label = "Cloud sync", IconName = "share-up-square", ShowDivider = false }));

            AddSpecimen(panel, "Embed Shell", "Frame for embedded content — header, status, loading bar.",
                new MuiEmbedShell
                {
                    Title = "Live recording",
                    StatusIconName = "history",
                    StatusLabel = "Recording",
                    IsLoading = true,
                    BodyContent = new MuiText { Text = "Embedded content renders here.", Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted },
                });

            AddSpecimen(panel, "Description Field", "Text with override and regenerate.", Column(
                new MuiDescriptionField { Value = "A quiet harbor at dusk, warm light on the water." },
                new MuiDescriptionField { Regenerating = true }));

            AddSpecimen(panel, "Transcript Block", "Timestamped read-only transcript.",
                new MuiTranscriptBlock
                {
                    BaseTime = new DateTimeOffset(2026, 8, 22, 9, 0, 0, TimeSpan.Zero),
                    Entries = new[]
                    {
                        new MuiTranscriptEntry("t1", 0, "Ada", "Let's start with the harbor set."),
                        new MuiTranscriptEntry("t2", 4200, "Grace", "Agreed — those are the strongest frames."),
                        new MuiTranscriptEntry("t3", 9100, null, "[pause]"),
                    },
                });

            AddSpecimen(panel, "Faces Row", "Count, person chips, re-detect.", Column(
                new MuiFacesRow
                {
                    People = new[] { new MuiChip("ada", "Ada"), new MuiChip("grace", "Grace") },
                },
                new MuiFacesRow { People = Array.Empty<MuiChip>(), Redetecting = true }));

            AddSpecimen(panel, "Place Row", "Geocoded place with override.", Column(
                new MuiPlaceRow { Place = "Golden Gate Park, San Francisco" },
                new MuiPlaceRow { Place = "Custom label", Overridden = true }));
        }
    }
}

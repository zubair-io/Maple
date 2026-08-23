using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.3 Inspectors gallery specimens, part 1
    /// (Inspector Panel, Info Panel, Enrichment Panel, Adjustments Panel,
    /// Color Grading Panel, HSL Panel, Tone Curve Panel) — wave N6
    /// (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsInspectorsSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Inspector Panel", "Tabbed shell every other §4.3 panel mounts inside.", TemplateFrame(
                new MuiInspectorPanel
                {
                    Title = "DSC_1042.dng",
                    Tabs = new[] { new MuiTab("info", "Info"), new MuiTab("adjust", "Adjust") },
                    ActiveTabId = "info",
                    TabContents = new Dictionary<string, UIElement>
                    {
                        ["info"] = new MuiText { Text = "Info tab content", Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted },
                        ["adjust"] = new MuiText { Text = "Adjust tab content", Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted },
                    },
                }, 320, 260));

            AddSpecimen(panel, "Info Panel", "Filename, rating, histogram, EXIF, keywords.", TemplateFrame(
                new MuiInfoPanel
                {
                    Filename = "DSC_1042.dng",
                    Rating = 4,
                    Flag = MuiRatingFlagState.Pick,
                    RedValues = SampleHistogramLane(1.05),
                    GreenValues = SampleHistogramLane(1.0),
                    BlueValues = SampleHistogramLane(0.9),
                    ExifRows = new[] { new MuiLabelValueRow("Camera", "DJI Mavic 3 Pro"), new MuiLabelValueRow("ISO", "100"), new MuiLabelValueRow("Aperture", "f/2.8") },
                    Keywords = new[] { new MuiChip("k1", "sunset"), new MuiChip("k2", "coastline") },
                }, 320, 420));

            AddSpecimen(panel, "Enrichment Panel", "AI-derived fields with a live status Badge.", TemplateFrame(
                new MuiEnrichmentPanel
                {
                    Description = "A coastal sunset with silhouetted cliffs.",
                    People = new[] { new MuiChip("p1", "Ada") },
                    Place = "Big Sur, California",
                    VisionLabels = new[] { new MuiChip("v1", "sunset"), new MuiChip("v2", "ocean") },
                    StatusLabel = "model: qwen2.5-vl",
                }, 320, 380));

            AddSpecimen(panel, "Adjustments Panel", "Tabs + Collapsible groups of Living Sliders.", TemplateFrame(
                new MuiAdjustmentsPanel
                {
                    ActiveCategoryId = "basic",
                    Categories = new[]
                    {
                        new MuiAdjustmentCategory("basic", "Basic", new[]
                        {
                            new MuiAdjustmentGroup("light", "Light", new[]
                            {
                                new MuiAdjustmentSlider("exposure", "Exposure", 0.3, -5, 5, 0.1, "EV", true),
                                new MuiAdjustmentSlider("contrast", "Contrast", 12, -100, 100, 1, "", true),
                                new MuiAdjustmentSlider("highlights", "Highlights", -30, -100, 100, 1, "", true),
                            }),
                            new MuiAdjustmentGroup("color", "Color", new[]
                            {
                                new MuiAdjustmentSlider("vibrance", "Vibrance", 18, -100, 100, 1, "", true),
                                new MuiAdjustmentSlider("saturation", "Saturation", 0, -100, 100, 1, "", true),
                            }),
                        }),
                        new MuiAdjustmentCategory("detail", "Detail", new[]
                        {
                            new MuiAdjustmentGroup("sharpen", "Sharpening", new[] { new MuiAdjustmentSlider("sharpen", "Sharpen", 40, 0, 150) }),
                        }),
                    },
                }, 320, 380));

            AddSpecimen(panel, "Color Grading Panel", "Shadows / Midtones / Highlights color wheels.", TemplateFrame(
                new MuiColorGradingPanel { Shadows = new MuiColorWheelValue(220, 30), Highlights = new MuiColorWheelValue(45, 20) }, 560, 260));

            AddSpecimen(panel, "HSL Panel", "8-band Chip Row + Hue/Sat/Luminance sliders.", TemplateFrame(
                new MuiHslPanel { SelectedBand = "orange", Values = new Dictionary<string, MuiHslBandValue> { ["orange"] = new(0, 15, -5) } }, 320, 260));

            AddSpecimen(panel, "Tone Curve Panel", "Channel Tabs + Curve Plot + parametric sliders.", TemplateFrame(
                new MuiToneCurvePanel { ActiveChannel = "rgb", Highlights = -10, Shadows = 8 }, 320, 460));
        }

        private static IReadOnlyList<double> SampleHistogramLane(double scale)
        {
            var values = new double[32];
            for (var i = 0; i < values.Length; i++)
                values[i] = scale * (0.15 + 0.85 * System.Math.Pow(System.Math.Sin(i / 31.0 * System.Math.PI), 2));
            return values;
        }
    }
}

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.5 Editing gallery specimens, part 1 (Image
    /// Canvas, Crop Overlay, Crop Toolbar, Control Surface, Mobile
    /// Control Bar) — wave N6 second push (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsEditingSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Image Canvas", "Wheel-zoom, drag-pan, before/after toggle.", TemplateFrame(
                new MuiImageCanvas
                {
                    Source = SolidBitmap(90, 130, 200),
                    ImageWidth = 320,
                    ImageHeight = 220,
                    Zoom = 1.0,
                }, 340, 240));

            AddSpecimen(panel, "Crop Overlay", "8 handles, rule-of-thirds grid, mask.", TemplateFrame(
                new MuiCropOverlay { Bounds = new Size(300, 200), Rect = new MuiCropRect(40, 30, 220, 140) }, 300, 200));

            AddSpecimen(panel, "Crop Toolbar", "Aspect presets, straighten drag bar, rotate/flip/reset.",
                new MuiCropToolbar { SelectedAspectId = "4:5", StraightenAngle = 2.5 });

            AddSpecimen(panel, "Control Surface", "Armed tool's sliders + value chip summary.", TemplateFrame(
                new MuiControlSurface
                {
                    ToolLabel = "Exposure",
                    ValueChips = new[] { new MuiControlSurfaceValueChip("Exposure", "+0.3") },
                    Sliders = new[]
                    {
                        new MuiAdjustmentSlider("exposure", "Exposure", 0.3, -5, 5, 0.1, "EV", true),
                        new MuiAdjustmentSlider("contrast", "Contrast", 12, -100, 100, 1, "", true),
                    },
                }, 280, 200));

            AddSpecimen(panel, "Mobile Control Bar", "Phone-width Control Surface + Tabs + horizontal Tool Dock.", TemplateFrame(
                new MuiMobileControlBar
                {
                    ToolLabel = "Exposure",
                    Sliders = new[] { new MuiAdjustmentSlider("exposure", "Exposure", 0.3, -5, 5, 0.1, "EV", true) },
                    ModeTabs = new[] { new MuiTab("basic", "Basic"), new MuiTab("detail", "Detail") },
                    ActiveModeId = "basic",
                    ToolGroups = new[] { new MuiToolDockGroup(new[] { new MuiToolDockItem("crop", "tool-crop", "Crop"), new MuiToolDockItem("exposure", "tool-exposure", "Light") }) },
                    SelectedToolId = "exposure",
                }, 280, 320));
        }
    }
}

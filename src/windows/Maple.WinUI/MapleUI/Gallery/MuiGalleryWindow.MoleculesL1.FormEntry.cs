using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>§2.1 Form &amp; entry specimens for the Molecules L1 gallery
    /// page — see MuiGalleryWindow.MoleculesL1.cs for the section split
    /// rationale. FormField, InlineRenameField, SearchBar, Slider,
    /// LivingSlider, DragBar, ColorWheel, Pad2D.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildFormEntrySpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Form & entry"));

            AddSpecimen(panel, "Form Field", "Label + control + help/error.", Column(
                new MuiFormField
                {
                    Label = "Display name",
                    ControlContent = new MuiInput { Placeholder = "Ada Lovelace" },
                    Help = "Shown on your public profile.",
                },
                new MuiFormField
                {
                    Label = "API key",
                    Required = true,
                    ControlContent = new MuiInput { Placeholder = "sk-..." },
                    Error = "This field is required",
                }));

            AddSpecimen(panel, "Inline Rename Field", "Edit-in-place name.", Row(
                new MuiInlineRenameField { Value = "Golden Hour Portraits" },
                new MuiInlineRenameField { Value = "Locked album", IsEnabled = false }));

            AddSpecimen(panel, "Search Bar", "Query pill with clear.", Column(
                new MuiSearchBar { Placeholder = "Search library" },
                new MuiSearchBar { Value = "sunset", ActionLabel = "Filters", ActionIconName = "filter" }));

            AddSpecimen(panel, "Slider", "Labeled slider with numeric readout.", Column(
                new MuiSlider { Width = 240, Label = "Clarity", Value = 25, Minimum = -100, Maximum = 100 },
                new MuiSlider { Width = 240, Label = "Grain amount", Value = 60, Minimum = 0, Maximum = 100, IsEnabled = false }));

            AddSpecimen(panel, "Living Slider", "Gradient-track slider.", Column(
                new MuiLivingSlider { Width = 240, Label = "Temperature", Value = -18, Minimum = -100, Maximum = 100, Bipolar = true },
                new MuiLivingSlider { Width = 240, Label = "Exposure", Value = 35, Minimum = -100, Maximum = 100 }));

            AddSpecimen(panel, "Drag Bar", "Tick-marked scrub control.", Column(
                new MuiDragBar { Width = 240, Label = "Straighten", Value = 4 },
                new MuiDragBar { Width = 240, Value = -30 }));

            AddSpecimen(panel, "Color Wheel", "Draggable hue/saturation puck.", Row(
                new MuiColorWheel { Hue = 0, Saturation = 0, AccessibleLabel = "Shadows" },
                new MuiColorWheel { Hue = 205, Saturation = 55, AccessibleLabel = "Highlights" }));

            AddSpecimen(panel, "2-D Pad", "Two-axis draggable puck.", Row(
                new MuiPad2D { XValue = 0, YValue = 0, AccessibleLabel = "Split tone balance" },
                new MuiPad2D { XValue = 40, YValue = -25 }));
        }
    }
}

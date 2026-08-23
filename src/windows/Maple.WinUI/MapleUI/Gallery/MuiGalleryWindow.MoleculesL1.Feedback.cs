using System.Collections.Generic;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>§2.3 Feedback &amp; messaging specimens for the Molecules
    /// L1 gallery page — see MuiGalleryWindow.MoleculesL1.cs for the
    /// section split rationale. Banner, ToastContainer, EmptyState,
    /// ValueChip, ValueHud, FrameTimeHud.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildFeedbackSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Feedback & messaging"));

            AddSpecimen(panel, "Banner", "Inline status strip.", Column(
                new MuiBanner
                {
                    Variant = MuiBannerVariant.Info,
                    Message = "Your library is syncing in the background.",
                    LinkLabel = "Learn more",
                    LinkHref = "maple-app://sync",
                },
                new MuiBanner
                {
                    Variant = MuiBannerVariant.Warning,
                    Message = "Storage is almost full.",
                    ActionLabel = "Manage",
                    Dismissible = true,
                },
                new MuiBanner { Variant = MuiBannerVariant.Error, Message = "Couldn't reach the server." }));

            AddSpecimen(panel, "Toast Container", "Stacks and positions toasts.", new MuiToastContainer
            {
                Inline = true,
                Toasts = new List<MuiToastEntry>
                {
                    new("1", MuiToastVariant.Success, "Export complete.", "Reveal"),
                    new("2", MuiToastVariant.Warning, "3 files were skipped (duplicates)."),
                },
            });

            AddSpecimen(panel, "Empty State", "Icon, title, message, optional action.", new MuiEmptyState
            {
                IconName = "photos",
                Title = "No photos yet",
                Message = "Import a folder or connect a source to get started.",
                ActionLabel = "Import photos",
            });

            AddSpecimen(panel, "Value Chip", "Floating value readout during a drag.", Row(
                new MuiValueChip { Label = "Exposure", Value = "+0.8" },
                new MuiValueChip { Label = "Temp", Value = "5200K" }));

            AddSpecimen(panel, "Value HUD", "Center-screen scrub overlay.", new MuiValueHud
            {
                Label = "ZOOM",
                Value = "142%",
                ProgressPct = 62,
            });

            AddSpecimen(panel, "Frame-time HUD", "Performance readout, 16/50ms budget color-coding.", Column(
                new MuiFrameTimeHud { FrameMs = 11.2 },
                new MuiFrameTimeHud { FrameMs = 28.5 },
                new MuiFrameTimeHud { FrameMs = 62.9 }));
        }
    }
}

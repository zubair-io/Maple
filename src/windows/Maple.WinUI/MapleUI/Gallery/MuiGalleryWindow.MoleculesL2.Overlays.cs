using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Overlay-family specimens for the Molecules L2 gallery page
    /// (wave N4, #3012) — see MuiGalleryWindow.MoleculesL2.cs for the
    /// section split rationale. Dialog, Todo Popover, Event Popover.
    ///
    /// Same "wire a real trigger that toggles IsOpen live" contract
    /// MuiGalleryWindow.MoleculesL1.Overlays.cs's own doc comment explains
    /// for every Popover-composing molecule: a Popup positioned before this
    /// window's content tree has a XamlRoot has nothing to anchor/scrim
    /// against yet.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2OverlaySpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Overlays"));

            AddSpecimen(panel, "Dialog", "Modal prompt/confirm/choice — token-styled scrim, no ContentDialog.",
                Row(BuildConfirmDialogDemo(), BuildPromptDialogDemo()));

            AddSpecimen(panel, "Todo Popover", "Task attribute editor — title, priority, due date.",
                BuildTodoPopoverDemo());

            AddSpecimen(panel, "Event Popover", "Calendar event create/edit — title, time, delete/save.",
                BuildEventPopoverDemo());
        }

        private static UIElement BuildConfirmDialogDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Destructive, Label = "Delete photo…" };
            var dialog = new MuiDialog
            {
                Title = "Delete this photo?",
                Message = "The original file moves to Trash and can be restored within 30 days.",
                Variant = MuiDialogVariant.Confirm,
                ConfirmLabel = "Delete",
                Destructive = true,
            };
            trigger.Click += (_, _) => dialog.IsOpen = true;
            dialog.Confirmed += (_, _) => dialog.IsOpen = false;
            dialog.Dismissed += (_, _) => dialog.IsOpen = false;
            return AnchoredDemo(trigger, dialog);
        }

        private static UIElement BuildPromptDialogDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Rename album…" };
            var dialog = new MuiDialog
            {
                Title = "Rename album",
                Variant = MuiDialogVariant.Prompt,
                PromptPlaceholder = "Album name",
                PromptValue = "Golden Hour Portraits",
                ConfirmLabel = "Rename",
            };
            trigger.Click += (_, _) => dialog.IsOpen = true;
            dialog.Confirmed += (_, _) => dialog.IsOpen = false;
            dialog.Dismissed += (_, _) => dialog.IsOpen = false;
            return AnchoredDemo(trigger, dialog);
        }

        private static UIElement BuildTodoPopoverDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Edit task", IconName = "tag" };
            var popover = new MuiTodoPopover { Title = "Cull the wedding set", DueLabel = "Fri" };
            trigger.Click += (_, _) => popover.IsOpen = !popover.IsOpen;
            popover.CloseRequested += (_, _) => popover.IsOpen = false;
            popover.Saved += (_, _) => popover.IsOpen = false;
            return AnchoredDemo(trigger, popover);
        }

        private static UIElement BuildEventPopoverDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Edit event", IconName = "history" };
            var popover = new MuiEventPopover { Title = "Design review", TimeLabel = "3:00 PM" };
            trigger.Click += (_, _) => popover.IsOpen = !popover.IsOpen;
            popover.CloseRequested += (_, _) => popover.IsOpen = false;
            popover.Saved += (_, _) => popover.IsOpen = false;
            popover.Deleted += (_, _) => popover.IsOpen = false;
            return AnchoredDemo(trigger, popover);
        }
    }
}

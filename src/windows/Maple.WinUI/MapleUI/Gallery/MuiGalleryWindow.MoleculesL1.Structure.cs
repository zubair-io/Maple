using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>§2.5 Structure specimens for the Molecules L1 gallery page
    /// (wave N3b, #3012) — see MuiGalleryWindow.MoleculesL1.cs for the
    /// section split rationale. Collapsible, PageHeader, Toolbar,
    /// BubbleMenu, LabelValueGrid, AvatarGroup.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildStructureSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Structure"));

            AddSpecimen(panel, "Collapsible", "Disclosure header + animated content region.", Column(
                new MuiCollapsible
                {
                    Label = "Advanced settings",
                    IsExpanded = true,
                    BodyContent = new MuiText { Text = "Body content shown while expanded.", Variant = MuiTextVariant.Body },
                },
                new MuiCollapsible
                {
                    Label = "Danger zone",
                    IsExpanded = false,
                    BodyContent = new MuiText { Text = "Collapsed by default.", Variant = MuiTextVariant.Body },
                }));

            AddSpecimen(panel, "Page Header", "Title bar with back and actions.", Column(
                new MuiPageHeader
                {
                    Title = "Japan 2026",
                    ShowBack = true,
                    ShowMore = true,
                    TrailingContent = new MuiActionButton { IconName = "share-up-square", Label = "Share", ButtonSize = MuiActionButtonSize.Sm },
                },
                new MuiPageHeader { Title = "Settings", ShowBack = false }));

            AddSpecimen(panel, "Toolbar", "Row of actions with overflow.", new MuiToolbar
            {
                MaxVisible = 3,
                Entries = new List<MuiToolbarEntry>
                {
                    MuiToolbarEntry.For(new MuiToolbarItem("exposure", "tool-exposure", "Exposure")),
                    MuiToolbarEntry.For(new MuiToolbarItem("contrast", "tool-contrast", "Contrast")),
                    MuiToolbarEntry.Divider(),
                    MuiToolbarEntry.For(new MuiToolbarItem("crop", "tool-crop", "Crop")),
                    MuiToolbarEntry.For(new MuiToolbarItem("sharpen", "tool-sharpen", "Sharpen")),
                    MuiToolbarEntry.For(new MuiToolbarItem("dehaze", "tool-dehaze", "Dehaze", Disabled: true)),
                },
            });

            AddSpecimen(panel, "Bubble Menu", "Floating contextual format bar.", BuildBubbleMenuDemo());

            AddSpecimen(panel, "Label-Value Grid", "Two-column metadata grid.", new MuiLabelValueGrid
            {
                Rows = new List<MuiLabelValueRow>
                {
                    new("Camera", "Sony A7R V"),
                    new("Lens", "24-70mm f/2.8"),
                    new("ISO", "400"),
                    new("Aperture", "f/8"),
                },
            });

            AddSpecimen(panel, "Avatar Group", "Overlapping avatars with overflow.", Row(
                new MuiAvatarGroup
                {
                    Max = 3,
                    Avatars = new List<MuiAvatarGroupMember>
                    {
                        new("Ada Lovelace"),
                        new("Grace Hopper"),
                        new("Cher"),
                        new("Grimes"),
                        new("Björk"),
                    },
                },
                new MuiAvatarGroup
                {
                    Max = 4,
                    AvatarGroupSize = MuiAvatarSize.Md,
                    Avatars = new List<MuiAvatarGroupMember> { new("Ada Lovelace"), new("Grace Hopper") },
                }));
        }

        private UIElement BuildBubbleMenuDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Select text…" };
            var menu = new MuiBubbleMenu
            {
                Entries = new List<MuiBubbleMenuEntry>
                {
                    MuiBubbleMenuEntry.For(new MuiBubbleMenuItem("keyword", "tag", "Tag", Active: true)),
                    MuiBubbleMenuEntry.For(new MuiBubbleMenuItem("flag", "flag", "Flag")),
                    MuiBubbleMenuEntry.Divider(),
                    MuiBubbleMenuEntry.For(new MuiBubbleMenuItem("copy", "copy", "Copy")),
                },
            };
            trigger.Click += (_, _) => menu.IsOpen = !menu.IsOpen;
            menu.CloseRequested += (_, _) => menu.IsOpen = false;
            return AnchoredDemo(trigger, menu);
        }
    }
}

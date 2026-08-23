using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>§2.4 Overlays &amp; menus specimens for the Molecules L1
    /// gallery page (wave N3b, #3012) — see MuiGalleryWindow.MoleculesL1.cs
    /// for the section split rationale. Popover, ContextMenu,
    /// SuggestionMenu, CommandMenu.
    ///
    /// Every one of these composes <see cref="MuiPopover"/>, which anchors
    /// itself off ITS OWN layout rect at open time (see MuiPopover.cs's own
    /// doc comment) — so every demo here wires a real trigger
    /// <see cref="MuiButton"/> that toggles <c>IsOpen</c> live, rather than
    /// starting a specimen pre-opened: a Popup positioned before this
    /// window's content tree has a <c>XamlRoot</c> has nothing to anchor
    /// against yet, so these are the one specimen family in this gallery
    /// meant to be clicked, not just looked at.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOverlaySpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Overlays & menus"));

            AddSpecimen(panel, "Popover", "Anchored floating container — the positioning primitive every menu below composes.",
                BuildPopoverDemo());

            AddSpecimen(panel, "Context Menu", "Keyboard-navigable action list.", BuildContextMenuDemo());

            AddSpecimen(panel, "Suggestion Menu", "Query-driven autocomplete list.", BuildSuggestionMenuDemo());

            AddSpecimen(panel, "Command Menu", "Searchable command palette.", BuildCommandMenuDemo());
        }

        private UIElement BuildPopoverDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Toggle popover" };
            var popover = new MuiPopover
            {
                PanelContent = new MuiText
                {
                    Text = "Anchored floating panel — dismisses on an outside click or Escape.",
                    Variant = MuiTextVariant.Body,
                    LineClamp = 3,
                },
            };
            trigger.Click += (_, _) => popover.IsOpen = !popover.IsOpen;
            popover.CloseRequested += (_, _) => popover.IsOpen = false;
            return AnchoredDemo(trigger, popover);
        }

        private UIElement BuildContextMenuDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Actions", IconName = "chevron-down" };
            var menu = new MuiContextMenu
            {
                Entries = new List<MuiContextMenuEntry>
                {
                    MuiContextMenuEntry.For(new MuiContextMenuItem("rename", "Rename", "edit")),
                    MuiContextMenuEntry.For(new MuiContextMenuItem("duplicate", "Duplicate", "copy")),
                    MuiContextMenuEntry.For(new MuiContextMenuItem("share", "Share…", "share-up-square", Disabled: true)),
                    MuiContextMenuEntry.Divider(),
                    MuiContextMenuEntry.For(new MuiContextMenuItem("delete", "Delete", "clear-circle-fill", Destructive: true)),
                },
            };
            trigger.Click += (_, _) => menu.IsOpen = !menu.IsOpen;
            menu.CloseRequested += (_, _) => menu.IsOpen = false;
            menu.ItemSelected += (_, _) => menu.IsOpen = false;
            return AnchoredDemo(trigger, menu);
        }

        private UIElement BuildSuggestionMenuDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "@mention" };
            var menu = new MuiSuggestionMenu
            {
                Items = new List<MuiSuggestionItem>
                {
                    new("ada", "Ada Lovelace", "person-circle", "Owner"),
                    new("grace", "Grace Hopper", "person-circle", "Editor"),
                    new("cher", "Cher", "person-circle"),
                },
            };
            trigger.Click += (_, _) => menu.IsOpen = !menu.IsOpen;
            menu.CloseRequested += (_, _) => menu.IsOpen = false;
            menu.ItemSelected += (_, _) => menu.IsOpen = false;
            return AnchoredDemo(trigger, menu);
        }

        private UIElement BuildCommandMenuDemo()
        {
            var trigger = new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Commands", IconName = "search" };
            var menu = new MuiCommandMenu
            {
                Commands = new List<MuiCommandItem>
                {
                    new("export", "Export selected…", "export", "⌘E"),
                    new("batch-rename", "Batch rename…", "edit"),
                    new("reveal", "Reveal in Finder", "folder-open"),
                    new("presets", "Apply preset…", "tool-presets"),
                },
            };
            trigger.Click += (_, _) => menu.IsOpen = !menu.IsOpen;
            menu.CloseRequested += (_, _) => menu.IsOpen = false;
            menu.ItemSelected += (_, _) => menu.IsOpen = false;
            return AnchoredDemo(trigger, menu);
        }
    }
}

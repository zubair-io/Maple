using System.Collections.Generic;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>§2.2 Selection specimens for the Molecules L1 gallery page
    /// — see MuiGalleryWindow.MoleculesL1.cs for the section split
    /// rationale. ChipRow, Tabs, TreeRow, ListRow, RatingFlags.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildSelectionSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Selection"));

            AddSpecimen(panel, "Chip Row", "Select, removable, editable pills.", Column(
                new MuiChipRow
                {
                    Mode = MuiChipRowMode.Select,
                    SelectedId = "grid",
                    Chips = new List<MuiChip> { new("grid", "Grid"), new("filmstrip", "Filmstrip"), new("map", "Map") },
                },
                new MuiChipRow
                {
                    Mode = MuiChipRowMode.Removable,
                    Chips = new List<MuiChip> { new("1", "Portrait"), new("2", "Sunset") },
                },
                new MuiChipRow
                {
                    Mode = MuiChipRowMode.Editable,
                    Chips = new List<MuiChip> { new("1", "landscape") },
                    AddPlaceholder = "Add tag…",
                }));

            AddSpecimen(panel, "Tabs", "Tab row with animated selection indicator.", new MuiTabs
            {
                Width = 320,
                Tabs = new List<MuiTab> { new("light", "Light", "droplet"), new("color", "Color", "tool-color-grade"), new("detail", "Detail", "tool-sharpen") },
                ActiveId = "color",
            });

            AddSpecimen(panel, "Tree Row", "One row of a hierarchical tree.", Column(
                new MuiTreeRow { Label = "2026 Trips", Expandable = true, Expanded = true, Count = 128 },
                new MuiTreeRow { Label = "Japan", Depth = 1, Active = true, IconName = "folder-open" },
                new MuiTreeRow { Label = "Syncing…", Depth = 1, Loading = true }));

            AddSpecimen(panel, "List Row", "Row with metadata and inline actions.", Column(
                new MuiListRow
                {
                    IconName = "gear",
                    Label = "General",
                    Active = true,
                    TrailingContent = new MuiIcon { IconName = "chevron-right", Size = MuiIconSize.Sm16 },
                },
                new MuiListRow
                {
                    IconName = "person-circle",
                    Label = "Account",
                    TrailingContent = new MuiText { Text = "zubair@lawrence.io", Variant = MuiTextVariant.ValueChip },
                }));

            AddSpecimen(panel, "Rating & Flags", "Star rating plus pick/reject.", Column(
                new MuiRatingFlags { Rating = 3, Flag = MuiRatingFlagState.Pick },
                new MuiRatingFlags { Rating = 0, Flag = MuiRatingFlagState.Reject }));
        }
    }
}

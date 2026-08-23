using System.Collections.Generic;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.2 Navigation gallery specimens (Sidebar,
    /// Tool Dock, Search, Filter Panel) — wave N6 (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsNavigationSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Sidebar", "Flattened-tree source list with a right-click context menu.", TemplateFrame(
                new MuiSidebar
                {
                    Roots = new[]
                    {
                        new MuiSidebarNode("all", "All Photos", "photos", Count: 1284),
                        new MuiSidebarNode("albums", "Albums", "folder", Children: new[]
                        {
                            new MuiSidebarNode("wedding", "Wedding 2026", "folder", Count: 214),
                            new MuiSidebarNode("travel", "Travel", "folder", Count: 89),
                        }),
                    },
                    ActiveId = "wedding",
                    RowContextMenu = new[] { MuiContextMenuEntry.For(new MuiContextMenuItem("rename", "Rename")), MuiContextMenuEntry.For(new MuiContextMenuItem("delete", "Delete")) },
                }, 220, 220));

            AddSpecimen(panel, "Tool Dock", "Exclusive-select tool groups, vertical vs. horizontal.", Row(
                TemplateFrame(new MuiToolDock
                {
                    Groups = new[]
                    {
                        new MuiToolDockGroup(new[] { new MuiToolDockItem("crop", "tool-crop", "Crop"), new MuiToolDockItem("exposure", "tool-exposure", "Light") }),
                        new MuiToolDockGroup(new[] { new MuiToolDockItem("hsl", "tool-hsl", "HSL") }),
                    },
                    SelectedId = "exposure",
                }, 90, 200),
                TemplateFrame(new MuiToolDock
                {
                    Orientation = Orientation.Horizontal,
                    Groups = new[] { new MuiToolDockGroup(new[] { new MuiToolDockItem("crop", "tool-crop", "Crop"), new MuiToolDockItem("exposure", "tool-exposure", "Light") }) },
                    SelectedId = "crop",
                }, 220, 70)));

            AddSpecimen(panel, "Filter Panel", "Faceted checkboxes, summary Chip Row.", TemplateFrame(
                new MuiFilterPanel
                {
                    Facets = new[]
                    {
                        new MuiFilterFacet("camera", "Camera", new[] { new MuiFilterOption("dji", "DJI Mavic 3 Pro", 42), new MuiFilterOption("a7", "Sony A7 IV", 118) }),
                        new MuiFilterFacet("rating", "Rating", new[] { new MuiFilterOption("5", "5 stars", 12) }),
                    },
                    SelectedOptionIds = new[] { "dji" },
                }, 240, 260));

            AddSpecimen(panel, "Search", "Query + filters + results together.", TemplateFrame(
                new MuiSearch
                {
                    Query = "golden hour",
                    RecentChips = new[] { new MuiChip("r1", "sunset"), new MuiChip("r2", "portrait") },
                    Facets = new[] { new MuiFilterFacet("camera", "Camera", new[] { new MuiFilterOption("dji", "DJI Mavic 3 Pro", 42) }) },
                    Results = SampleGridItems(4),
                    ResultTotalCount = 4,
                }, 560, 360));
        }
    }
}

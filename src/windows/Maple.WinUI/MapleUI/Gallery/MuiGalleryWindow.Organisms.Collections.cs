using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.1 Collections gallery specimens (Collection
    /// Grid, List View, Timeline, Kanban Board, Filmstrip, Search
    /// Results) — wave N6 (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private static IReadOnlyList<MuiCollectionGridItem> SampleGridItems(int count) =>
            Enumerable.Range(1, count)
                .Select(i => new MuiCollectionGridItem(
                    $"g{i}", SolidBitmap((byte)(40 + i * 15 % 200), (byte)(90 + i * 9 % 150), (byte)(160 - i * 5 % 120)),
                    $"Photo {i}", $"DSC_{1000 + i}.dng",
                    Badges: i % 3 == 0 ? new[] { "RAW" } : null, Rating: i % 5))
                .ToList();

        private void BuildOrganismsCollectionsSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Collection Grid", "Virtualized-free wrap grid, click/Ctrl/Shift multi-select, drag ghost.", TemplateFrame(
                new MuiCollectionGrid { Items = SampleGridItems(8), SelectedIds = new[] { "g2", "g3" } }, 420, 260));

            AddSpecimen(panel, "List View", "Row list with the same selection semantics.", TemplateFrame(
                new MuiListView
                {
                    Items = new List<MuiListViewItem>
                    {
                        new("l1", "Kitchen renovation", "folder"),
                        new("l2", "2026 road trip", "folder"),
                        new("l3", "Family portraits", "folder"),
                    },
                    SelectedIds = new[] { "l2" },
                }, 280, 160));

            AddSpecimen(panel, "Timeline", "Date-grouped scroll with a range Chip Row.", TemplateFrame(
                new MuiTimeline
                {
                    RangeChips = new[] { new MuiChip("all", "All time"), new MuiChip("year", "This year") },
                    SelectedRangeId = "all",
                    Items = SampleGridItems(6).Select((item, i) => new MuiTimelineItem(
                        DateOnly.FromDateTime(DateTime.Today.AddDays(-(i / 3))), item)).ToList(),
                }, 460, 320));

            AddSpecimen(panel, "Kanban Board", "Drag-between-columns board with move-by-index logic.", TemplateFrame(
                new MuiKanbanBoard
                {
                    Columns = new[]
                    {
                        new MuiKanbanColumn("todo", "To cull"), new MuiKanbanColumn("doing", "Editing"), new MuiKanbanColumn("done", "Exported"),
                    },
                    Cards = new[]
                    {
                        new MuiKanbanCard("c1", "todo", "Wedding set A", "42 photos"),
                        new MuiKanbanCard("c2", "todo", "Product shoot"),
                        new MuiKanbanCard("c3", "doing", "Golden hour set"),
                        new MuiKanbanCard("c4", "done", "Portrait session"),
                    },
                }, 560, 220));

            AddSpecimen(panel, "Filmstrip", "Focus-following strip, wide row vs. collapsed rail.", Row(
                TemplateFrame(BuildFilmstripDemo(false), 320, 110),
                TemplateFrame(BuildFilmstripDemo(true), 90, 260)));

            AddSpecimen(panel, "Search Results", "Paginated result grid with a loading page state.", Row(
                TemplateFrame(new MuiSearchResults { Items = SampleGridItems(4), TotalCount = 42, Page = 1, PageCount = 4 }, 260, 220),
                TemplateFrame(new MuiSearchResults { Items = Array.Empty<MuiCollectionGridItem>(), IsLoadingPage = true, TotalCount = 0, EmptyTitle = "Searching…" }, 220, 220)));
        }

        private static UIElement BuildFilmstripDemo(bool collapsed)
        {
            var items = SampleGridItems(6).Select(g => new MuiFilmstripItem(g.Id, g.Source, g.Alt)).ToList();
            return new MuiFilmstrip { Items = items, ActiveId = items[2].Id, IsCollapsed = collapsed };
        }
    }
}

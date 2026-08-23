using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Pages;

namespace Maple.UI.Gallery
{
    /// <summary>Pages gallery page (unified-component-catalog.md §6, all
    /// 15 page compositions — Windows Pages wave, #3012). Each page sizes
    /// its own Split/App/Settings/Tab Shell against real desktop-width
    /// space (the shells' own collapse math needs real room to show
    /// anything meaningful), so every specimen renders the live page at
    /// a fixed 1280x800 design size inside a <see cref="Viewbox"/> that
    /// uniformly scales it down into a small gallery chip — the
    /// "Viewbox/ScaleTransform over a fixed-size host" a page composition
    /// needs that a content-sized atom/molecule specimen never does (same
    /// reasoning <see cref="MuiGalleryWindow.Templates"/>'s own
    /// TemplateFrame doc comment gives for templates, one size class up).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private const double PageDesignWidth = 1280;
        private const double PageDesignHeight = 800;
        private const double PageChipWidth = 340;
        private const double PageChipHeight = 212;

        private void BuildPagesPage(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Pages (§6)"));
            panel.Children.Add(new TextBlock
            {
                Text = "All 15 page compositions — each a catalog template hosting its own organisms, live-wired.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, -8, 0, 4),
            });

            var chips = new[]
            {
                PageChip("Browse", "Sidebar -> Grid/Timeline/Map filter chain.", new MuiPageBrowse()),
                PageChip("Editor", "Tool Dock + Adjustments share one live value map.", new MuiPageEditor()),
                PageChip("Document", "Rich Text Editor + Version History snapshots.", new MuiPageDocument()),
                PageChip("Preview", "Filmstrip + wraparound Prev/Next nav.", new MuiPagePreview()),
                PageChip("Search", "Facet + query AND-filtered results.", new MuiPageSearch()),
                PageChip("Board", "WIP-gated Kanban Board.", new MuiPageBoard()),
                PageChip("Chat", "Chat + Thread Panel, canned assistant replies.", new MuiPageChat()),
                PageChip("Notifications", "Category-filtered feed, unread gating.", new MuiPageNotifications()),
                PageChip("Settings", "Section Nav swaps Settings/Devices/Team.", new MuiPageSettings()),
                PageChip("Admin", "Pipeline pause gate + gated Setup Wizard.", new MuiPageAdmin()),
                PageChip("Sign In", "Field validation gates submit.", new MuiPageSignIn()),
                PageChip("Pairing", "Scanned-code validation gates the flow.", new MuiPagePairing()),
                PageChip("TV Timeline", "Tab Shell shares one range filter.", new MuiPageTVTimeline()),
                PageChip("TV Viewer", "Shares the Preview page's nav reducer.", new MuiPageTVViewer()),
                PageChip("TV Map", "Pin count gates the heatmap layer.", new MuiPageTVMap()),
            };

            // Two per row — each chip (with its SpecimenCard padding) is
            // ~380px wide, and the gallery window opens at 1100px, so
            // three would overflow a ScrollViewer that only scrolls
            // vertically (same width budget TemplatesPage's own Row()
            // pairs already respect for its widest specimens).
            const int columnsPerRow = 2;
            for (var i = 0; i < chips.Length; i += columnsPerRow)
            {
                var rowItems = new List<UIElement>();
                for (var j = i; j < chips.Length && j < i + columnsPerRow; j++)
                    rowItems.Add(chips[j]);
                panel.Children.Add(Row(rowItems.ToArray()));
            }
        }

        /// <summary>One page specimen: a labeled card containing a
        /// fixed-size chip that Viewbox-scales the live page control down
        /// from its <see cref="PageDesignWidth"/>x<see cref="PageDesignHeight"/>
        /// design size.</summary>
        private static Border PageChip(string name, string purpose, UIElement page)
        {
            var designHost = new Border
            {
                Width = PageDesignWidth,
                Height = PageDesignHeight,
                Background = R("MapleBg"),
                Child = page,
            };
            var viewbox = new Viewbox { Stretch = Stretch.Uniform, Child = designHost };

            var chip = new Border
            {
                Width = PageChipWidth,
                Height = PageChipHeight,
                BorderBrush = R("MapleBorder"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Child = viewbox,
            };

            return SpecimenCard(name, purpose, chip);
        }
    }
}

using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Templates gallery page (unified-component-catalog.md §5,
    /// all 7 layout shells — wave N5, #3012). These are regions-only
    /// containers with no content of their own, so each specimen renders
    /// inside a fixed-size <see cref="TemplateFrame"/> with labeled
    /// <see cref="PlaceholderBlock"/> stand-ins for its regions — the
    /// job here is to show region proportions/behavior (resize handles,
    /// collapse, drag-to-dismiss), not real content.
    ///
    /// Overlay/Sheet/Drawer render via an "Open" trigger in
    /// <c>Contained</c> mode, reusing the same <see cref="AnchoredDemo"/>
    /// "trigger and control share a Grid cell" shape
    /// MuiGalleryWindow.MoleculesL1.cs's own doc comment explains for
    /// every Popover-composing molecule — a live overlay needs a real
    /// trigger to anchor its "Open"/"Dismissed" wiring against, and
    /// Contained keeps the demo inside its chip instead of covering the
    /// whole gallery window.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildTemplatesPage(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Templates (§5)"));
            panel.Children.Add(new TextBlock
            {
                Text = "All 7 layout shells. Regions only — no content of their own.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, -8, 0, 4),
            });

            AddSpecimen(panel, "App Shell", "Navigation / Content / Overlay regions, top or side nav.", Row(
                TemplateFrame(BuildAppShellDemo(MuiAppShellNavPlacement.Top), 380, 240),
                TemplateFrame(BuildAppShellDemo(MuiAppShellNavPlacement.Side), 380, 240)));

            AddSpecimen(panel, "Split Layout", "Sidebar / Center / Detail, draggable resize handles.",
                TemplateFrame(BuildSplitLayoutDemo(), 640, 300));

            AddSpecimen(panel, "Tab Shell", "Tab bar + content, top or bottom placement.", Row(
                TemplateFrame(BuildTabShellDemo(MuiTabShellPlacement.Top), 300, 240),
                TemplateFrame(BuildTabShellDemo(MuiTabShellPlacement.Bottom), 300, 240)));

            AddSpecimen(panel, "Settings Shell", "Section nav (fixed width) + max-width pane.",
                TemplateFrame(BuildSettingsShellDemo(), 480, 260));

            AddSpecimen(panel, "Overlay Shell", "Scrim + header/body/footer, sm/md/lg/full sizes.",
                TemplateFrame(BuildOverlayShellDemo(), 480, 320));

            AddSpecimen(panel, "Sheet Shell", "Scrim + grab handle + body, detents, drag-to-dismiss.",
                TemplateFrame(BuildSheetShellDemo(), 320, 400));

            AddSpecimen(panel, "Drawer Shell", "Scrim + edge panel, left or right.", Row(
                TemplateFrame(BuildDrawerShellDemo(MuiDrawerShellEdge.Left), 320, 280),
                TemplateFrame(BuildDrawerShellDemo(MuiDrawerShellEdge.Right), 320, 280)));
        }

        /// <summary>Fixed-size chip a template specimen renders inside —
        /// templates size their regions off the host's own bounds
        /// (SizeChanged/collapse math, contained scrim sizing), so a
        /// specimen needs a real, bounded frame to demonstrate that
        /// against rather than sizing to content like an atom/molecule
        /// specimen does.</summary>
        private static Border TemplateFrame(UIElement content, double width, double height) => new()
        {
            Width = width,
            Height = height,
            Background = R("MapleBg"),
            BorderBrush = R("MapleBorder"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Child = content,
        };

        private static Border PlaceholderBlock(string label, double? width = null, double? height = null) => new()
        {
            Width = width ?? double.NaN,
            Height = height ?? double.NaN,
            MinWidth = 48,
            MinHeight = 32,
            Background = R("MapleSurfaceAlt"),
            BorderBrush = R("MapleBorder"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(4),
            Child = new TextBlock
            {
                Text = label,
                FontSize = 11,
                Foreground = R("MapleTextMuted"),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
            },
        };

        private static UIElement BuildAppShellDemo(MuiAppShellNavPlacement placement)
        {
            var toast = PlaceholderBlock("Toast", width: 90, height: 28);
            toast.HorizontalAlignment = HorizontalAlignment.Right;
            toast.VerticalAlignment = VerticalAlignment.Bottom;
            toast.Margin = new Thickness(8);

            return new MuiAppShell
            {
                NavPlacement = placement,
                Navigation = placement == MuiAppShellNavPlacement.Side
                    ? PlaceholderBlock("Nav", width: 96)
                    : PlaceholderBlock("Nav", height: 40),
                MainContent = PlaceholderBlock("Content"),
                Overlay = toast,
            };
        }

        private static UIElement BuildSplitLayoutDemo() => new MuiSplitLayout
        {
            // A gallery chip is narrower than the real collapse
            // breakpoints (900px/640px) — this is the documented escape
            // hatch for showing all three regions at once regardless of
            // host width.
            CollapseEnabled = false,
            Sidebar = PlaceholderBlock("Sidebar"),
            Center = PlaceholderBlock("Center"),
            Detail = PlaceholderBlock("Detail"),
        };

        private static UIElement BuildTabShellDemo(MuiTabShellPlacement placement) => new MuiTabShell
        {
            Placement = placement,
            Tabs = new List<MuiTab>
            {
                new("info", "Info"),
                new("history", "History"),
                new("map", "Map"),
            },
            MainContent = PlaceholderBlock("Content"),
        };

        private static UIElement BuildSettingsShellDemo() => new MuiSettingsShell
        {
            NavWidth = 140,
            PaneMaxWidth = 280,
            Nav = PlaceholderBlock("Nav"),
            Pane = PlaceholderBlock("Pane"),
        };

        private static UIElement BuildOverlayShellDemo()
        {
            var shell = new MuiOverlayShell
            {
                Contained = true,
                Size = MuiOverlayShellSize.Md,
                AriaLabel = "Export",
                Header = PlaceholderBlock("Header", height: 32),
                Body = PlaceholderBlock("Body"),
                Footer = PlaceholderBlock("Footer", height: 32),
            };
            var trigger = new MuiButton
            {
                Variant = MuiButtonVariant.Secondary,
                Label = "Open",
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            trigger.Click += (_, _) => shell.IsOpen = true;
            shell.Dismissed += (_, _) => shell.IsOpen = false;
            return AnchoredDemo(trigger, shell);
        }

        private static UIElement BuildSheetShellDemo()
        {
            var shell = new MuiSheetShell
            {
                Contained = true,
                Detents = new List<double> { 0.6 },
                Body = PlaceholderBlock("Body"),
            };
            var trigger = new MuiButton
            {
                Variant = MuiButtonVariant.Secondary,
                Label = "Open",
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            trigger.Click += (_, _) => shell.IsOpen = true;
            shell.Dismissed += (_, _) => shell.IsOpen = false;
            return AnchoredDemo(trigger, shell);
        }

        private static UIElement BuildDrawerShellDemo(MuiDrawerShellEdge edge)
        {
            var shell = new MuiDrawerShell
            {
                Contained = true,
                Edge = edge,
                PanelWidth = 180,
                PanelContent = PlaceholderBlock("Panel"),
            };
            var trigger = new MuiButton
            {
                Variant = MuiButtonVariant.Secondary,
                Label = "Open",
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            trigger.Click += (_, _) => shell.IsOpen = true;
            shell.Dismissed += (_, _) => shell.IsOpen = false;
            return AnchoredDemo(trigger, shell);
        }
    }
}

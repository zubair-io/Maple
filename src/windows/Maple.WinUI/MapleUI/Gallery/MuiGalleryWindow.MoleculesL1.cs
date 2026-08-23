using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Gallery
{
    /// <summary>
    /// Molecules — Level 1 gallery page: all 44 Level-1 molecules from
    /// unified-component-catalog.md §2.1-2.7. Split across section files by
    /// catalog subsection — wave N3a (#3012) built
    /// <c>MoleculesL1.FormEntry.cs</c>/<c>MoleculesL1.Selection.cs</c>/
    /// <c>MoleculesL1.Feedback.cs</c> (§2.1-2.3, 19 molecules); wave N3b
    /// (#3012) adds <c>MoleculesL1.Overlays.cs</c>/<c>MoleculesL1.Structure.cs</c>/
    /// <c>MoleculesL1.DataPlots.cs</c>/<c>MoleculesL1.Media.cs</c>
    /// (§2.4-2.7, the remaining 25) — the same "keep one code-behind file
    /// readable" reasoning that keeps the rest of this codebase under the
    /// file-size budget, applied here even though the C# file-budget gate
    /// itself only scans *.rs/*.swift/*.ts/*.tsx/*.js/*.py
    /// (tools/check-file-budget.sh).
    ///
    /// Reuses this window's existing private helpers
    /// (<c>Row</c>/<c>Column</c>/<c>SpecimenCard</c>/<c>R</c> from
    /// MuiGalleryWindow.xaml.cs's Atoms-page section) — partial class
    /// members are visible across every file of the partial declaration,
    /// so the section files below need no helper duplication.
    /// </summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL1Page(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Molecules — Level 1 (§2.1-2.7)"));
            panel.Children.Add(new TextBlock
            {
                Text = "All 44 Level-1 molecules, built from the 22 Maple.UI atoms.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, -8, 0, 4),
            });

            BuildFormEntrySpecimens(panel);
            BuildSelectionSpecimens(panel);
            BuildFeedbackSpecimens(panel);
            BuildOverlaySpecimens(panel);
            BuildStructureSpecimens(panel);
            BuildDataPlotSpecimens(panel);
            BuildMediaSpecimens(panel);
        }

        /// <summary>Appends one specimen card — shared by every section
        /// file below so each stays a flat list of molecule demos.</summary>
        private void AddSpecimen(StackPanel panel, string name, string purpose, UIElement content) =>
            panel.Children.Add(SpecimenCard(name, purpose, content));

        /// <summary>Wraps a trigger and a Popover-composing molecule in the
        /// same Grid cell — the WinUI equivalent of the web's "position:
        /// relative box" convention <c>MuiPopover</c>'s own doc comment
        /// describes: the popover measures ITS OWN layout rect as the
        /// anchor, so it must share bounds with the trigger it's meant to
        /// hang off. Used by every §2.4 overlay/menu specimen below.</summary>
        private static UIElement AnchoredDemo(UIElement trigger, UIElement popoverControl)
        {
            var host = new Grid();
            host.Children.Add(trigger);
            host.Children.Add(popoverControl);
            return host;
        }
    }
}

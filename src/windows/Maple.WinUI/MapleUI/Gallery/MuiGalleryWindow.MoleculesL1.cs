using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Gallery
{
    /// <summary>
    /// Molecules — Level 1 gallery page (wave N3a, #3012): the 19
    /// Form &amp; entry / Selection / Feedback &amp; messaging molecules
    /// from unified-component-catalog.md §2.1-2.3. Split across three
    /// section files by catalog subsection — <c>MoleculesL1.FormEntry.cs</c>,
    /// <c>MoleculesL1.Selection.cs</c>, <c>MoleculesL1.Feedback.cs</c> —
    /// the same "keep one code-behind file readable" reasoning that keeps
    /// the rest of this codebase under the file-size budget, applied here
    /// even though the C# file-budget gate itself only scans
    /// *.rs/*.swift/*.ts/*.tsx/*.js/*.py (tools/check-file-budget.sh).
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
            panel.Children.Add(SectionHeading("Molecules — Level 1 (§2.1-2.3)"));
            panel.Children.Add(new TextBlock
            {
                Text = "Form & entry, Selection, and Feedback & messaging — 19 of 44 Level-1 molecules, built from the 22 Maple.UI atoms.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, -8, 0, 4),
            });

            BuildFormEntrySpecimens(panel);
            BuildSelectionSpecimens(panel);
            BuildFeedbackSpecimens(panel);
        }

        /// <summary>Appends one specimen card — shared by all three section
        /// files below so each stays a flat list of molecule demos.</summary>
        private void AddSpecimen(StackPanel panel, string name, string purpose, UIElement content) =>
            panel.Children.Add(SpecimenCard(name, purpose, content));
    }
}

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Gallery
{
    /// <summary>
    /// Molecules — Level 2 gallery page: all 24 Level-2 molecules from
    /// unified-component-catalog.md §3, built from the 64 Level-0/1
    /// atoms+molecules wave N4 (#3012) had available. Split across section
    /// files the same way MuiGalleryWindow.MoleculesL1*.cs is — one file
    /// per loose catalog grouping, each kept well under the "readable
    /// code-behind file" ceiling this codebase applies elsewhere (see
    /// MuiGalleryWindow.MoleculesL1.cs's own doc comment on why, even
    /// though the C# file-budget gate itself only scans
    /// *.rs/*.swift/*.ts/*.tsx/*.js/*.py).
    ///
    /// Reuses this window's existing private helpers (<c>Row</c>/
    /// <c>Column</c>/<c>SpecimenCard</c>/<c>R</c>/<c>SolidBitmap</c> from
    /// MuiGalleryWindow.xaml.cs, plus <c>AddSpecimen</c>/<c>AnchoredDemo</c>
    /// from MuiGalleryWindow.MoleculesL1.cs) — partial class members are
    /// visible across every file of the partial declaration.
    /// </summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2Page(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Molecules — Level 2 (§3)"));
            panel.Children.Add(new TextBlock
            {
                Text = "All 24 Level-2 molecules, composed from Molecules L1 + Atoms.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, -8, 0, 4),
            });

            BuildMoleculesL2MediaSpecimens(panel);
            BuildMoleculesL2OverlaySpecimens(panel);
            BuildMoleculesL2EnrichmentSpecimens(panel);
            BuildMoleculesL2ContentSpecimens(panel);
            BuildMoleculesL2BotDevSpecimens(panel);
            BuildMoleculesL2ChatSpecimens(panel);
        }
    }
}

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Gallery
{
    /// <summary>
    /// Organisms gallery page: all 55 organisms from
    /// unified-component-catalog.md §4, built from the Atoms/Molecules
    /// L1/L2/Templates every earlier wave shipped. Split across section
    /// files by catalog subsection, the same convention
    /// MuiGalleryWindow.MoleculesL1*.cs/MoleculesL2*.cs already
    /// establish — wave N6 (#3012) landed this in two pushes: collections/
    /// navigation/inspector panels (§4.1-4.3, 23) first, then modals/
    /// editing/map/communication/configuration (§4.4-4.8, 32).
    ///
    /// Reuses this window's existing private helpers (<c>Row</c>/
    /// <c>Column</c>/<c>SpecimenCard</c>/<c>R</c>/<c>SolidBitmap</c> from
    /// MuiGalleryWindow.xaml.cs, plus <c>AddSpecimen</c>/<c>AnchoredDemo</c>
    /// from MuiGalleryWindow.MoleculesL1.cs).
    /// </summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsPage(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Organisms (§4)"));
            panel.Children.Add(new TextBlock
            {
                Text = "All 55 organisms, composed from Atoms + Molecules L1/L2 + Templates.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, -8, 0, 4),
            });

            BuildOrganismsCollectionsSpecimens(panel);
            BuildOrganismsNavigationSpecimens(panel);
            BuildOrganismsInspectorsSpecimens(panel);
            BuildOrganismsInspectorsBSpecimens(panel);
            // §4.4-4.8 (modals, editing, map, communication, configuration)
            // land in this wave's second push — see the class doc comment.
        }
    }
}

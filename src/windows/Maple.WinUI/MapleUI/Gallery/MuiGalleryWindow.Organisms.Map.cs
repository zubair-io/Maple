using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.6 Map gallery specimens (Map Surface) —
    /// wave N6 second push (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsMapSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Map Surface", "Clustered pins over a token grid, drag-to-pan, density toggle.", Row(
                TemplateFrame(new MuiMapSurface
                {
                    Assets = new[]
                    {
                        new MuiMapAsset("a1", 80, 60, SolidBitmap(100, 140, 200), "Big Sur"),
                        new MuiMapAsset("a2", 90, 70, SolidBitmap(110, 150, 210), "Big Sur"),
                        new MuiMapAsset("a3", 260, 160, SolidBitmap(200, 140, 90), "Yosemite"),
                    },
                    ClusterRadius = 30,
                }, 340, 240),
                TemplateFrame(new MuiMapSurface { Assets = System.Array.Empty<MuiMapAsset>() }, 200, 240)));
        }
    }
}

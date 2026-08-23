using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Maple.UI.Pages
{
    /// <summary>Synthesizes a tiny flat-color bitmap to stand in for a
    /// decoded thumbnail — every Windows Page composition (#3012) uses
    /// this instead of a bundled sample photo, same approach
    /// MuiGalleryWindow.xaml.cs's own SolidBitmap already establishes for
    /// the Atoms gallery page.</summary>
    internal static class MuiPageBitmap
    {
        public static ImageSource Solid(byte r, byte g, byte b)
        {
            const int size = 8;
            var bmp = new WriteableBitmap(size, size);
            var pixels = new byte[size * size * 4];
            for (var i = 0; i < pixels.Length; i += 4)
            {
                pixels[i] = b;
                pixels[i + 1] = g;
                pixels[i + 2] = r;
                pixels[i + 3] = 255;
            }
            using (var stream = bmp.PixelBuffer.AsStream())
                stream.Write(pixels, 0, pixels.Length);
            return bmp;
        }

        public static ImageSource ForAsset(MuiMockAsset asset) => Solid(asset.R, asset.G, asset.B);
    }
}

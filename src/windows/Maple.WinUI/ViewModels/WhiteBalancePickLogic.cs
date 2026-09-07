// WhiteBalancePickLogic — the canvas-click → normalised-point math behind
// the Windows eyedropper (#2434), WinUI-free (the decision half of
// MainWindow.WhiteBalance.cs, the same split SelectionLogic.cs uses).
//
// The click position arrives in the content host's coordinate space —
// WinUI's GetCurrentPoint(CropRotateHost) has already undone the straighten
// rotation, the committed-crop translate/scale and the ScrollViewer zoom —
// and the image occupies the fit footprint inside that host
// (MainWindow.Crop.cs ContentFitRect). The sampler wants [0, 1] in the
// uncropped, display-oriented frame, which is exactly the footprint.

using System;

namespace Maple.WinUI.ViewModels
{
    public static class WhiteBalancePickLogic
    {
        /// <summary>A press/release pair further apart than this is a pan
        /// (the viewer drags to pan when zoomed), not a pick.</summary>
        public const double ClickSlopDips = 4.0;

        /// <summary>
        /// Normalise a host-space point against the image footprint
        /// (<paramref name="fx"/>, <paramref name="fy"/>, <paramref name="fw"/>,
        /// <paramref name="fh"/>). Null when the point is outside the image or
        /// the footprint is degenerate; edges are inside.
        /// </summary>
        public static (double X, double Y)? Normalize(double x, double y, double fx, double fy, double fw, double fh)
        {
            if (fw <= 0 || fh <= 0)
                return null;
            var nx = (x - fx) / fw;
            var ny = (y - fy) / fh;
            return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 ? (nx, ny) : null;
        }

        public static bool IsClick(double pressX, double pressY, double releaseX, double releaseY) =>
            Math.Abs(releaseX - pressX) <= ClickSlopDips && Math.Abs(releaseY - pressY) <= ClickSlopDips;
    }
}

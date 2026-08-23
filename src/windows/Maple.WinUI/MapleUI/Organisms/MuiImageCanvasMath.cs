using System;

namespace Maple.UI
{
    /// <summary>
    /// The zoom/pan transform math behind <see cref="MuiImageCanvas"/>
    /// (unified-component-catalog.md §4.5, "Image Canvas" row: "Zoom,
    /// pan, before/after, render") — pure double math over viewport/image
    /// dimensions, unit tested without a live Window. The control itself
    /// only wires pointer-wheel and drag events to these functions and
    /// applies the resulting zoom/pan to a <see cref="Microsoft.UI.Xaml.Media.ScaleTransform"/>/
    /// <see cref="Microsoft.UI.Xaml.Media.TranslateTransform"/> pair.
    /// </summary>
    public static class MuiImageCanvasMath
    {
        public const double MinZoom = 0.1;
        public const double MaxZoom = 8.0;

        public static double ClampZoom(double zoom) => Math.Clamp(zoom, MinZoom, MaxZoom);

        /// <summary>Multiplicative zoom step from a mouse-wheel delta
        /// (Windows reports +-120 per notch) — each notch is roughly a
        /// 20% zoom step, exponential so repeated notches compound
        /// smoothly rather than linearly.</summary>
        public static double ZoomForWheelDelta(double currentZoom, int wheelDelta) =>
            ClampZoom(currentZoom * Math.Pow(1.0015, wheelDelta));

        /// <summary>The zoom that fits the whole image inside the
        /// viewport with no cropping (letterboxed if aspect ratios
        /// differ).</summary>
        public static double FitZoom(double viewportWidth, double viewportHeight, double imageWidth, double imageHeight)
        {
            if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return 1.0;
            return ClampZoom(Math.Min(viewportWidth / imageWidth, viewportHeight / imageHeight));
        }

        /// <summary>Clamps a pan offset (in viewport pixels, centered
        /// origin) so the scaled image can't be dragged entirely off
        /// screen — once the scaled image is smaller than the viewport on
        /// an axis, that axis' pan is pinned to 0 (centered).</summary>
        public static (double X, double Y) ClampPan(
            double panX, double panY, double viewportWidth, double viewportHeight,
            double imageWidth, double imageHeight, double zoom)
        {
            var scaledWidth = imageWidth * zoom;
            var scaledHeight = imageHeight * zoom;
            var maxX = Math.Max(0, (scaledWidth - viewportWidth) / 2);
            var maxY = Math.Max(0, (scaledHeight - viewportHeight) / 2);
            return (Math.Clamp(panX, -maxX, maxX), Math.Clamp(panY, -maxY, maxY));
        }
    }
}

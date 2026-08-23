using System;

namespace Maple.UI
{
    /// <summary>The eight drag handles a Crop Overlay exposes — the four
    /// corners plus the four edge midpoints.</summary>
    public enum MuiCropHandle { TopLeft, Top, TopRight, Right, BottomRight, Bottom, BottomLeft, Left }

    /// <summary>A crop region in image pixel space.</summary>
    public readonly record struct MuiCropRect(double X, double Y, double Width, double Height)
    {
        public double Left => X;
        public double Top => Y;
        public double Right => X + Width;
        public double Bottom => Y + Height;
    }

    /// <summary>
    /// The handle-drag resize math behind <see cref="MuiCropOverlay"/>
    /// (unified-component-catalog.md §4.5, "Crop Overlay" row: "Draggable
    /// crop with grid and mask" — this wave's brief calls for porting the
    /// web port's <c>applyHandleDelta</c> decisions). Each handle moves
    /// only the edge(s) named in it (e.g. <see cref="MuiCropHandle.Right"/>
    /// moves the right edge only); a moving edge is clamped against the
    /// bounds AND against its own opposite (fixed) edge offset by
    /// <see cref="MinSize"/>, so the crop region can never invert or
    /// shrink below a usable size. Pure over <see cref="MuiCropRect"/> —
    /// unit tested without a live Window.
    /// </summary>
    public static class MuiCropOverlayMath
    {
        public const double MinSize = 20;

        public static MuiCropRect ApplyHandleDelta(
            MuiCropRect rect, MuiCropHandle handle, double dx, double dy,
            double boundsWidth, double boundsHeight)
        {
            var left = rect.Left;
            var top = rect.Top;
            var right = rect.Right;
            var bottom = rect.Bottom;

            var movesLeft = handle is MuiCropHandle.TopLeft or MuiCropHandle.Left or MuiCropHandle.BottomLeft;
            var movesRight = handle is MuiCropHandle.TopRight or MuiCropHandle.Right or MuiCropHandle.BottomRight;
            var movesTop = handle is MuiCropHandle.TopLeft or MuiCropHandle.Top or MuiCropHandle.TopRight;
            var movesBottom = handle is MuiCropHandle.BottomLeft or MuiCropHandle.Bottom or MuiCropHandle.BottomRight;

            // Math.Max/Min guard every clamp's own bounds so a moving
            // edge's [min, max] range never inverts (min > max throws)
            // even for a pathological input rect narrower than MinSize.
            if (movesLeft) left = Math.Clamp(left + dx, 0, Math.Max(0, right - MinSize));
            if (movesRight) right = Math.Clamp(right + dx, Math.Min(left + MinSize, boundsWidth), boundsWidth);
            if (movesTop) top = Math.Clamp(top + dy, 0, Math.Max(0, bottom - MinSize));
            if (movesBottom) bottom = Math.Clamp(bottom + dy, Math.Min(top + MinSize, boundsHeight), boundsHeight);

            return new MuiCropRect(left, top, right - left, bottom - top);
        }

        /// <summary>Translates the whole region by (dx, dy), clamped so
        /// it stays fully within bounds — used when dragging the crop
        /// region's body rather than a handle.</summary>
        public static MuiCropRect Translate(MuiCropRect rect, double dx, double dy, double boundsWidth, double boundsHeight)
        {
            var maxLeft = Math.Max(0, boundsWidth - rect.Width);
            var maxTop = Math.Max(0, boundsHeight - rect.Height);
            var left = Math.Clamp(rect.Left + dx, 0, maxLeft);
            var top = Math.Clamp(rect.Top + dy, 0, maxTop);
            return new MuiCropRect(left, top, rect.Width, rect.Height);
        }
    }
}

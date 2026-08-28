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
            double boundsWidth, double boundsHeight) =>
            ApplyHandleDelta(rect, handle, dx, dy, boundsWidth, boundsHeight, MinSize, MinSize);

        /// <summary>Per-axis-minimum overload (MN2, #3051): the app's crop
        /// session keeps a minimum crop FRACTION of the frame (5% of each
        /// footprint axis), so the floor differs per axis rather than being
        /// one fixed pixel count.</summary>
        public static MuiCropRect ApplyHandleDelta(
            MuiCropRect rect, MuiCropHandle handle, double dx, double dy,
            double boundsWidth, double boundsHeight, double minWidth, double minHeight)
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
            // even for a pathological input rect narrower than the minimum.
            if (movesLeft) left = Math.Clamp(left + dx, 0, Math.Max(0, right - minWidth));
            if (movesRight) right = Math.Clamp(right + dx, Math.Min(left + minWidth, boundsWidth), boundsWidth);
            if (movesTop) top = Math.Clamp(top + dy, 0, Math.Max(0, bottom - minHeight));
            if (movesBottom) bottom = Math.Clamp(bottom + dy, Math.Min(top + minHeight, boundsHeight), boundsHeight);

            return new MuiCropRect(left, top, right - left, bottom - top);
        }

        /// <summary>Re-imposes a fixed width/height ratio after a handle drag
        /// (MN2, #3051 — the crop session's aspect lock), adjusting the axis
        /// the handle did NOT primarily move: edge handles re-derive the
        /// other axis centered on the region's midline; corner handles make
        /// height follow width, anchored on the stationary horizontal edge.
        /// <paramref name="aspect"/> is width/height in the same pixel space
        /// as <paramref name="rect"/>. Clamping against the bounds wins over
        /// the ratio at the frame edges, matching the session's behavior.</summary>
        public static MuiCropRect ConstrainAspect(
            MuiCropRect rect, MuiCropHandle handle, double aspect,
            double boundsWidth, double boundsHeight)
        {
            if (aspect <= 0) return rect;
            switch (handle)
            {
                case MuiCropHandle.Left or MuiCropHandle.Right:
                {
                    var height = Math.Min(rect.Width / aspect, boundsHeight);
                    var cy = rect.Top + rect.Height / 2;
                    var top = Math.Max(0, cy - height / 2);
                    var bottom = Math.Min(boundsHeight, cy + height / 2);
                    return new MuiCropRect(rect.X, top, rect.Width, bottom - top);
                }
                case MuiCropHandle.Top or MuiCropHandle.Bottom:
                {
                    var width = Math.Min(rect.Height * aspect, boundsWidth);
                    var cx = rect.Left + rect.Width / 2;
                    var left = Math.Max(0, cx - width / 2);
                    var right = Math.Min(boundsWidth, cx + width / 2);
                    return new MuiCropRect(left, rect.Y, right - left, rect.Height);
                }
                default:
                {
                    // Corners: height follows width, anchored vertically on
                    // the stationary edge.
                    var height = Math.Min(rect.Width / aspect, boundsHeight);
                    if (handle is MuiCropHandle.TopLeft or MuiCropHandle.TopRight)
                    {
                        var top = Math.Max(0, rect.Bottom - height);
                        return new MuiCropRect(rect.X, top, rect.Width, rect.Bottom - top);
                    }
                    var bottom = Math.Min(boundsHeight, rect.Top + height);
                    return new MuiCropRect(rect.X, rect.Y, rect.Width, bottom - rect.Top);
                }
            }
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

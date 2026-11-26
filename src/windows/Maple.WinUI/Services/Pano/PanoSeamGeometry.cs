using System;

namespace Maple.WinUI.Services.Pano;

/// <summary>Screen ↔ reference-preview pixel arithmetic for the seam editor
/// (#5992), matching the Web surface's `pano-seam-geometry.ts`. It only
/// places a rectangle on the preview the user is looking at; how that
/// rectangle lands on the stitched output is the Rust core's mapping.</summary>
public static class PanoSeamGeometry
{
    public static bool Contains(PanoSeamCanvas canvas, PanoSeamRect rect) =>
        canvas.Width > 0 && canvas.Height > 0
        && rect.X >= 0 && rect.Y >= 0 && rect.Width > 0 && rect.Height > 0
        && (long)rect.X + rect.Width <= canvas.Width
        && (long)rect.Y + rect.Height <= canvas.Height;

    public static (double Width, double Height) Fit(PanoSeamCanvas canvas, double boxWidth, double boxHeight)
    {
        if (canvas.Width <= 0 || canvas.Height <= 0 || !(boxWidth > 0) || !(boxHeight > 0))
            return (0, 0);
        var scale = Math.Min(boxWidth / canvas.Width, boxHeight / canvas.Height);
        return (canvas.Width * scale, canvas.Height * scale);
    }

    public static (double X, double Y)? ToCanvas(
        double x, double y, double surfaceWidth, double surfaceHeight, PanoSeamCanvas canvas) =>
        canvas.Width > 0 && canvas.Height > 0 && surfaceWidth > 0 && surfaceHeight > 0
            ? (Math.Clamp(x * canvas.Width / surfaceWidth, 0, canvas.Width),
                Math.Clamp(y * canvas.Height / surfaceHeight, 0, canvas.Height))
            : null;

    /// <summary>The whole-pixel rectangle covering a drag: starts round down
    /// and ends round up. Null for a drag with no area.</summary>
    public static PanoSeamRect? DragRect((double X, double Y) start, (double X, double Y) end, PanoSeamCanvas canvas)
    {
        if (start.X == end.X || start.Y == end.Y)
            return null;
        var x = Math.Max(0, (int)Math.Floor(Math.Min(start.X, end.X)));
        var y = Math.Max(0, (int)Math.Floor(Math.Min(start.Y, end.Y)));
        var right = Math.Min(canvas.Width, (int)Math.Ceiling(Math.Max(start.X, end.X)));
        var bottom = Math.Min(canvas.Height, (int)Math.Ceiling(Math.Max(start.Y, end.Y)));
        var rect = new PanoSeamRect(x, y, right - x, bottom - y);
        return Contains(canvas, rect) ? rect : null;
    }

    public static (double X, double Y, double Width, double Height) OnSurface(
        PanoSeamRect rect, PanoSeamCanvas canvas, double surfaceWidth, double surfaceHeight)
    {
        var scaleX = surfaceWidth / Math.Max(1, canvas.Width);
        var scaleY = surfaceHeight / Math.Max(1, canvas.Height);
        return (rect.X * scaleX, rect.Y * scaleY, rect.Width * scaleX, rect.Height * scaleY);
    }
}

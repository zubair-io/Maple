using System.Runtime.InteropServices;

namespace Maple.WinUI.Native
{
    // C-ABI mirrors of raw-ffi's canvas zoom values (canvas_math.rs,
    // canvas_zoom.rs, #5714). Every Rust `u8` flag and `bool` is a C# `byte`
    // so the structs stay blittable and byte-for-byte equal to the Rust
    // layout; RawFfiLayoutTests checks each field offset.

    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasSize
    {
        public double width;
        public double height;

        public MapleCanvasSize(double width, double height)
        {
            this.width = width;
            this.height = height;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasPoint
    {
        public double x;
        public double y;

        public MapleCanvasPoint(double x, double y)
        {
            this.x = x;
            this.y = y;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasRect
    {
        public double x;
        public double y;
        public double width;
        public double height;
    }

    /// <summary>Viewport (points), oriented source extent (zero until known)
    /// and points→pixels factor; Rust sanitizes it on every call.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasZoomContext
    {
        public MapleCanvasSize viewport_points;
        public MapleCanvasSize native_image_size;
        public double display_scale;
    }

    /// <summary>The zoom state the host keeps between transitions; all-zero
    /// is fit. Each `has_*` byte marks whether the value after it is set.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasZoomState
    {
        public double pixel_scale;
        public MapleCanvasSize pan_offset;
        public MapleCanvasSize base_pan;
        public byte has_drag_translation_base;
        public MapleCanvasSize drag_translation_base;
        public byte has_pinch_start_scale;
        public double pinch_start_scale;
        public MapleCanvasSize pinch_start_pan;
        public MapleCanvasPoint pinch_start_centroid;
        public MapleCanvasPoint pinch_last_centroid;
        public byte fills_viewport;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasZoomTransition
    {
        public MapleCanvasZoomState state;
        public byte handled;
    }

    /// <summary>Inputs of one `maple_canvas_math_resolve` snapshot.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasMathInput
    {
        public MapleCanvasSize viewport_px;
        public MapleCanvasSize native_image_size;
        public double pixel_scale;
        public MapleCanvasSize pan_offset;
        public double display_scale;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MapleCanvasMathResult
    {
        public byte has_image_extent;
        public MapleCanvasSize image_extent;
        public double fit_pixel_scale;
        public double fill_pixel_scale;
        public double effective_pixel_scale;
        public byte has_display_frame;
        public MapleCanvasSize display_frame_in_points;
        public byte has_fast_target;
        public MapleCanvasSize fast_target_size;
        public byte has_refined_target;
        public MapleCanvasSize refined_target_size;
        public MapleCanvasRect visible_source_rect;
    }
}

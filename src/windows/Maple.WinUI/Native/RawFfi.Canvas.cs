using System.Runtime.InteropServices;

namespace Maple.WinUI.Native
{
    /// <summary>The shared canvas zoom model (raw-ffi canvas_zoom.rs /
    /// canvas_math.rs, #5714). Values in, values out: no pointers, no
    /// allocation, nothing held in Rust between calls. A panic inside Rust
    /// returns the input state unchanged.</summary>
    public static partial class RawFfi
    {
        public const uint MAPLE_CANVAS_DOUBLE_TAP_RESET_TO_FIT = 0;
        public const uint MAPLE_CANVAS_DOUBLE_TAP_TOGGLE_FIT_AND_100 = 1;

        public const uint MAPLE_CANVAS_DRAG_INTENT_EDITING = 0;
        public const uint MAPLE_CANVAS_DRAG_INTENT_PAN = 1;

        public const uint MAPLE_CANVAS_WHEEL_INTENT_ZOOM = 0;
        public const uint MAPLE_CANVAS_WHEEL_INTENT_PAN = 1;
        public const uint MAPLE_CANVAS_WHEEL_INTENT_EDITING = 2;

        public const uint MAPLE_CANVAS_ZOOM_STOP_NONE = 0;
        public const uint MAPLE_CANVAS_ZOOM_STOP_FIT = 1;
        public const uint MAPLE_CANVAS_ZOOM_STOP_FILL = 2;
        public const uint MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE = 3;

        /// <summary>The context as every other entry resolves it (sizes and
        /// display scale sanitized).</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomContext maple_canvas_zoom_context_sanitize(MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasSize maple_canvas_zoom_viewport_px(MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern double maple_canvas_zoom_fit_scale(MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern double maple_canvas_zoom_fill_scale(MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_pinch_changed(
            MapleCanvasZoomState state, double magnification, MapleCanvasPoint location,
            MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_pinch_ended(
            MapleCanvasZoomState state, double magnification, MapleCanvasZoomContext context);

        /// <summary>`handled` = the drag was consumed as a pan.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomTransition maple_canvas_zoom_drag_changed(
            MapleCanvasZoomState state, MapleCanvasSize translation, MapleCanvasZoomContext context);

        /// <summary>`handled` = a pan was committed.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomTransition maple_canvas_zoom_drag_ended(MapleCanvasZoomState state);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_wheel_pan(
            MapleCanvasZoomState state, MapleCanvasSize delta, MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_wheel_zoom(
            MapleCanvasZoomState state, double normalizedDeltaY, MapleCanvasPoint location,
            MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_double_tap(
            MapleCanvasZoomState state, MapleCanvasPoint location, uint behavior,
            MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_reset_to_fit(MapleCanvasZoomState state);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_to_scale(MapleCanvasZoomState state, double scale);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_to_fill(
            MapleCanvasZoomState state, MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_step_in(
            MapleCanvasZoomState state, MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_step_out(
            MapleCanvasZoomState state, MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasZoomState maple_canvas_zoom_reclamp_pan(
            MapleCanvasZoomState state, MapleCanvasZoomContext context);

        /// <summary>`MAPLE_CANVAS_ZOOM_STOP_*`.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern uint maple_canvas_zoom_current_stop(MapleCanvasZoomState state);

        /// <summary>`MAPLE_CANVAS_DRAG_INTENT_*`.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern uint maple_canvas_zoom_drag_intent(
            MapleCanvasZoomState state, MapleCanvasZoomContext context);

        /// <summary>`MAPLE_CANVAS_WHEEL_INTENT_*`; `commandHeld` nonzero = Ctrl.</summary>
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern uint maple_canvas_zoom_wheel_intent(
            MapleCanvasZoomState state, byte commandHeld, MapleCanvasZoomContext context);

        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
        public static extern MapleCanvasMathResult maple_canvas_math_resolve(MapleCanvasMathInput input);
    }
}

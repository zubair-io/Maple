using System;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>How the viewer presents the zoom over its fit layout: the
    /// image scales by <see cref="ScaleToFit"/> about the viewport centre,
    /// then moves by the pan (points; positive = right/down).</summary>
    public readonly record struct CanvasZoomView(double ScaleToFit, double PanX, double PanY);

    /// <summary>
    /// The viewer's zoom state over the shared Rust model (#5714): every rule
    /// — fit / fill / 100% stops, the 0.5×fit … 8 range, release detents,
    /// steps, anchored wheel and pinch zoom, the pan clamp, continuity across
    /// geometry changes — runs in raw-core through raw_ffi.dll. This class
    /// only holds the state value between calls and translates Windows input
    /// units into the model's.
    /// </summary>
    public sealed class CanvasZoomController
    {
        /// <summary>One mouse-wheel detent, in `MouseWheelDelta` units.</summary>
        public const double WheelDetent = 120;

        /// <summary>A detent is 8 normalized units, Apple's factor for one
        /// line-scroll: `2^(8 × 0.015)` ≈ 1.09× per detent.</summary>
        public const double ZoomUnitsPerDetent = 8;

        /// <summary>Points panned per detent: Windows' default three lines.</summary>
        public const double PanPointsPerDetent = 48;

        private MapleCanvasZoomState _state;
        private MapleCanvasZoomContext _context = new() { display_scale = 1 };
        private MapleCanvasSize _picture;
        private MapleCanvasSize _crop = new(1, 1);

        public MapleCanvasZoomState State => _state;

        public MapleCanvasZoomContext Context => _context;

        public bool IsFit => RawFfi.maple_canvas_zoom_current_stop(_state) == RawFfi.MAPLE_CANVAS_ZOOM_STOP_FIT;

        public uint CurrentStop => RawFfi.maple_canvas_zoom_current_stop(_state);

        public bool IsPinching => _state.has_pinch_start_scale != 0;

        public bool CanPan =>
            RawFfi.maple_canvas_zoom_drag_intent(_state, _context) == RawFfi.MAPLE_CANVAS_DRAG_INTENT_PAN;

        public double FitScale => RawFfi.maple_canvas_zoom_fit_scale(_context);

        /// <summary>Real screen pixels per image pixel, fit resolved.</summary>
        public double EffectiveScale => Resolve().effective_pixel_scale;

        public CanvasZoomView View
        {
            get
            {
                var resolved = Resolve();
                var scaleToFit = resolved.fit_pixel_scale > 0
                    ? resolved.effective_pixel_scale / resolved.fit_pixel_scale
                    : 1;
                return new CanvasZoomView(scaleToFit, _state.pan_offset.width, _state.pan_offset.height);
            }
        }

        /// <summary>The source-pixel rectangle the viewport shows.</summary>
        public MapleCanvasRect VisibleSourceRect => Resolve().visible_source_rect;

        /// <summary>
        /// Feed the current viewport (points), the picture's extent, the
        /// committed crop's share of it and the points→pixels factor. The
        /// picture's pixels change meaning when one stand-in replaces another
        /// (thumbnail → preview → source size), so a picture-extent change
        /// keeps the image's on-screen rect. A crop applied, changed or
        /// cleared is a different extent of the same pixels, so like a
        /// viewport or display-scale change it carries 100% and a free zoom
        /// at their pixel scale. Either way fill re-resolves, the pan
        /// re-clamps and a live pinch or drag continues from the frame on
        /// screen, so a sync mid-pinch never pulls a below-fit pinch back to
        /// centre. A stand-in still decoding reports no extent: the last
        /// known one stands until the real one arrives, because an unknown
        /// extent replacing a known one would reopen the photo at fit.
        /// </summary>
        public void UpdateGeometry(double viewportWidth, double viewportHeight,
            double pictureWidth, double pictureHeight, double displayScale,
            double cropWidthFraction, double cropHeightFraction)
        {
            var reported = new MapleCanvasSize(pictureWidth, pictureHeight);
            var picture = HasArea(reported) || !HasArea(_picture) ? reported : _picture;
            var crop = new MapleCanvasSize(cropWidthFraction, cropHeightFraction);
            var previous = _context;
            var resolved = ZoomContext(viewportWidth, viewportHeight, picture, _crop, displayScale);
            var next = ZoomContext(viewportWidth, viewportHeight, picture, crop, displayScale);
            var carried = SameSize(picture, _picture)
                ? RawFfi.maple_canvas_zoom_geometry_changed(_state, previous, resolved)
                : RawFfi.maple_canvas_zoom_image_extent_resolved(_state, previous, resolved);
            _state = SameSize(crop, _crop)
                ? carried
                : RawFfi.maple_canvas_zoom_geometry_changed(carried, resolved, next);
            _picture = picture;
            _crop = crop;
            _context = next;
        }

        private static MapleCanvasZoomContext ZoomContext(double viewportWidth, double viewportHeight,
            MapleCanvasSize picture, MapleCanvasSize crop, double displayScale) =>
            RawFfi.maple_canvas_zoom_context_sanitize(new MapleCanvasZoomContext
            {
                viewport_points = new MapleCanvasSize(viewportWidth, viewportHeight),
                native_image_size = new MapleCanvasSize(picture.width * crop.width, picture.height * crop.height),
                display_scale = displayScale,
            });

        private static bool HasArea(MapleCanvasSize size) => size.width > 0 && size.height > 0;

        private static bool SameSize(MapleCanvasSize a, MapleCanvasSize b) =>
            a.width == b.width && a.height == b.height;

        public void ResetToFit() => _state = RawFfi.maple_canvas_zoom_reset_to_fit(_state, _context);

        /// <summary>The host stopped tracking its pointers without a release
        /// (navigation or a mode change mid-gesture): a live pinch settles at
        /// its last input and a live drag commits where it is, so neither
        /// outlives the contacts that drove it (#5739).</summary>
        public void CancelGestures() =>
            _state = RawFfi.maple_canvas_zoom_drag_cancelled(
                RawFfi.maple_canvas_zoom_pinch_cancelled(_state, _context));

        /// <summary>Another photo, or another mode's view of this one, takes
        /// the canvas: live gestures end, the zoom returns to fit and the
        /// extent is unknown again until the next
        /// <see cref="UpdateGeometry"/> reports one.</summary>
        public void ResetForNewPicture()
        {
            CancelGestures();
            _picture = default;
            _crop = new MapleCanvasSize(1, 1);
            _context = ZoomContext(_context.viewport_points.width, _context.viewport_points.height,
                _picture, _crop, _context.display_scale);
            ResetToFit();
        }

        /// <summary>Ctrl+1: 100%, re-centred.</summary>
        public void ZoomToActualSize() => _state = RawFfi.maple_canvas_zoom_to_scale(_state, 1, _context);

        /// <summary>Whether the viewport and image extent are known; before
        /// that, fit resolves against a stand-in and any relative zoom would
        /// jump once the first frame lands, so zoom input is ignored.</summary>
        public bool HasGeometry => HasExtent(_context);

        public void ZoomToFill()
        {
            if (HasGeometry) _state = RawFfi.maple_canvas_zoom_to_fill(_state, _context);
        }

        public void StepIn()
        {
            if (HasGeometry) _state = RawFfi.maple_canvas_zoom_step_in(_state, _context);
        }

        public void StepOut()
        {
            if (HasGeometry) _state = RawFfi.maple_canvas_zoom_step_out(_state, _context);
        }

        /// <summary>Editor double-click / double-tap: fit → 100% anchored at
        /// the point (viewport points), anything else → fit.</summary>
        public void DoubleTap(double x, double y)
        {
            if (!HasGeometry) return;
            _state = RawFfi.maple_canvas_zoom_double_tap(_state, new MapleCanvasPoint(x, y),
                RawFfi.MAPLE_CANVAS_DOUBLE_TAP_TOGGLE_FIT_AND_100, _context);
        }

        public void PanBy(double dx, double dy) =>
            _state = RawFfi.maple_canvas_zoom_wheel_pan(_state, new MapleCanvasSize(dx, dy), _context);

        /// <summary>
        /// One wheel event at (x, y) in viewport points. Ctrl zooms anchored at
        /// the cursor (a precision-touchpad pinch arrives this way too);
        /// otherwise the wheel pans when the image overflows — Shift or a
        /// tilt wheel horizontally. Returns false when the event is not the
        /// canvas's (nothing to pan, or a Ctrl+tilt).
        /// </summary>
        public bool Wheel(int delta, bool horizontal, bool ctrl, bool shift, double x, double y)
        {
            if (delta == 0 || !HasGeometry) return false;
            var detents = delta / WheelDetent;
            var intent = RawFfi.maple_canvas_zoom_wheel_intent(_state, (byte)(ctrl ? 1 : 0), _context);
            if (intent == RawFfi.MAPLE_CANVAS_WHEEL_INTENT_ZOOM)
            {
                if (horizontal) return false;
                _state = RawFfi.maple_canvas_zoom_wheel_zoom(_state, detents * ZoomUnitsPerDetent,
                    new MapleCanvasPoint(x, y), _context);
                return true;
            }
            if (intent != RawFfi.MAPLE_CANVAS_WHEEL_INTENT_PAN) return false;
            var points = detents * PanPointsPerDetent;
            if (horizontal) PanBy(-points, 0);
            else if (shift) PanBy(points, 0);
            else PanBy(0, points);
            return true;
        }

        /// <summary>A drag gesture starts: whatever a drag whose release never
        /// arrived left on screen is committed first, so this one cannot jump
        /// back by the lost drag's translation (#5739).</summary>
        public void DragBegan() => _state = RawFfi.maple_canvas_zoom_drag_began(_state);

        /// <summary>One drag frame; translation is cumulative from the press.
        /// Returns whether the drag panned.</summary>
        public bool DragChanged(double translationX, double translationY)
        {
            var transition = RawFfi.maple_canvas_zoom_drag_changed(_state,
                new MapleCanvasSize(translationX, translationY), _context);
            _state = transition.state;
            return transition.handled != 0;
        }

        public bool DragEnded()
        {
            var transition = RawFfi.maple_canvas_zoom_drag_ended(_state);
            _state = transition.state;
            return transition.handled != 0;
        }

        /// <summary>One pinch frame: cumulative magnification since the
        /// pinch began, centroid in viewport points.</summary>
        public void PinchChanged(double magnification, double x, double y)
        {
            if (HasGeometry)
                _state = RawFfi.maple_canvas_zoom_pinch_changed(_state, magnification,
                    new MapleCanvasPoint(x, y), _context);
        }

        public void PinchEnded(double magnification) =>
            _state = RawFfi.maple_canvas_zoom_pinch_ended(_state, magnification, _context);

        /// <summary>One touch event's meaning, applied in the update's
        /// order. <paramref name="dragPans"/> is false while a canvas tool
        /// owns one-finger drags.</summary>
        public void ApplyTouch(CanvasTouchUpdate update, bool dragPans)
        {
            if (update.DragBegan) DragBegan();
            if (update.PinchEndedMagnification is { } magnification) PinchEnded(magnification);
            if (update.Pinch is { } pinch) PinchChanged(pinch.Magnification, pinch.X, pinch.Y);
            if (update.DragTranslation is { } translation && dragPans) DragChanged(translation.X, translation.Y);
            if (update.DragEnded) DragEnded();
        }

        private MapleCanvasMathResult Resolve() => RawFfi.maple_canvas_math_resolve(new MapleCanvasMathInput
        {
            viewport_px = RawFfi.maple_canvas_zoom_viewport_px(_context),
            native_image_size = _context.native_image_size,
            pixel_scale = _state.pixel_scale,
            pan_offset = _state.pan_offset,
            display_scale = _context.display_scale,
        });

        private static bool HasExtent(MapleCanvasZoomContext context) =>
            context.native_image_size.width > 0 && context.native_image_size.height > 0
            && context.viewport_points.width > 0 && context.viewport_points.height > 0;
    }
}

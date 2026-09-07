using System;
using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>Normalized mask-space point: X across the image width, Y down
    /// from the top edge, both in [0, 1] — the same space raw-core's
    /// `stages::local_adjustments::mask` evaluates in. Mirrors
    /// <c>Maple.WinUI.Models.MaskPoint</c> field-for-field but stays local to
    /// this design-system layer, the same split <see cref="MuiCropRect"/>
    /// keeps from <c>Maple.WinUI.Models.CropState</c>.</summary>
    public readonly record struct MuiMaskPoint(double X, double Y)
    {
        public static MuiMaskPoint operator +(MuiMaskPoint a, MuiMaskPoint b) => new(a.X + b.X, a.Y + b.Y);
        public static MuiMaskPoint operator -(MuiMaskPoint a, MuiMaskPoint b) => new(a.X - b.X, a.Y - b.Y);
    }

    /// <summary>A mask's geometry only — no feather/invert, since neither has
    /// an overlay handle (mask-panel.md's Feather slider and Invert toggle
    /// are the only way to change them). Mirrors the shape half of
    /// <c>Maple.WinUI.Models.LocalMask</c>.</summary>
    public abstract record MuiMaskShape;

    public sealed record MuiLinearMaskShape(MuiMaskPoint Start, MuiMaskPoint End) : MuiMaskShape;

    /// <summary>Angle is radians, counter-clockwise about Center — same
    /// convention as raw-core's <c>Mask::Radial</c>.</summary>
    public sealed record MuiRadialMaskShape(MuiMaskPoint Center, MuiMaskPoint Radii, double Angle) : MuiMaskShape;

    /// <summary>The drag handles a Mask Overlay exposes (mask-overlay.md
    /// § Variants / Accessibility): linear's start/end pins plus a body
    /// midpoint that translates the whole gradient; radial's center pin,
    /// one pin per local axis (resize), and a rotation pin beyond the
    /// x-axis pin.</summary>
    public enum MuiMaskHandle { LinearStart, LinearEnd, LinearBody, RadialCenter, RadialRadiusX, RadialRadiusY, RadialRotate }

    /// <summary>
    /// The handle-drag math behind <see cref="MuiMaskOverlay"/> — the masking
    /// sibling of <see cref="MuiCropOverlayMath"/>. Pure over
    /// <see cref="MuiMaskShape"/> — unit tested without a live Window.
    ///
    /// raw-core's mask evaluator (`stages/local_adjustments/mask.rs`)
    /// deliberately does NOT aspect-correct: "a circular radial mask on a
    /// 16:9 image draws as an ellipse on screen unless the UI pre-corrects."
    /// Every method here therefore does its rotation math in NORMALIZED
    /// space (mixing "fraction of width" and "fraction of height" the same
    /// way the Rust evaluator's `radial_weight` does) and converts to screen
    /// pixels only at the boundary — so a handle always sits exactly where
    /// the render actually applies the mask, even on a non-square-aspect,
    /// rotated ellipse. <see cref="ApplyDrag"/> for
    /// <see cref="MuiMaskHandle.RadialRadiusX"/>/<see cref="MuiMaskHandle.RadialRadiusY"/>
    /// projects the pointer onto the ellipse's local axis with the exact
    /// inverse of `radial_weight`'s forward rotation, so a resize drag and
    /// the render agree on where the boundary lands.
    /// </summary>
    public static class MuiMaskOverlayMath
    {
        /// <summary>Grab radius in screen px — mask-overlay.md § Tokens:
        /// "matching Crop Overlay."</summary>
        public const double GrabToleranceScreenPx = 14;

        /// <summary>Rotation pin sits this far beyond the radius-X pin,
        /// along the same local axis (mask-overlay.md's "beyond the x-axis
        /// pin").</summary>
        private const double RotationHandleFactor = 1.3;

        public static MuiMaskPoint ToScreen(MuiMaskPoint normalized, double boundsW, double boundsH) =>
            new(normalized.X * boundsW, normalized.Y * boundsH);

        public static MuiMaskPoint ToNormalized(MuiMaskPoint screen, double boundsW, double boundsH) =>
            new(boundsW > 0 ? screen.X / boundsW : 0, boundsH > 0 ? screen.Y / boundsH : 0);

        /// <summary>World-space (normalized) offset of a radial handle whose
        /// LOCAL ellipse-space offset is (lx, ly) — the forward rotation
        /// that is the exact inverse of `radial_weight`'s world→local
        /// projection.</summary>
        private static MuiMaskPoint RotateLocalToWorld(double lx, double ly, double angle)
        {
            var cos = Math.Cos(angle);
            var sin = Math.Sin(angle);
            return new MuiMaskPoint(cos * lx - sin * ly, sin * lx + cos * ly);
        }

        /// <summary>Every handle's position in normalized mask space, for
        /// the shape's kind only (a linear shape yields no radial handles
        /// and vice versa).</summary>
        public static IReadOnlyDictionary<MuiMaskHandle, MuiMaskPoint> HandlePositions(MuiMaskShape shape) =>
            shape switch
            {
                MuiLinearMaskShape l => new Dictionary<MuiMaskHandle, MuiMaskPoint>
                {
                    [MuiMaskHandle.LinearStart] = l.Start,
                    [MuiMaskHandle.LinearEnd] = l.End,
                    [MuiMaskHandle.LinearBody] = new((l.Start.X + l.End.X) / 2, (l.Start.Y + l.End.Y) / 2),
                },
                MuiRadialMaskShape r => new Dictionary<MuiMaskHandle, MuiMaskPoint>
                {
                    [MuiMaskHandle.RadialCenter] = r.Center,
                    [MuiMaskHandle.RadialRadiusX] = r.Center + RotateLocalToWorld(r.Radii.X, 0, r.Angle),
                    [MuiMaskHandle.RadialRadiusY] = r.Center + RotateLocalToWorld(0, r.Radii.Y, r.Angle),
                    [MuiMaskHandle.RadialRotate] = r.Center + RotateLocalToWorld(r.Radii.X * RotationHandleFactor, 0, r.Angle),
                },
                _ => throw new ArgumentException($"unknown shape {shape.GetType().Name}", nameof(shape)),
            };

        /// <summary>Samples the ellipse boundary in the same normalized,
        /// non-aspect-corrected space <see cref="HandlePositions"/> and
        /// raw-core's `radial_weight` use, so the drawn outline always
        /// matches where the mask's `w == 1` edge actually falls (before
        /// feather) — never a screen-space `RotateTransform` on an
        /// already-anisotropically-scaled ellipse, which would rotate
        /// around the wrong axes on a non-square-aspect image.</summary>
        public static IReadOnlyList<MuiMaskPoint> RadialOutline(MuiRadialMaskShape shape, int segments = 48)
        {
            var points = new List<MuiMaskPoint>(segments);
            for (var i = 0; i < segments; i++)
            {
                var t = 2 * Math.PI * i / segments;
                points.Add(shape.Center + RotateLocalToWorld(
                    shape.Radii.X * Math.Cos(t), shape.Radii.Y * Math.Sin(t), shape.Angle));
            }
            return points;
        }

        /// <summary>Precedence order for overlapping hit-tests — endpoint/
        /// rotation pins win over the body/center handle underneath them.</summary>
        private static readonly MuiMaskHandle[] LinearPrecedence =
            { MuiMaskHandle.LinearStart, MuiMaskHandle.LinearEnd, MuiMaskHandle.LinearBody };

        private static readonly MuiMaskHandle[] RadialPrecedence =
            { MuiMaskHandle.RadialRotate, MuiMaskHandle.RadialRadiusX, MuiMaskHandle.RadialRadiusY, MuiMaskHandle.RadialCenter };

        /// <summary>The nearest handle within <paramref name="toleranceScreenPx"/>
        /// of a screen-space pointer point, honoring the precedence order, or
        /// null when nothing is in range.</summary>
        public static MuiMaskHandle? HitTest(
            MuiMaskShape shape, MuiMaskPoint screenPoint, double boundsW, double boundsH,
            double toleranceScreenPx = GrabToleranceScreenPx)
        {
            var positions = HandlePositions(shape);
            var order = shape is MuiLinearMaskShape ? LinearPrecedence : RadialPrecedence;
            foreach (var handle in order)
            {
                var screen = ToScreen(positions[handle], boundsW, boundsH);
                var dx = screen.X - screenPoint.X;
                var dy = screen.Y - screenPoint.Y;
                if (Math.Sqrt(dx * dx + dy * dy) <= toleranceScreenPx)
                    return handle;
            }
            return null;
        }

        /// <summary>The shape after dragging <paramref name="handle"/> so it
        /// tracks <paramref name="screenPointerPos"/>. Radius handles project
        /// the pointer onto the ellipse's local axis (the exact inverse of
        /// `radial_weight`'s forward rotation); the rotate handle reads the
        /// angle straight off the pointer's normalized offset from center.</summary>
        public static MuiMaskShape ApplyDrag(
            MuiMaskShape shape, MuiMaskHandle handle, MuiMaskPoint screenPointerPos, double boundsW, double boundsH)
        {
            var pointer = ToNormalized(screenPointerPos, boundsW, boundsH);
            switch (shape)
            {
                case MuiLinearMaskShape l:
                    return handle switch
                    {
                        MuiMaskHandle.LinearStart => l with { Start = pointer },
                        MuiMaskHandle.LinearEnd => l with { End = pointer },
                        MuiMaskHandle.LinearBody => Translate(l, pointer),
                        _ => l,
                    };
                case MuiRadialMaskShape r:
                    return handle switch
                    {
                        MuiMaskHandle.RadialCenter => r with { Center = pointer },
                        MuiMaskHandle.RadialRadiusX => r with { Radii = r.Radii with { X = ProjectOntoAxis(pointer, r, isXAxis: true) } },
                        MuiMaskHandle.RadialRadiusY => r with { Radii = r.Radii with { Y = ProjectOntoAxis(pointer, r, isXAxis: false) } },
                        MuiMaskHandle.RadialRotate => r with { Angle = Math.Atan2(pointer.Y - r.Center.Y, pointer.X - r.Center.X) },
                        _ => r,
                    };
                default:
                    throw new ArgumentException($"unknown shape {shape.GetType().Name}", nameof(shape));
            }
        }

        /// <summary>Translates both linear endpoints so the pointer sits at
        /// the new midpoint (dragging the gradient's body handle).</summary>
        private static MuiLinearMaskShape Translate(MuiLinearMaskShape l, MuiMaskPoint pointer)
        {
            var mid = new MuiMaskPoint((l.Start.X + l.End.X) / 2, (l.Start.Y + l.End.Y) / 2);
            var delta = pointer - mid;
            return new MuiLinearMaskShape(l.Start + delta, l.End + delta);
        }

        /// <summary>`lx = cos(a)·dx + sin(a)·dy`, `ly = -sin(a)·dx + cos(a)·dy`
        /// — identical to `radial_weight`'s world→local inverse-rotate, so a
        /// resize handle lands exactly where the render's ellipse boundary
        /// will move to. A near-zero result floors at a small positive value
        /// so the ellipse never degenerates to a line the user can't grab
        /// again.</summary>
        private const double MinRadius = 0.005;

        private static double ProjectOntoAxis(MuiMaskPoint pointer, MuiRadialMaskShape r, bool isXAxis)
        {
            var dx = pointer.X - r.Center.X;
            var dy = pointer.Y - r.Center.Y;
            var cos = Math.Cos(r.Angle);
            var sin = Math.Sin(r.Angle);
            var projected = isXAxis ? cos * dx + sin * dy : -sin * dx + cos * dy;
            return Math.Max(MinRadius, Math.Abs(projected));
        }
    }
}

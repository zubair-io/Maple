using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>
    /// Port of the shared tone-curve evaluator (web tone-curve-math.ts, itself
    /// a line-for-line port of raw_core::stages::tone_curves::evaluator):
    /// Fritsch–Carlson monotone cubic Hermite over [0,1]² knots. Plus the
    /// plot's editing rules (tone-curve-edit.ts): materialization, insert
    /// collision, endpoint pinning, delete-to-identity.
    ///
    /// Moved from <c>Maple.WinUI.Controls.ToneCurveMath</c> in the MN2 wave
    /// (#3051): <see cref="MuiCurvePlot"/> owns the tone-curve editing
    /// gestures now, so the control-agnostic math lives beside it, WinUI-free
    /// (same split as <see cref="MuiCurvePlotMath"/>) and linkable into
    /// Maple.WinUI.Tests without a live Window. Operates on the plot's own
    /// normalized <see cref="MuiCurvePoint"/>; the app converts to its
    /// sidecar-facing <c>Models.CurvePoint</c> at the boundary.
    /// </summary>
    public static class MuiToneCurveMath
    {
        public const double MinXGap = 1.0 / 256;
        public const double HitRadius = 0.045;          // authoring units

        /// <summary>Clamp both coords to [0,1], sort by x, de-dupe equal-x
        /// neighbours keeping the LATER point (matches Rust dedup_by).</summary>
        public static List<MuiCurvePoint> PrepareCurve(IReadOnlyList<MuiCurvePoint> points)
        {
            var sorted = points
                .Select(p => new MuiCurvePoint(Clamp01(p.X), Clamp01(p.Y)))
                .OrderBy(p => p.X)
                .ToList();
            var deduped = new List<MuiCurvePoint>(sorted.Count);
            foreach (var p in sorted)
            {
                if (deduped.Count > 0 && deduped[^1].X == p.X)
                    deduped[^1] = p;                     // keep the later point
                else
                    deduped.Add(p);
            }
            return deduped;
        }

        /// <summary>Evaluate the prepared curve at x. Empty = identity,
        /// single knot = constant, outside the knot span = clamped ends.</summary>
        public static double Eval(IReadOnlyList<MuiCurvePoint> knots, double x)
        {
            var n = knots.Count;
            if (n == 0) return Clamp01(x);
            if (n == 1) return knots[0].Y;
            if (x <= knots[0].X) return knots[0].Y;
            if (x >= knots[n - 1].X) return knots[n - 1].Y;

            var slopes = new double[n - 1];
            for (var i = 0; i < n - 1; i++)
                slopes[i] = (knots[i + 1].Y - knots[i].Y) / (knots[i + 1].X - knots[i].X);

            var tangents = new double[n];
            tangents[0] = slopes[0];
            for (var i = 1; i < n - 1; i++)
                tangents[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) * 0.5;
            tangents[n - 1] = slopes[n - 2];

            // Monotonicity guard: project each (alpha, beta) into radius 3.
            for (var i = 0; i < n - 1; i++)
            {
                var m = slopes[i];
                if (Math.Abs(m) < double.Epsilon)
                {
                    tangents[i] = 0;
                    tangents[i + 1] = 0;
                    continue;
                }
                var alpha = tangents[i] / m;
                var beta = tangents[i + 1] / m;
                var mag = Math.Sqrt(alpha * alpha + beta * beta);
                if (mag > 3)
                {
                    var scale = 3 / mag;
                    tangents[i] = scale * alpha * m;
                    tangents[i + 1] = scale * beta * m;
                }
            }

            var seg = 0;
            while (seg < n - 2 && knots[seg + 1].X <= x) seg++;
            var (x0, y0) = (knots[seg].X, knots[seg].Y);
            var (x1, y1) = (knots[seg + 1].X, knots[seg + 1].Y);
            var h = x1 - x0;
            var t = (x - x0) / h;
            var t2 = t * t;
            var t3 = t2 * t;
            var y = (2 * t3 - 3 * t2 + 1) * y0
                  + (t3 - 2 * t2 + t) * h * tangents[seg]
                  + (-2 * t3 + 3 * t2) * y1
                  + (t3 - t2) * h * tangents[seg + 1];
            return Clamp01(y);
        }

        // --- plot editing rules (tone-curve-edit.ts) ---

        /// <summary>An empty (identity) curve materializes as the anchor pair
        /// so the first click yields 3 knots, never a lone constant knot.</summary>
        public static List<MuiCurvePoint> Materialize(IReadOnlyList<MuiCurvePoint> points) =>
            points.Count > 0
                ? new List<MuiCurvePoint>(points)
                : new List<MuiCurvePoint> { new(0, 0), new(1, 1) };

        /// <summary>Nearest knot within the hit radius, or -1.</summary>
        public static int HitTest(IReadOnlyList<MuiCurvePoint> points, double x, double y)
        {
            var best = -1;
            var bestDist = HitRadius;
            for (var i = 0; i < points.Count; i++)
            {
                var d = Math.Sqrt((points[i].X - x) * (points[i].X - x)
                                + (points[i].Y - y) * (points[i].Y - y));
                if (d <= bestDist)
                {
                    best = i;
                    bestDist = d;
                }
            }
            return best;
        }

        /// <summary>Insert at (x, y); returns the new index, or -1 when an
        /// existing knot is within MinXGap in x (collision no-op).</summary>
        public static int InsertPoint(List<MuiCurvePoint> points, double x, double y)
        {
            if (points.Any(p => Math.Abs(p.X - x) < MinXGap))
                return -1;
            var insertAt = points.TakeWhile(p => p.X < x).Count();
            points.Insert(insertAt, new MuiCurvePoint(Clamp01(x), Clamp01(y)));
            return insertAt;
        }

        /// <summary>Drag constraints: endpoints move vertically only; interior
        /// x stays MinXGap clear of its neighbours; y is just clamped.</summary>
        public static void MovePoint(List<MuiCurvePoint> points, int index, double x, double y)
        {
            var cx = index == 0 ? 0
                : index == points.Count - 1 ? 1
                : Math.Clamp(Clamp01(x), points[index - 1].X + MinXGap, points[index + 1].X - MinXGap);
            points[index] = new MuiCurvePoint(cx, Clamp01(y));
        }

        /// <summary>Remove a knot; the bare anchor pair collapses back to the
        /// canonical empty identity so untouched sidecars stay byte-clean.</summary>
        public static void RemovePoint(List<MuiCurvePoint> points, int index)
        {
            points.RemoveAt(index);
            if (points.Count == 2
                && points[0] == new MuiCurvePoint(0, 0) && points[1] == new MuiCurvePoint(1, 1))
                points.Clear();
        }

        private static double Clamp01(double v) => Math.Clamp(v, 0, 1);

        /// <summary>Cross-platform parity anchor — the same vector raw-core,
        /// the web port, and ToneCurveMathTests.swift all assert. Throws on
        /// drift; call at startup in debug builds (VerifyAbi pattern).</summary>
        public static void VerifyParity()
        {
            var knots = PrepareCurve(new[]
            {
                new MuiCurvePoint(0, 0), new MuiCurvePoint(0.25, 0.15),
                new MuiCurvePoint(0.6, 0.72), new MuiCurvePoint(1, 1),
            });
            var expected = new[]
            {
                0.0, 0.047657, 0.103543, 0.215379, 0.386152, 0.570335,
                0.72, 0.816116, 0.883214, 0.938705, 1.0,
            };
            for (var i = 0; i <= 10; i++)
            {
                var y = Eval(knots, i / 10.0);
                if (Math.Abs(y - expected[i]) > 1e-5)
                    throw new InvalidOperationException(
                        $"tone-curve parity drift at x={i / 10.0}: got {y}, expected {expected[i]}");
            }
        }
    }
}

// ColorCurveMath — pure C# math & stage-input sampler for the Oklab secondary
// color curves (#5077), WinUI-free so Maple.WinUI.Tests can exercise it on any OS.

using System;
using Maple.WinUI.Generated;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services
{
    public enum ColorCurveKind
    {
        HueVsHue,
        HueVsSat,
        HueVsLuma,
        LumaVsSat,
        SatVsSat,
        SatVsLuma,
    }

    public readonly record struct QuickHueAnchor(string Label, double HueDeg)
    {
        public double X => HueDeg / 360.0;
    }

    public static class ColorCurveMath
    {
        /// <summary>Maximum |Δy / Δx| slope allowed for Hue vs Hue to prevent hue folding.</summary>
        public const double MaxHueSlope = ColorCurveEditorTuning.MaxHueSlope;

        /// <summary>Default ±Δx spread for 3-point local notches.</summary>
        public const double DefaultSpread = ColorCurveEditorTuning.AnchorSpread;

        /// <summary>Minimum x separation to avoid duplicate knots.</summary>
        public const double MinKnotGap = ColorCurveEditorTuning.MinKnotGap;

        /// <summary>Six canonical Oklab hue quick-anchors.</summary>
        public static readonly QuickHueAnchor[] QuickHueAnchors = ColorCurveCalibration.QuickHueAnchors
            .Select(anchor => new QuickHueAnchor(anchor.Label, anchor.HueDeg)).ToArray();

        public static readonly IReadOnlyList<double> SkinToneGuardDeg = ColorCurveCalibration.SkinToneGuardDeg;

        public static bool IsPeriodic(this ColorCurveKind kind) =>
            kind is ColorCurveKind.HueVsHue or ColorCurveKind.HueVsSat or ColorCurveKind.HueVsLuma;

        public static string ShortTitle(this ColorCurveKind kind) => kind switch
        {
            ColorCurveKind.HueVsHue => "H vs H",
            ColorCurveKind.HueVsSat => "H vs S",
            ColorCurveKind.HueVsLuma => "H vs L",
            ColorCurveKind.LumaVsSat => "L vs S",
            ColorCurveKind.SatVsSat => "S vs S",
            ColorCurveKind.SatVsLuma => "S vs L",
            _ => "H vs S",
        };

        public static string Title(this ColorCurveKind kind) => kind switch
        {
            ColorCurveKind.HueVsHue => "Hue vs Hue",
            ColorCurveKind.HueVsSat => "Hue vs Sat",
            ColorCurveKind.HueVsLuma => "Hue vs Luma",
            ColorCurveKind.LumaVsSat => "Luma vs Sat",
            ColorCurveKind.SatVsSat => "Sat vs Sat",
            ColorCurveKind.SatVsLuma => "Sat vs Luma",
            _ => "Hue vs Sat",
        };

        public static double SampleX(this ColorCurveKind kind, MapleColorCurveSample sample) => kind switch
        {
            ColorCurveKind.HueVsHue or ColorCurveKind.HueVsSat or ColorCurveKind.HueVsLuma => sample.u_h,
            ColorCurveKind.LumaVsSat => sample.u_l,
            ColorCurveKind.SatVsSat or ColorCurveKind.SatVsLuma => sample.u_c,
            _ => sample.u_h,
        };

        public static List<CurvePoint> CurvePoints(AdjustmentState state, ColorCurveKind kind) => kind switch
        {
            ColorCurveKind.HueVsHue => state.ColorCurveHueVsHue,
            ColorCurveKind.HueVsSat => state.ColorCurveHueVsSat,
            ColorCurveKind.HueVsLuma => state.ColorCurveHueVsLuma,
            ColorCurveKind.LumaVsSat => state.ColorCurveLumaVsSat,
            ColorCurveKind.SatVsSat => state.ColorCurveSatVsSat,
            ColorCurveKind.SatVsLuma => state.ColorCurveSatVsLuma,
            _ => state.ColorCurveHueVsSat,
        };

        private static double Wrap01(double x) => x - Math.Floor(x);

        public static double ClampX(ColorCurveKind kind, IReadOnlyList<CurvePoint> points, int index, double proposed)
        {
            var lower = index > 0 ? points[index - 1].X + MinKnotGap :
                kind.IsPeriodic() && points.Count > 1 ? Math.Max(0, points[^1].X - 1 + MinKnotGap) : 0;
            var upper = index + 1 < points.Count ? points[index + 1].X - MinKnotGap :
                kind.IsPeriodic() && points.Count > 1 ? Math.Min(1, points[0].X + 1 - MinKnotGap) : 1;
            return lower > upper ? points[index].X : Math.Clamp(proposed, lower, upper);
        }

        public static List<CurvePoint> InsertAnchor(
            IReadOnlyList<CurvePoint> points,
            double x,
            ColorCurveKind kind,
            double spread = DefaultSpread,
            double centerY = 0.5)
        {
            var isPeriodic = kind.IsPeriodic();
            var cx = isPeriodic ? Wrap01(x) : Math.Clamp(x, 0.0, 1.0);
            var cy = Math.Clamp(centerY, 0.0, 1.0);
            var lx = isPeriodic ? Wrap01(cx - spread) : Math.Max(0.0, cx - spread);
            var rx = isPeriodic ? Wrap01(cx + spread) : Math.Min(1.0, cx + spread);

            var outPts = points.Select(p => new CurvePoint(p.X, p.Y)).ToList();

            void Upsert(double px, double py, bool overwriteY)
            {
                var idx = outPts.FindIndex(pt =>
                {
                    var d = Math.Abs(pt.X - px);
                    var dist = isPeriodic ? Math.Min(d, 1.0 - d) : d;
                    return dist < MinKnotGap;
                });
                if (idx >= 0)
                {
                    if (overwriteY)
                        outPts[idx] = new CurvePoint(px, py);
                }
                else if (outPts.Count < ColorCurveEditorTuning.MaxKnots)
                {
                    outPts.Add(new CurvePoint(px, py));
                }
            }

            Upsert(cx, cy, true);
            if (Math.Abs(lx - cx) >= MinKnotGap)
                Upsert(lx, 0.5, false);
            if (Math.Abs(rx - cx) >= MinKnotGap)
                Upsert(rx, 0.5, false);

            outPts.Sort((a, b) => a.X.CompareTo(b.X));
            return outPts;
        }

        public static List<CurvePoint> LockSkinTone(IReadOnlyList<CurvePoint> points)
        {
            var outPts = points.Select(p => new CurvePoint(p.X, p.Y)).ToList();
            foreach (var deg in SkinToneGuardDeg)
            {
                var px = deg / 360.0;
                var idx = outPts.FindIndex(pt =>
                {
                    var d = Math.Abs(pt.X - px);
                    return Math.Min(d, 1.0 - d) < MinKnotGap;
                });
                if (idx >= 0)
                    outPts[idx] = new CurvePoint(px, 0.5);
                else if (outPts.Count < ColorCurveEditorTuning.MaxKnots)
                    outPts.Add(new CurvePoint(px, 0.5));
            }
            outPts.Sort((a, b) => a.X.CompareTo(b.X));
            return outPts;
        }

        public static double ClampY(
            double proposedY,
            int index,
            IReadOnlyList<CurvePoint> points,
            ColorCurveKind kind)
        {
            var y = Math.Clamp(proposedY, 0.0, 1.0);
            if (kind != ColorCurveKind.HueVsHue || points.Count < 2 || index < 0 || index >= points.Count)
                return y;

            var n = points.Count;
            var curr = points[index];
            var prev = points[(index + n - 1) % n];
            var next = points[(index + 1) % n];

            var dxPrev = index == 0 ? (curr.X + 1.0) - prev.X : curr.X - prev.X;
            var dxNext = index == n - 1 ? (next.X + 1.0) - curr.X : next.X - curr.X;

            if (dxPrev > 1e-4)
            {
                var maxDelta = MaxHueSlope * dxPrev;
                y = Math.Clamp(y, prev.Y - maxDelta, prev.Y + maxDelta);
            }
            if (dxNext > 1e-4)
            {
                var maxDelta = MaxHueSlope * dxNext;
                y = Math.Clamp(y, next.Y - maxDelta, next.Y + maxDelta);
            }
            return Math.Clamp(y, 0.0, 1.0);
        }

        public static double Evaluate(IReadOnlyList<CurvePoint> points, double u, ColorCurveKind kind)
        {
            if (points.Count == 0) return 0.5;
            if (points.Count == 1) return Math.Clamp(points[0].Y, 0.0, 1.0);

            var sorted = points.OrderBy(p => p.X).ToList();
            return kind.IsPeriodic()
                ? EvaluatePeriodic(sorted, Wrap01(u))
                : EvaluateClamped(sorted, Math.Clamp(u, 0.0, 1.0));
        }

        private static double Hermite(double x0, double y0, double m0, double x1, double y1, double m1, double x)
        {
            var h = x1 - x0;
            if (h <= 1e-6) return y0;
            var t = Math.Clamp((x - x0) / h, 0.0, 1.0);
            var t2 = t * t;
            var t3 = t2 * t;
            var h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
            var h10 = t3 - 2.0 * t2 + t;
            var h01 = -2.0 * t3 + 3.0 * t2;
            var h11 = t3 - t2;
            return Math.Clamp(h00 * y0 + h10 * h * m0 + h01 * y1 + h11 * h * m1, 0.0, 1.0);
        }

        private static double FritschCarlsonTangent(double hPrev, double dPrev, double hNext, double dNext)
        {
            if (dPrev * dNext <= 0.0) return 0.0;
            var w1 = 2.0 * hNext + hPrev;
            var w2 = hNext + 2.0 * hPrev;
            return (w1 + w2) / (w1 / dPrev + w2 / dNext);
        }

        private static double EvaluatePeriodic(IReadOnlyList<CurvePoint> knots, double u)
        {
            var n = knots.Count;
            var h = new double[n];
            var d = new double[n];
            for (var i = 0; i < n; i++)
            {
                var x0 = knots[i].X;
                var y0 = knots[i].Y;
                var x1 = i + 1 < n ? knots[i + 1].X : knots[0].X + 1.0;
                var y1 = i + 1 < n ? knots[i + 1].Y : knots[0].Y;
                var dx = Math.Max(x1 - x0, 1e-6);
                h[i] = dx;
                d[i] = (y1 - y0) / dx;
            }
            var m = new double[n];
            for (var i = 0; i < n; i++)
            {
                var prev = (i + n - 1) % n;
                m[i] = FritschCarlsonTangent(h[prev], d[prev], h[i], d[i]);
            }
            for (var i = 0; i < n; i++)
            {
                var next = (i + 1) % n;
                var dk = d[i];
                if (Math.Abs(dk) < 1e-7)
                {
                    m[i] = 0.0;
                    m[next] = 0.0;
                }
                else
                {
                    var alpha = m[i] / dk;
                    var beta = m[next] / dk;
                    var r2 = alpha * alpha + beta * beta;
                    if (r2 > 9.0)
                    {
                        var tau = 3.0 / Math.Sqrt(r2);
                        m[i] = tau * alpha * dk;
                        m[next] = tau * beta * dk;
                    }
                }
            }
            var xQuery = u < knots[0].X ? u + 1.0 : u;
            var seg = n - 1;
            for (var i = 0; i < n - 1; i++)
            {
                if (xQuery >= knots[i].X && xQuery <= knots[i + 1].X)
                {
                    seg = i;
                    break;
                }
            }
            var sx0 = knots[seg].X;
            var sy0 = knots[seg].Y;
            var sx1 = seg + 1 < n ? knots[seg + 1].X : knots[0].X + 1.0;
            var sy1 = seg + 1 < n ? knots[seg + 1].Y : knots[0].Y;
            var sm1 = seg + 1 < n ? m[seg + 1] : m[0];
            return Hermite(sx0, sy0, m[seg], sx1, sy1, sm1, xQuery);
        }

        private static double EvaluateClamped(IReadOnlyList<CurvePoint> knots, double u)
        {
            var n = knots.Count;
            if (u <= knots[0].X) return Math.Clamp(knots[0].Y, 0.0, 1.0);
            if (u >= knots[n - 1].X) return Math.Clamp(knots[n - 1].Y, 0.0, 1.0);
            var h = new double[n - 1];
            var d = new double[n - 1];
            for (var i = 0; i < n - 1; i++)
            {
                var dx = Math.Max(knots[i + 1].X - knots[i].X, 1e-6);
                h[i] = dx;
                d[i] = (knots[i + 1].Y - knots[i].Y) / dx;
            }
            var m = new double[n];
            m[0] = d[0];
            m[n - 1] = d[n - 2];
            for (var i = 1; i < n - 1; i++)
                m[i] = FritschCarlsonTangent(h[i - 1], d[i - 1], h[i], d[i]);
            for (var i = 0; i < n - 1; i++)
            {
                var dk = d[i];
                if (Math.Abs(dk) < 1e-7)
                {
                    m[i] = 0.0;
                    m[i + 1] = 0.0;
                }
                else
                {
                    var alpha = m[i] / dk;
                    var beta = m[i + 1] / dk;
                    var r2 = alpha * alpha + beta * beta;
                    if (r2 > 9.0)
                    {
                        var tau = 3.0 / Math.Sqrt(r2);
                        m[i] = tau * alpha * dk;
                        m[i + 1] = tau * beta * dk;
                    }
                }
            }
            var seg = 0;
            for (var i = 0; i < n - 1; i++)
            {
                if (u >= knots[i].X && u <= knots[i + 1].X)
                {
                    seg = i;
                    break;
                }
            }
            return Hermite(knots[seg].X, knots[seg].Y, m[seg], knots[seg + 1].X, knots[seg + 1].Y, m[seg + 1], u);
        }

        public static string SampleFailureMessage(int code) => code switch
        {
            11 => "Click inside the photo.",
            13 => "This area is too dark. Choose a brighter area.",
            15 => "This color is too neutral. Choose a more saturated area.",
            _ => "Could not sample this photo. Reopen it or choose another photo.",
        };

        /// <summary>Samples the stage-input Oklab coordinates at normalized (nx, ny)
        /// in the uncropped, EXIF-oriented frame via <c>maple_sample_color_curve_oriented</c>.</summary>
        public static (MapleColorCurveSample? Sample, int Code, string? Error) SampleStageInput(
            string rawPath,
            AdjustmentState model,
            double nx,
            double ny)
        {
            string? dir = null;
            try
            {
                dir = Path.Combine(Path.GetTempPath(), "maple-cc-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                var xmpPath = Path.Combine(dir, "probe.xmp");
                File.WriteAllText(xmpPath, XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = model.Clone() }));
                var rc = RawFfi.maple_sample_color_curve_oriented(
                    rawPath, xmpPath, (float)nx, (float)ny, out var sample);
                if (rc == 0) return (sample, 0, null);
                DiagLog.Write($"[color-curves] sample rejected ({rc}): {RawFfi.LastError()}");
                return (null, rc, SampleFailureMessage(rc));
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[color-curves] sample failed: {ex}");
                return (null, -1, SampleFailureMessage(-1));
            }
            finally
            {
                try { if (dir != null) Directory.Delete(dir, recursive: true); }
                catch { /* best effort */ }
            }
        }
    }
}

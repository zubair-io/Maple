using System;
using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class ColorCurveMathTests
    {
        [Fact]
        public void InsertAnchor_PlacesSortedThreePointNotch()
        {
            var pts = ColorCurveMath.InsertAnchor(
                Array.Empty<CurvePoint>(),
                142.0 / 360.0,
                ColorCurveKind.HueVsSat,
                spread: 0.08,
                centerY: 0.65);

            Assert.Equal(3, pts.Count);
            Assert.True(pts[0].X < pts[1].X && pts[1].X < pts[2].X);
            Assert.Equal(0.5, pts[0].Y, 6);
            Assert.Equal(0.65, pts[1].Y, 6);
            Assert.Equal(0.5, pts[2].Y, 6);
        }

        [Fact]
        public void InsertAnchor_WrapsAcrossZeroAndOneForPeriodicHueCurves()
        {
            var pts = ColorCurveMath.InsertAnchor(
                Array.Empty<CurvePoint>(),
                0.02,
                ColorCurveKind.HueVsHue,
                spread: 0.08,
                centerY: 0.5);

            Assert.Equal(3, pts.Count);
            Assert.Equal(0.02, pts[0].X, 6);
            Assert.Equal(0.10, pts[1].X, 6);
            Assert.Equal(0.94, pts[2].X, 6);
        }

        [Fact]
        public void LockSkinTone_PlacesGuardPinsAt38_55_72Degrees()
        {
            var pts = ColorCurveMath.LockSkinTone(Array.Empty<CurvePoint>());
            Assert.Equal(3, pts.Count);
            Assert.Equal(38.0 / 360.0, pts[0].X, 6);
            Assert.Equal(55.0 / 360.0, pts[1].X, 6);
            Assert.Equal(72.0 / 360.0, pts[2].X, 6);
            foreach (var p in pts)
                Assert.Equal(0.5, p.Y, 6);
        }

        [Fact]
        public void ClampY_PreventsHueFoldingOnHueVsHue()
        {
            var pts = new List<CurvePoint>
            {
                new(0.40, 0.50),
                new(0.44, 0.50),
                new(0.48, 0.50),
            };
            var clampedHigh = ColorCurveMath.ClampY(1.0, 1, pts, ColorCurveKind.HueVsHue);
            Assert.Equal(0.60, clampedHigh, 6);

            var clampedLow = ColorCurveMath.ClampY(0.0, 1, pts, ColorCurveKind.HueVsHue);
            Assert.Equal(0.40, clampedLow, 6);

            var unclamped = ColorCurveMath.ClampY(1.0, 1, pts, ColorCurveKind.HueVsSat);
            Assert.Equal(1.0, unclamped, 6);
        }

        [Fact]
        public void Evaluate_MatchesPeriodicWraparoundAndClampedEndpoints()
        {
            Assert.Equal(0.5, ColorCurveMath.Evaluate(Array.Empty<CurvePoint>(), 0.3, ColorCurveKind.HueVsSat), 6);

            var periodic = new List<CurvePoint>
            {
                new(0.20, 0.50),
                new(0.50, 0.75),
                new(0.80, 0.50),
            };
            var y0 = ColorCurveMath.Evaluate(periodic, 0.0, ColorCurveKind.HueVsSat);
            var y1 = ColorCurveMath.Evaluate(periodic, 0.999999, ColorCurveKind.HueVsSat);
            Assert.Equal(y0, y1, 4);

            var clamped = new List<CurvePoint>
            {
                new(0.25, 0.30),
                new(0.75, 0.80),
            };
            Assert.Equal(0.30, ColorCurveMath.Evaluate(clamped, 0.05, ColorCurveKind.LumaVsSat), 6);
            Assert.Equal(0.80, ColorCurveMath.Evaluate(clamped, 0.95, ColorCurveKind.LumaVsSat), 6);
        }
    }
}

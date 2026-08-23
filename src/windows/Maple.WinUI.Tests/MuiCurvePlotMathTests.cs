// MuiCurvePlotMathTests — the pure drag/hit-test/smoothing math behind the
// Maple.UI Curve Plot data plot
// (Maple.WinUI/MapleUI/Molecules/MuiCurvePlotMath.cs, wave N3b of the
// Windows Maple.UI molecules, #3012). No WinUI/live Window involved. Covers
// the midpoint-quadratic curve interpolation specifically (BuildSmoothedPath).

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiCurvePlotMathTests
    {
        [Fact]
        public void BuildSmoothedPath_ThreePoints_OneQuadThenOneLine()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            var segments = MuiCurvePlotMath.BuildSmoothedPath(points, out var start);

            Assert.Equal(new MuiCurvePoint(0, 0), start);
            Assert.Equal(2, segments.Count);

            var quad = Assert.IsType<MuiCurveQuadTo>(segments[0]);
            Assert.Equal(new MuiCurvePoint(0.5, 0.5), quad.Control);
            Assert.Equal(new MuiCurvePoint(0.75, 0.75), quad.To); // midpoint of (0.5,0.5) and (1,1)

            var line = Assert.IsType<MuiCurveLineTo>(segments[1]);
            Assert.Equal(new MuiCurvePoint(1, 1), line.To);
        }

        [Fact]
        public void BuildSmoothedPath_UnsortedPoints_SortsByXFirst()
        {
            var points = new List<MuiCurvePoint> { new(1, 1), new(0, 0), new(0.5, 0.9), new(0.3, 0.2) };
            var segments = MuiCurvePlotMath.BuildSmoothedPath(points, out var start);

            Assert.Equal(new MuiCurvePoint(0, 0), start); // smallest X, regardless of input order
            Assert.Equal(3, segments.Count); // 2 interior quads + 1 final line

            var firstQuad = Assert.IsType<MuiCurveQuadTo>(segments[0]);
            Assert.Equal(new MuiCurvePoint(0.3, 0.2), firstQuad.Control);
            Assert.Equal(new MuiCurvePoint(0.4, 0.55), firstQuad.To);

            var lastSegment = Assert.IsType<MuiCurveLineTo>(segments[2]);
            Assert.Equal(new MuiCurvePoint(1, 1), lastSegment.To);
        }

        [Fact]
        public void BuildSmoothedPath_FewerThanTwoPoints_YieldsNoSegments()
        {
            Assert.Empty(MuiCurvePlotMath.BuildSmoothedPath(new List<MuiCurvePoint>(), out _));
            Assert.Empty(MuiCurvePlotMath.BuildSmoothedPath(new List<MuiCurvePoint> { new(0.4, 0.6) }, out var start));
            Assert.Equal(new MuiCurvePoint(0.4, 0.6), start);
        }

        [Fact]
        public void ToCanvasPoint_And_FromCanvasPoint_RoundTrip()
        {
            var canvas = MuiCurvePlotMath.ToCanvasPoint(new MuiCurvePoint(0.25, 0.75), width: 200, height: 100);
            Assert.Equal(new MuiCurvePoint(50, 25), canvas);

            var model = MuiCurvePlotMath.FromCanvasPoint(50, 25, width: 200, height: 100);
            Assert.Equal(new MuiCurvePoint(0.25, 0.75), model);
        }

        [Fact]
        public void FromCanvasPoint_ZeroDimension_ReadsAsZeroOnThatAxis()
        {
            var model = MuiCurvePlotMath.FromCanvasPoint(50, 25, width: 0, height: 0);
            Assert.Equal(new MuiCurvePoint(0, 0), model);
        }

        [Fact]
        public void HitTest_WithinRadius_ReturnsIndex()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            // Canvas point for (0.5, 0.5) at 200x100 is (100, 50).
            Assert.Equal(1, MuiCurvePlotMath.HitTest(points, 100, 57, 200, 100)); // 7px away, within 8px radius
        }

        [Fact]
        public void HitTest_OutsideRadius_ReturnsNull()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            Assert.Null(MuiCurvePlotMath.HitTest(points, 100, 59, 200, 100)); // 9px away, outside 8px radius
        }

        [Theory]
        [InlineData("Up", 0.5, 0.52)]
        [InlineData("Down", 0.5, 0.48)]
        [InlineData("Right", 0.52, 0.5)]
        [InlineData("Left", 0.48, 0.5)]
        public void Nudge_StepsByNudgeStep(string key, double expectedX, double expectedY)
        {
            var result = MuiCurvePlotMath.Nudge(new MuiCurvePoint(0.5, 0.5), key);
            Assert.Equal(expectedX, result.X, 6);
            Assert.Equal(expectedY, result.Y, 6);
        }

        [Fact]
        public void Nudge_ClampsAtBounds()
        {
            var result = MuiCurvePlotMath.Nudge(new MuiCurvePoint(0.99, 0.5), "Right");
            Assert.Equal(1, result.X, 6);
        }

        [Fact]
        public void Nudge_UnrecognizedKey_ReturnsPointUnchanged()
        {
            var point = new MuiCurvePoint(0.5, 0.5);
            Assert.Equal(point, MuiCurvePlotMath.Nudge(point, "Enter"));
        }
    }
}

// MuiToneCurveMathTests — the pure Fritsch–Carlson evaluator + tone-curve
// editing rules behind the Maple.UI Curve Plot's PointEditing/MonotoneCubic
// mode (Maple.WinUI/MapleUI/Molecules/MuiToneCurveMath.cs, moved from the
// app's Controls layer in the MN2 wave, #3051). No WinUI/live Window
// involved. The parity vector matches raw-core, the web port's
// tone-curve-math.ts, and ToneCurveMathTests.swift.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiToneCurveMathTests
    {
        // --- evaluator ---

        [Fact]
        public void VerifyParity_CrossPlatformVector_DoesNotThrow()
        {
            MuiToneCurveMath.VerifyParity();
        }

        [Fact]
        public void Eval_EmptyCurve_IsIdentity()
        {
            var knots = new List<MuiCurvePoint>();
            Assert.Equal(0.0, MuiToneCurveMath.Eval(knots, 0), 10);
            Assert.Equal(0.37, MuiToneCurveMath.Eval(knots, 0.37), 10);
            Assert.Equal(1.0, MuiToneCurveMath.Eval(knots, 1), 10);
        }

        [Fact]
        public void Eval_SingleKnot_IsConstant()
        {
            var knots = new List<MuiCurvePoint> { new(0.5, 0.3) };
            Assert.Equal(0.3, MuiToneCurveMath.Eval(knots, 0.0), 10);
            Assert.Equal(0.3, MuiToneCurveMath.Eval(knots, 0.9), 10);
        }

        [Fact]
        public void Eval_OutsideKnotSpan_ClampsToEndValues()
        {
            var knots = MuiToneCurveMath.PrepareCurve(new[]
            {
                new MuiCurvePoint(0.2, 0.1), new MuiCurvePoint(0.8, 0.9),
            });
            Assert.Equal(0.1, MuiToneCurveMath.Eval(knots, 0.0), 10);
            Assert.Equal(0.9, MuiToneCurveMath.Eval(knots, 1.0), 10);
        }

        [Fact]
        public void PrepareCurve_ClampsSortsAndDedupesKeepingLaterPoint()
        {
            var prepared = MuiToneCurveMath.PrepareCurve(new[]
            {
                new MuiCurvePoint(0.9, 1.4),        // clamps y to 1
                new MuiCurvePoint(0.5, 0.2),
                new MuiCurvePoint(0.5, 0.6),        // same x — later point wins
                new MuiCurvePoint(-0.2, 0.1),       // clamps x to 0
            });
            Assert.Equal(new List<MuiCurvePoint>
            {
                new(0, 0.1), new(0.5, 0.6), new(0.9, 1),
            }, prepared);
        }

        // --- editing rules ---

        [Fact]
        public void Materialize_EmptyList_YieldsAnchorPair()
        {
            var working = MuiToneCurveMath.Materialize(new List<MuiCurvePoint>());
            Assert.Equal(new List<MuiCurvePoint> { new(0, 0), new(1, 1) }, working);
        }

        [Fact]
        public void Materialize_NonEmpty_CopiesWithoutSharing()
        {
            var source = new List<MuiCurvePoint> { new(0, 0), new(0.4, 0.5), new(1, 1) };
            var working = MuiToneCurveMath.Materialize(source);
            Assert.Equal(source, working);
            Assert.NotSame(source, working);
        }

        [Fact]
        public void HitTest_PicksNearestKnotWithinRadius()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            Assert.Equal(1, MuiToneCurveMath.HitTest(points, 0.52, 0.52));
            Assert.Equal(-1, MuiToneCurveMath.HitTest(points, 0.5, 0.8));   // outside 0.045
        }

        [Fact]
        public void InsertPoint_KeepsXOrder_AndReportsIndex()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(1, 1) };
            var index = MuiToneCurveMath.InsertPoint(points, 0.5, 0.75);
            Assert.Equal(1, index);
            Assert.Equal(new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.75), new(1, 1) }, points);
        }

        [Fact]
        public void InsertPoint_WithinMinXGapOfExisting_IsNoOp()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            var index = MuiToneCurveMath.InsertPoint(points, 0.5 + MuiToneCurveMath.MinXGap / 2, 0.9);
            Assert.Equal(-1, index);
            Assert.Equal(3, points.Count);
        }

        [Fact]
        public void MovePoint_EndpointsMoveVerticallyOnly()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            MuiToneCurveMath.MovePoint(points, 0, 0.3, 0.2);
            MuiToneCurveMath.MovePoint(points, 2, 0.7, 0.8);
            Assert.Equal(new MuiCurvePoint(0, 0.2), points[0]);
            Assert.Equal(new MuiCurvePoint(1, 0.8), points[2]);
        }

        [Fact]
        public void MovePoint_InteriorXStaysMinXGapClearOfNeighbours()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.5), new(1, 1) };
            MuiToneCurveMath.MovePoint(points, 1, 1.5, 0.5);   // way past the right endpoint
            Assert.Equal(1 - MuiToneCurveMath.MinXGap, points[1].X, 10);
        }

        [Fact]
        public void RemovePoint_BareAnchorPair_CollapsesToEmptyIdentity()
        {
            var points = new List<MuiCurvePoint> { new(0, 0), new(0.5, 0.75), new(1, 1) };
            MuiToneCurveMath.RemovePoint(points, 1);
            Assert.Empty(points);
        }

        [Fact]
        public void RemovePoint_NonAnchorRemainder_IsKept()
        {
            var points = new List<MuiCurvePoint> { new(0, 0.1), new(0.5, 0.75), new(1, 1) };
            MuiToneCurveMath.RemovePoint(points, 1);
            Assert.Equal(new List<MuiCurvePoint> { new(0, 0.1), new(1, 1) }, points);
        }
    }
}

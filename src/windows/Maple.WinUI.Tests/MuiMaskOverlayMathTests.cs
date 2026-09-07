// MuiMaskOverlayMathTests — the handle math behind the Maple.UI Mask
// Overlay organism (Maple.WinUI/MapleUI/Organisms/MuiMaskOverlayMath.cs,
// #3406). No WinUI/live Window involved.

using System;
using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiMaskOverlayMathTests
    {
        [Fact]
        public void LinearBodyHandleSitsAtTheMidpoint()
        {
            var shape = new MuiLinearMaskShape(new MuiMaskPoint(0.2, 0.4), new MuiMaskPoint(0.8, 0.6));
            var positions = MuiMaskOverlayMath.HandlePositions(shape);
            Assert.Equal(new MuiMaskPoint(0.5, 0.5), positions[MuiMaskHandle.LinearBody]);
        }

        [Fact]
        public void DraggingLinearBodyTranslatesBothEndpoints()
        {
            var shape = new MuiLinearMaskShape(new MuiMaskPoint(0.2, 0.4), new MuiMaskPoint(0.8, 0.6));
            // Pointer moves the midpoint from (0.5, 0.5) to (0.6, 0.5) — a
            // +0.1 world-space delta on X, applied to both endpoints.
            var next = (MuiLinearMaskShape)MuiMaskOverlayMath.ApplyDrag(
                shape, MuiMaskHandle.LinearBody, new MuiMaskPoint(60, 50), 100, 100);
            Assert.Equal(new MuiMaskPoint(0.3, 0.4), next.Start);
            Assert.Equal(new MuiMaskPoint(0.9, 0.6), next.End);
        }

        [Fact]
        public void DraggingLinearStartMovesOnlyStart()
        {
            var shape = new MuiLinearMaskShape(new MuiMaskPoint(0.2, 0.4), new MuiMaskPoint(0.8, 0.6));
            var next = (MuiLinearMaskShape)MuiMaskOverlayMath.ApplyDrag(
                shape, MuiMaskHandle.LinearStart, new MuiMaskPoint(10, 10), 100, 100);
            Assert.Equal(new MuiMaskPoint(0.1, 0.1), next.Start);
            Assert.Equal(new MuiMaskPoint(0.8, 0.6), next.End);
        }

        [Fact]
        public void RadiusHandlesSitOnTheUnrotatedLocalAxesWhenAngleIsZero()
        {
            var shape = new MuiRadialMaskShape(new MuiMaskPoint(0.5, 0.5), new MuiMaskPoint(0.3, 0.2), 0);
            var positions = MuiMaskOverlayMath.HandlePositions(shape);
            Assert.Equal(new MuiMaskPoint(0.8, 0.5), positions[MuiMaskHandle.RadialRadiusX]);
            Assert.Equal(new MuiMaskPoint(0.5, 0.7), positions[MuiMaskHandle.RadialRadiusY]);
        }

        [Fact]
        public void RotationHandleSitsBeyondTheRadiusXPin()
        {
            var shape = new MuiRadialMaskShape(new MuiMaskPoint(0.5, 0.5), new MuiMaskPoint(0.3, 0.2), 0);
            var positions = MuiMaskOverlayMath.HandlePositions(shape);
            // 1.3 * 0.3 == 0.39 beyond center on the local x-axis.
            Assert.Equal(0.5 + 0.39, positions[MuiMaskHandle.RadialRotate].X, precision: 6);
            Assert.Equal(0.5, positions[MuiMaskHandle.RadialRotate].Y, precision: 6);
        }

        [Fact]
        public void RadiusHandlePositionsMatchRawCoresInverseRotationAtANonZeroAngle()
        {
            // raw-core's radial_weight inverse-rotates a world offset (dx,dy)
            // into local space via lx = cos·dx + sin·dy, ly = -sin·dx + cos·dy.
            // The forward handle position must be the exact inverse of that,
            // so re-deriving lx/ly from the handle's own world position must
            // return exactly (radii.X, 0) / (0, radii.Y).
            var angle = 0.7;
            var shape = new MuiRadialMaskShape(new MuiMaskPoint(0.4, 0.6), new MuiMaskPoint(0.3, 0.15), angle);
            var positions = MuiMaskOverlayMath.HandlePositions(shape);

            var xHandle = positions[MuiMaskHandle.RadialRadiusX];
            var dx = xHandle.X - shape.Center.X;
            var dy = xHandle.Y - shape.Center.Y;
            var lx = Math.Cos(angle) * dx + Math.Sin(angle) * dy;
            var ly = -Math.Sin(angle) * dx + Math.Cos(angle) * dy;
            Assert.Equal(0.3, lx, precision: 6);
            Assert.Equal(0.0, ly, precision: 6);
        }

        [Fact]
        public void DraggingRadiusXProjectsThePointerOntoTheLocalAxis()
        {
            var angle = 0.7;
            var shape = new MuiRadialMaskShape(new MuiMaskPoint(0.4, 0.6), new MuiMaskPoint(0.3, 0.15), angle);
            var positions = MuiMaskOverlayMath.HandlePositions(shape);
            var handleScreen = MuiMaskOverlayMath.ToScreen(positions[MuiMaskHandle.RadialRadiusX], 100, 100);

            var next = (MuiRadialMaskShape)MuiMaskOverlayMath.ApplyDrag(
                shape, MuiMaskHandle.RadialRadiusX, handleScreen, 100, 100);

            // Dragging the handle back onto its own current position must be
            // a no-op on the radius it controls.
            Assert.Equal(shape.Radii.X, next.Radii.X, precision: 6);
            Assert.Equal(shape.Radii.Y, next.Radii.Y, precision: 6); // untouched
        }

        [Fact]
        public void DraggingRotateHandleReadsTheAngleFromThePointer()
        {
            var shape = new MuiRadialMaskShape(new MuiMaskPoint(0.5, 0.5), new MuiMaskPoint(0.3, 0.2), 0);
            // Pointer straight above center in normalized space -> angle = -pi/2
            // (screen Y grows downward, matching atan2(dy, dx) with dy < 0).
            var next = (MuiRadialMaskShape)MuiMaskOverlayMath.ApplyDrag(
                shape, MuiMaskHandle.RadialRotate, new MuiMaskPoint(50, 0), 100, 100);
            Assert.Equal(-Math.PI / 2, next.Angle, precision: 6);
        }

        [Fact]
        public void HitTestPrefersEndpointsOverTheBodyHandleWhenOverlapping()
        {
            // A near-zero-length gradient puts start, end and body all at
            // effectively the same screen point.
            var shape = new MuiLinearMaskShape(new MuiMaskPoint(0.5, 0.5), new MuiMaskPoint(0.501, 0.5));
            var hit = MuiMaskOverlayMath.HitTest(shape, new MuiMaskPoint(50, 50), 100, 100);
            Assert.Equal(MuiMaskHandle.LinearStart, hit);
        }

        [Fact]
        public void HitTestReturnsNullOutsideTolerance()
        {
            // Start (20,20), end (80,80), body (50,50) in screen space — a
            // far corner is >14px from all three.
            var shape = new MuiLinearMaskShape(new MuiMaskPoint(0.2, 0.2), new MuiMaskPoint(0.8, 0.8));
            var hit = MuiMaskOverlayMath.HitTest(shape, new MuiMaskPoint(95, 5), 100, 100);
            Assert.Null(hit);
        }

        [Fact]
        public void RadialOutlineStartsAtTheZeroDegreeLocalPointAndHasTheRequestedSegmentCount()
        {
            var shape = new MuiRadialMaskShape(new MuiMaskPoint(0.5, 0.5), new MuiMaskPoint(0.3, 0.2), 0);
            var outline = MuiMaskOverlayMath.RadialOutline(shape, segments: 8);
            Assert.Equal(8, outline.Count);
            Assert.Equal(new MuiMaskPoint(0.8, 0.5), outline[0], EqualityComparer());
        }

        private static IEqualityComparer<MuiMaskPoint> EqualityComparer() => new ApproxComparer();

        private sealed class ApproxComparer : IEqualityComparer<MuiMaskPoint>
        {
            public bool Equals(MuiMaskPoint a, MuiMaskPoint b) =>
                Math.Abs(a.X - b.X) < 1e-6 && Math.Abs(a.Y - b.Y) < 1e-6;
            public int GetHashCode(MuiMaskPoint p) => 0;
        }
    }
}

// MuiSheetShellDragLogicTests — the detent/drag-threshold math behind the
// Maple.UI Sheet Shell template
// (Maple.WinUI/MapleUI/Templates/MuiSheetShellDragLogic.cs, wave N5 of the
// Windows Maple.UI templates, #3012). No WinUI/live Window involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSheetShellDragLogicTests
    {
        [Fact]
        public void ClampPanDown_NegativeDy_ReturnsZero()
        {
            Assert.Equal(0, MuiSheetShellDragLogic.ClampPanDown(-40));
        }

        [Fact]
        public void ClampPanDown_ZeroDy_ReturnsZero()
        {
            Assert.Equal(0, MuiSheetShellDragLogic.ClampPanDown(0));
        }

        [Fact]
        public void ClampPanDown_PositiveDy_ReturnsSameValue()
        {
            Assert.Equal(64, MuiSheetShellDragLogic.ClampPanDown(64));
        }

        [Fact]
        public void IsDistanceDismissed_BelowThreshold_ReturnsFalse()
        {
            Assert.False(MuiSheetShellDragLogic.IsDistanceDismissed(dy: 50, sheetHeight: 400, fraction: 0.25));
        }

        [Fact]
        public void IsDistanceDismissed_AtThreshold_ReturnsTrue()
        {
            Assert.True(MuiSheetShellDragLogic.IsDistanceDismissed(dy: 100, sheetHeight: 400, fraction: 0.25));
        }

        [Fact]
        public void IsDistanceDismissed_AboveThreshold_ReturnsTrue()
        {
            Assert.True(MuiSheetShellDragLogic.IsDistanceDismissed(dy: 250, sheetHeight: 400, fraction: 0.25));
        }

        [Fact]
        public void IsDistanceDismissed_ZeroHeightSheet_ReturnsFalse()
        {
            // Not-yet-measured sheet — never treat a drag as dismissing
            // before the sheet has a real height.
            Assert.False(MuiSheetShellDragLogic.IsDistanceDismissed(dy: 999, sheetHeight: 0, fraction: 0.25));
        }

        [Fact]
        public void HeightFraction_DefaultsToFirstDetent()
        {
            Assert.Equal(0.4, MuiSheetShellDragLogic.HeightFraction(detents: null, activeDetent: 0));
        }

        [Fact]
        public void HeightFraction_CustomDetents_ResolvesByIndex()
        {
            var detents = new List<double> { 0.3, 0.6, 0.95 };
            Assert.Equal(0.6, MuiSheetShellDragLogic.HeightFraction(detents, activeDetent: 1));
        }

        [Fact]
        public void HeightFraction_OutOfRangeIndex_FallsBackToFirstDetent()
        {
            var detents = new List<double> { 0.5, 0.8 };
            Assert.Equal(0.5, MuiSheetShellDragLogic.HeightFraction(detents, activeDetent: 5));
        }

        [Fact]
        public void HeightFraction_EmptyDetents_FallsBackToDefault()
        {
            Assert.Equal(0.4, MuiSheetShellDragLogic.HeightFraction(new List<double>(), activeDetent: 0));
        }
    }
}

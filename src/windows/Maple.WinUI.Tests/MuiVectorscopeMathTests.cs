// MuiVectorscopeMathTests — the pure BT.601 chroma-projection math behind
// the Maple.UI Vectorscope data plot
// (Maple.WinUI/MapleUI/Molecules/MuiVectorscopeMath.cs, wave N3b of the
// Windows Maple.UI molecules, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiVectorscopeMathTests
    {
        [Fact]
        public void ToChroma_White_IsNeutral()
        {
            var (cb, cr) = MuiVectorscopeMath.ToChroma(1, 1, 1);
            Assert.Equal(0, cb, 6);
            Assert.Equal(0, cr, 6);
        }

        [Fact]
        public void ToChroma_Black_IsNeutral()
        {
            var (cb, cr) = MuiVectorscopeMath.ToChroma(0, 0, 0);
            Assert.Equal(0, cb, 6);
            Assert.Equal(0, cr, 6);
        }

        [Fact]
        public void ToChroma_PureRed_MatchesBt601Coefficients()
        {
            var (cb, cr) = MuiVectorscopeMath.ToChroma(1, 0, 0);
            Assert.Equal(-0.168736, cb, 6);
            Assert.Equal(0.5, cr, 6);
        }

        [Fact]
        public void ToChroma_PureBlue_MatchesBt601Coefficients()
        {
            var (cb, cr) = MuiVectorscopeMath.ToChroma(0, 0, 1);
            Assert.Equal(0.5, cb, 6);
            Assert.Equal(-0.081312, cr, 6);
        }

        [Fact]
        public void ToPoint_NeutralSample_PlotsAtCenter()
        {
            var (x, y) = MuiVectorscopeMath.ToPoint(1, 1, 1, cx: 50, cy: 50, radius: 40);
            Assert.Equal(50, x, 6);
            Assert.Equal(50, y, 6);
        }

        [Fact]
        public void ToPoint_PureRed_PlotsUpAndLeftOfCenter()
        {
            var (x, y) = MuiVectorscopeMath.ToPoint(1, 0, 0, cx: 50, cy: 50, radius: 40);
            Assert.Equal(36.50112, x, 5);
            Assert.Equal(10, y, 6); // positive Cr plots upward (smaller Y)
        }

        [Fact]
        public void ToPoint_ScalesByDiameterNotRadius()
        {
            // A saturated sample's chroma magnitude is scaled by radius*2
            // (the full diameter), not radius alone — verified by checking
            // the offset from center is exactly cb/cr * (radius * 2).
            var (x, _) = MuiVectorscopeMath.ToPoint(0, 0, 1, cx: 0, cy: 0, radius: 10);
            Assert.Equal(0.5 * 20, x, 6);
        }
    }
}

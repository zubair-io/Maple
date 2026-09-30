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
        public void Broadcast_targets_use_nonuniform_shared_rec709_directions()
        {
            Assert.InRange(MuiVectorscopeMath.TargetAngle(0), 102.90, 102.92);
            Assert.InRange(MuiVectorscopeMath.TargetAngle(4), -5.25, -5.23);
            var gaps = Enumerable.Range(0, 6).Select(i => MuiVectorscopeMath.NormalizeAngle(
                MuiVectorscopeMath.TargetAngle((i + 1) % 6) - MuiVectorscopeMath.TargetAngle(i))).ToArray();
            Assert.InRange(gaps.Min(), 53, 55);
            Assert.InRange(gaps.Max(), 71, 73);
            Assert.Equal(360, gaps.Sum(), 8);
        }

        [Fact]
        public void Hue_ring_matches_all_six_markers_and_wraps_without_a_seam()
        {
            (double R, double G, double B)[] expected = [(1,0,0), (1,1,0), (0,1,0), (0,1,1), (0,0,1), (1,0,1)];
            for (var i = 0; i < 6; i++)
            {
                var color = MuiVectorscopeMath.RingRgb(MuiVectorscopeMath.TargetAngle(i));
                Assert.Equal(expected[i].R, color.R, 10);
                Assert.Equal(expected[i].G, color.G, 10);
                Assert.Equal(expected[i].B, color.B, 10);
            }
            Assert.Equal(MuiVectorscopeMath.RingRgb(0), MuiVectorscopeMath.RingRgb(360));
            Assert.Equal(MuiVectorscopeMath.RingRgb(359), MuiVectorscopeMath.RingRgb(-1));
        }

        [Fact]
        public void Native_positive_cr_density_appears_at_top_with_premultiplied_color()
        {
            uint[] bins = [1, 0, 255, 0];
            var pixels = MuiVectorscopeMath.DensityPixels(bins, 2, 200, 100, 50);
            Assert.Equal(new byte[] { 50, 100, 200, 255 }, pixels.Take(4));
            Assert.All(pixels.Skip(4).Take(4), value => Assert.Equal(0, value));
            Assert.InRange(pixels[11], 39, 254);
            Assert.True(pixels[8] <= pixels[9] && pixels[9] <= pixels[10] && pixels[10] <= pixels[11]);
            Assert.All(MuiVectorscopeMath.DensityPixels(new uint[4], 2, 255, 255, 255), value => Assert.Equal(0, value));
            Assert.Throws<ArgumentException>(() => MuiVectorscopeMath.DensityPixels(new uint[3], 2, 0, 0, 0));
        }

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

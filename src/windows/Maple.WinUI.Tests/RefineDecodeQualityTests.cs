// RefineDecodeQualityTests — the refine-phase decode-quality escalation
// rule (#3417). RenderEngine.Decode used to hard-code quality_preview=1
// (Preview, a half-res 2×2-binned demosaic) for every request regardless of
// how large a target it was asked for, so on a sensor whose native long
// edge is more than double the requested target the FFI silently returned
// a half-res buffer — visible at high zoom as blurred, binned pixels
// upscaled to fill the canvas. RefineDecodeQuality.ForTarget mirrors
// Apple's ImageEditPipeline.refineDecodeQuality (#2143): escalate to AMaZE
// exactly when the target genuinely needs more than half-res detail.

using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RefineDecodeQualityTests
    {
        [Fact]
        public void StaysAtPreviewWhenTargetIsAtMostHalfNative()
        {
            // 100 MP reference DNG: native long edge ~11656px. A 1600px
            // decode target (the editor's DefaultPreviewLongEdge) sits well
            // under half of that — Preview's own cap never engages, so
            // Preview already delivers exactly the requested target.
            Assert.Equal(
                RefineDecodeQuality.Preview,
                RefineDecodeQuality.ForTarget(nativeLongEdge: 11656, targetLongEdge: 1600));
        }

        [Fact]
        public void StaysAtPreviewExactlyAtTheHalfNativeBoundary()
        {
            // targetLongEdge == nativeLongEdge / 2 is still inside what
            // Preview can deliver unaided — the escalation is strictly ">".
            Assert.Equal(
                RefineDecodeQuality.Preview,
                RefineDecodeQuality.ForTarget(nativeLongEdge: 4000, targetLongEdge: 2000));
        }

        [Fact]
        public void EscalatesToAmazeJustPastTheHalfNativeBoundary()
        {
            Assert.Equal(
                RefineDecodeQuality.Amaze,
                RefineDecodeQuality.ForTarget(nativeLongEdge: 4000, targetLongEdge: 2001));
        }

        [Fact]
        public void EscalatesToAmazeAtHundredPercentZoomOnTheReferenceDng()
        {
            // The ticket's acceptance case: a 100% zoom refine ROI on the
            // 100 MP reference DNG requests (up to) native resolution —
            // far past half the sensor's native long edge.
            Assert.Equal(
                RefineDecodeQuality.Amaze,
                RefineDecodeQuality.ForTarget(nativeLongEdge: 11656, targetLongEdge: 11656));
        }

        [Theory]
        [InlineData(0, 2000)]
        [InlineData(-1, 2000)]
        [InlineData(double.NaN, 2000)]
        [InlineData(double.PositiveInfinity, 2000)]
        public void StaysAtPreviewWhenNativeLongEdgeIsUnknown(double nativeLongEdge, double targetLongEdge)
        {
            // No native reference (EXIF unreadable, or a degenerate value)
            // means there is nothing to size the escalation decision
            // against — the conservative default matches Apple's fallback.
            Assert.Equal(
                RefineDecodeQuality.Preview,
                RefineDecodeQuality.ForTarget(nativeLongEdge, targetLongEdge));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        public void StaysAtPreviewWhenTargetLongEdgeIsDegenerate(double targetLongEdge)
        {
            Assert.Equal(
                RefineDecodeQuality.Preview,
                RefineDecodeQuality.ForTarget(nativeLongEdge: 4000, targetLongEdge));
        }
    }
}

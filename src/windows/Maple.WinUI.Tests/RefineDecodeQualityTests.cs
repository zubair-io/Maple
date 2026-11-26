// RefineDecodeQualityTests — the refine-phase decode-quality escalation
// rule (#3417). RenderEngine.Decode used to hard-code quality_preview=1
// (Preview, a half-res 2×2-binned demosaic) for every request regardless of
// how large a target it was asked for, so on a sensor whose native long
// edge is more than double the requested target the FFI silently returned
// a half-res buffer — visible at high zoom as blurred, binned pixels
// upscaled to fill the canvas. RefineDecodeQuality.ForTarget mirrors
// Apple's ImageEditPipeline.refineDecodeQuality (#2143): escalate to AMaZE
// exactly when the target genuinely needs more than half-res detail.
//
// #3417 review: escalating the SAME decode that feeds cold open regressed
// the 250-1000ms uncached-open budget on large sensors (waiting on a full
// AMaZE demosaic before the first paint). The fix keeps the first decode at
// Preview always and schedules a second, cancellable decode
// afterward — ShouldScheduleUpgrade decides whether that follow-up is
// worth it, and IsStillCurrent decides whether its result should still be
// applied once it lands (a photo switch or another decode-owned edit must
// drop a stale result rather than swap it in over a newer base).

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

        // --- ShouldScheduleUpgrade: the cold-open decode is ALWAYS Preview
        // (never decided by this rule); this only answers whether a
        // follow-up non-Preview decode is worth scheduling afterward. Two
        // cases share it: the target exceeds half the sensor (full-detail
        // AMaZE), or twice the target fits in the sensor, where the core's
        // bounded Bayer decode reconstructs with RCD instead of binning
        // (#6067, core #5921 / develop_sized.rs). ---

        [Theory]
        [InlineData(11656, 1600)]   // 100 MP long edge
        [InlineData(6000, 1600)]    // 24 MP long edge
        [InlineData(3200, 1600)]    // exactly twice the target
        public void SchedulesTheBoundedUpgradeForABayerSensorAtLeastTwiceTheTarget(
            double nativeLongEdge, double targetLongEdge)
        {
            Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(
                nativeLongEdge, targetLongEdge, RefineDecodeQuality.BayerLayout));
        }

        [Theory]
        [InlineData(11656, 1600)]
        [InlineData(6000, 1600)]
        public void DoesNotRepeatTheDecodeForSourcesTheBoundedBranchDoesNotImprove(
            double nativeLongEdge, double targetLongEdge)
        {
            foreach (var layout in new[] { "xtrans", "linear_rgb", "unknown", "", null })
                Assert.False(RefineDecodeQuality.ShouldScheduleUpgrade(nativeLongEdge, targetLongEdge, layout));
        }

        [Fact]
        public void SchedulesFullDetailBetweenHalfNativeAndNativeRegardlessOfLayout()
        {
            // Target above half the sensor: the existing AMaZE upgrade, kept
            // for every layout (the bounded branch needs 2 × target ≤ native).
            foreach (var layout in new[] { RefineDecodeQuality.BayerLayout, "xtrans", "linear_rgb", null })
                Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(4000, 2001, layout));
            Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(
                nativeLongEdge: 11656, targetLongEdge: 11656, RefineDecodeQuality.BayerLayout));
        }

        [Fact]
        public void BoundedAndFullDetailCasesMeetAtTheHalfNativeBoundary()
        {
            Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(4000, 2000, RefineDecodeQuality.BayerLayout));
            Assert.False(RefineDecodeQuality.ShouldScheduleUpgrade(4000, 2000, "xtrans"));
            Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(4000, 2001, "xtrans"));
        }

        [Fact]
        public void TinySensorAtTheDefaultTargetTakesTheFullDetailCase()
        {
            // The 64 px synthetic lifecycle DNG: 2 × 1600 never fits, so the
            // bounded branch cannot run; the full-detail case still does.
            Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(64, 1600, RefineDecodeQuality.BayerLayout));
            Assert.True(RefineDecodeQuality.ShouldScheduleUpgrade(64, 1600, null));
        }

        [Theory]
        [InlineData(0, 1600)]
        [InlineData(-1, 1600)]
        [InlineData(double.NaN, 1600)]
        [InlineData(double.PositiveInfinity, 1600)]
        [InlineData(11656, 0)]
        [InlineData(11656, -1)]
        [InlineData(11656, double.NaN)]
        [InlineData(11656, double.PositiveInfinity)]
        public void DoesNotScheduleWhenEitherEdgeIsUnknownOrDegenerate(
            double nativeLongEdge, double targetLongEdge)
        {
            Assert.False(RefineDecodeQuality.ShouldScheduleUpgrade(
                nativeLongEdge, targetLongEdge, RefineDecodeQuality.BayerLayout));
        }

        [Fact]
        public void TheUpgradeRequestsTheNonPreviewQualityTheBoundedBranchKeysOn()
        {
            // develop_sized_camera: demosaic_half = quality != Preview &&
            // 2 × max_long_edge ≤ sensor long edge. Preview (1) never takes it.
            Assert.NotEqual(RefineDecodeQuality.Preview, RefineDecodeQuality.UpgradeQuality);
            Assert.Equal(RefineDecodeQuality.Amaze, RefineDecodeQuality.UpgradeQuality);
        }

        // --- IsStillCurrent: an in-flight AMaZE upgrade must be dropped,
        // never applied, once a newer decode has started. ---

        [Fact]
        public void AcceptsAResultForTheGenerationThatIsStillOpen()
        {
            Assert.True(RefineDecodeQuality.IsStillCurrent(startedForGeneration: 3, currentGeneration: 3));
        }

        [Fact]
        public void DropsAStaleResultAfterTheAssetChanges()
        {
            // A photo switch or another decode-owned edit (profile, AE, lens
            // corrections) bumps the generation counter before the upgrade
            // decode that started under the old generation can land.
            Assert.False(RefineDecodeQuality.IsStillCurrent(startedForGeneration: 3, currentGeneration: 4));
        }
    }
}

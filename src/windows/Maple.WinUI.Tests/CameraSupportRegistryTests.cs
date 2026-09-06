using System;
using System.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class CameraSupportRegistryTests
    {
        [Fact]
        public void UncalibratedFileCannotInheritTheCameraNamesProfiledTier()
        {
            var body = CameraSupportRegistry.FixturedCameras.First(b => b.Tier == CameraTier.Profiled);
            Assert.Equal(CameraTier.DecodeOnly, CameraSupportRegistry.TierFor(body.Key, ProfileResolution.RawlerFallback));
            Assert.Equal(CameraTier.MatrixOnly, CameraSupportRegistry.TierFor(body.Key, ProfileResolution.EmbeddedCmOnly));
            Assert.Equal(CameraTier.Unsupported, CameraSupportRegistry.TierFor(body.Key, ProfileResolution.DecodeFailed));
        }

        [Fact]
        public void UnknownCameraUsesTheActualResolverAndIndependentLensAxis()
        {
            var support = CameraSupportMetadata.Parse("""{"cameraKey":"Unknown camera","resolution":"embedded_cm_only","lens":"no_correction_data"}""");
            Assert.Equal(CameraTier.MatrixOnly, support.Tier);
            Assert.Equal(LensSupport.NoCorrectionData, support.Lens);
            Assert.Equal(CameraSupportRegistry.Explanation(CameraTier.MatrixOnly), support.Explanation);
            Assert.Equal(CameraSupportRegistry.Explanation(LensSupport.NoCorrectionData), support.LensExplanation);
        }

        [Fact]
        public void NoPromotionWithoutEvidenceAndAllStatesHaveDistinctExplanations()
        {
            Assert.DoesNotContain(CameraSupportRegistry.FixturedCameras, body => body.Tier == CameraTier.Qualified);
            var tiers = Enum.GetValues<CameraTier>();
            Assert.Equal(tiers.Length, tiers.Select(CameraSupportRegistry.Explanation).Distinct().Count());
            Assert.True(CameraSupportRegistry.SchemaVersion > 0);
            Assert.True(CameraSupportRegistry.BundledModelCount > 1000);
        }

        [Fact]
        public void UnknownWireValuesAreRejectedRatherThanClaimingSupport()
        {
            Assert.Throws<ArgumentException>(() => CameraSupportMetadata.Parse("""{"cameraKey":"x","resolution":"future_tier","lens":"no_correction_data"}"""));
        }
    }
}

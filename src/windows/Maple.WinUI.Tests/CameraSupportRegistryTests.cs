using System;
using System.Linq;
using System.Runtime.InteropServices;
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
        public void ActualProfileIsNotDowngradedByAnUnsupportedHistoricalFixture()
        {
            foreach (var body in CameraSupportRegistry.FixturedCameras)
                Assert.True((int)CameraSupportRegistry.TierFor(body.Key, ProfileResolution.BundleConfident) >= (int)CameraTier.Profiled);
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

        [Theory]
        [InlineData("not JSON")]
        [InlineData("{}")]
        [InlineData("{\"cameraKey\":5}")]
        public void UnassessedBufferMetadataCannotAbortPixelDecode(string json)
        {
            Assert.Null(CameraSupportMetadata.ReadBuffer(IntPtr.Zero));
            var pointer = Marshal.StringToCoTaskMemUTF8(json);
            try { Assert.Null(CameraSupportMetadata.ReadBuffer(pointer)); }
            finally { Marshal.FreeCoTaskMem(pointer); }
        }

        [Fact]
        public void UnknownWireValuesAreRejectedRatherThanClaimingSupport()
        {
            Assert.Throws<ArgumentException>(() => CameraSupportMetadata.Parse("""{"cameraKey":"x","resolution":"future_tier","lens":"no_correction_data"}"""));
        }

        [Theory]
        [InlineData("not JSON")]
        [InlineData("{}")]
        [InlineData("{\"cameraKey\":12,\"resolution\":\"embedded_cm_only\",\"lens\":\"no_correction_data\"}")]
        [InlineData("{\"cameraKey\":\"x\",\"resolution\":\"future_tier\",\"lens\":\"no_correction_data\"}")]
        public void MalformedOrFutureMetadataDoesNotAbortDecode(string json)
        {
            Assert.Null(CameraSupportMetadata.ReadBestEffort(() => CameraSupportMetadata.Parse(json)));
        }

        [Fact]
        public void NativeAssessmentFailureOrMissingAbiDoesNotAbortDecode()
        {
            Assert.Null(CameraSupportMetadata.ReadBestEffort(() => throw new InvalidOperationException("Resolver failed")));
            Assert.Null(CameraSupportMetadata.ReadBestEffort(() => throw new EntryPointNotFoundException()));
            Assert.Null(CameraSupportMetadata.ReadBestEffort(() => throw new DllNotFoundException()));
        }

        [Fact]
        public void SuccessfulBestEffortReadRetainsTheActualAssessment()
        {
            var expected = CameraSupportMetadata.Parse("""{"cameraKey":"Unknown camera","resolution":"embedded_cm_only","lens":"no_correction_data"}""");
            Assert.Same(expected, CameraSupportMetadata.ReadBestEffort(() => expected));
        }
    }
}

// WhiteBalanceSamplerTests — the Windows neutral sampler's WinUI-free seam
// (#2434): the raw-ffi return-code → actionable-message contract, the domain
// gate a result must pass before it may land on the model (Apple
// `WhiteBalancePicker.swift`'s guard), and — when CI's `MAPLE_RAW_FFI_DLL`
// points at the raw_ffi.dll it just built — the real
// `maple_sample_white_balance_oriented` call against the committed 64×64
// grey RAW, the same fixture Apple's `WhiteBalanceSamplerIntegrationTests`
// exercises. Without the DLL the native cases skip-pass, the repo-wide
// convention for fixture/toolchain-gated tests.

using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Tests.Support;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests
{
    public class WhiteBalanceSamplerTests
    {
        private readonly ITestOutputHelper _output;

        public WhiteBalanceSamplerTests(ITestOutputHelper output)
        {
            _output = output;
        }

        [Theory]
        [InlineData(11, WhiteBalanceSampleFailure.OutsideImage)]
        [InlineData(12, WhiteBalanceSampleFailure.Clipped)]
        [InlineData(13, WhiteBalanceSampleFailure.TooDark)]
        [InlineData(14, WhiteBalanceSampleFailure.OutOfDomain)]
        [InlineData(3, WhiteBalanceSampleFailure.Failed)]
        [InlineData(1, WhiteBalanceSampleFailure.Failed)]
        public void ReturnCodesMapToTheSharedFailureVocabulary(int code, WhiteBalanceSampleFailure expected)
        {
            Assert.Equal(expected, WhiteBalanceSampler.FailureForCode(code));
        }

        [Fact]
        public void EveryFailureHasItsOwnActionableMessage()
        {
            var messages = Enum.GetValues<WhiteBalanceSampleFailure>()
                .Select(WhiteBalanceSampler.MessageFor)
                .ToList();
            Assert.All(messages, m => Assert.False(string.IsNullOrWhiteSpace(m)));
            Assert.Equal(messages.Count, messages.Distinct().Count());
            Assert.Contains("blown out", WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.Clipped));
            Assert.Contains("too dark", WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.TooDark));
            Assert.Contains("inside the image", WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.OutsideImage));
        }

        [Theory]
        [InlineData(5200, -14.5, 1u, true)]
        [InlineData(2000, -150, 1u, true)]
        [InlineData(12000, 150, 1u, true)]
        [InlineData(1999, 0, 1u, false)]
        [InlineData(12001, 0, 1u, false)]
        [InlineData(5000, -151, 1u, false)]
        [InlineData(5000, 151, 1u, false)]
        [InlineData(5000, 0, 0u, false)]
        [InlineData(double.NaN, 0, 1u, false)]
        [InlineData(5000, double.PositiveInfinity, 1u, false)]
        public void DomainGateMirrorsTheSliderRangesAndRequiresAVersion(
            double temperature, double tint, uint version, bool inDomain)
        {
            Assert.Equal(inDomain, WhiteBalanceSampler.IsInDomain(new WhiteBalanceSample(temperature, tint, version)));
        }

        [Theory]
        [InlineData("photo.dng", true)]
        [InlineData("PHOTO.CR3", true)]
        [InlineData("photo.arw", true)]
        [InlineData("photo.jpg", false)]
        [InlineData("photo.tif", false)]
        [InlineData("photo", false)]
        public void OnlyRawOriginalsCanBeSampled(string path, bool raw)
        {
            Assert.Equal(raw, WhiteBalanceSampler.IsRawPath(path));
        }

        [Fact]
        public void ANonRawAssetIsRejectedBeforeAnyNativeCall()
        {
            var ex = Assert.Throws<WhiteBalanceSampleException>(() =>
                WhiteBalanceSampler.Sample("C:\\photos\\scan.jpg", new AdjustmentState(), 0.5, 0.5));
            Assert.Equal(WhiteBalanceSampleFailure.UnsupportedAsset, ex.Failure);
            Assert.Equal(WhiteBalanceSampler.MessageFor(WhiteBalanceSampleFailure.UnsupportedAsset), ex.Message);
        }

        // --- Native, DLL-gated ---

        private static string? GreyFixture()
        {
            var root = RepoPaths.FindRepoRoot();
            if (root is null) return null;
            var path = Path.Combine(root, "src", "apple", "MapleUITests", "Fixtures", "synthetic", "grey-l018-rggb.dng");
            return File.Exists(path) ? path : null;
        }

        private bool NativeAvailable()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
            {
                _output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL not set; the native sampler was not exercised.");
                return false;
            }
            // RawFfiLayoutTests' static constructor installs the resolver
            // that maps `raw_ffi.dll` onto MAPLE_RAW_FFI_DLL (the same hook
            // ExportNativeTests relies on).
            RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
            return true;
        }

        [Fact]
        public void NativeSamplerSolvesTheGreyFixtureInsideTheDomainWithoutTouchingTheOriginal()
        {
            if (!NativeAvailable()) return;
            var fixture = GreyFixture();
            Assert.False(fixture is null, "the committed grey fixture is missing");

            var stagingDir = Path.Combine(Path.GetTempPath(), "maple-wb-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stagingDir);
            try
            {
                var raw = Path.Combine(stagingDir, "original.dng");
                File.Copy(fixture!, raw);
                var bytes = File.ReadAllBytes(raw);
                var mtime = File.GetLastWriteTimeUtc(raw);

                var sample = WhiteBalanceSampler.Sample(raw, new AdjustmentState(), 0.5, 0.5);

                Assert.True(WhiteBalanceSampler.IsInDomain(sample));
                Assert.True(sample.AlgorithmVersion > 0);
                // Deterministic for the same pixels and model.
                Assert.Equal(sample, WhiteBalanceSampler.Sample(raw, new AdjustmentState(), 0.5, 0.5));
                // Originals are never written; the probe sidecar never lands
                // beside the RAW.
                Assert.Equal(bytes, File.ReadAllBytes(raw));
                Assert.Equal(mtime, File.GetLastWriteTimeUtc(raw));
                Assert.Equal(new[] { "original.dng" },
                    Directory.GetFiles(stagingDir).Select(Path.GetFileName).ToArray());
            }
            finally
            {
                Directory.Delete(stagingDir, recursive: true);
            }
        }

        [Fact]
        public void NativeSamplerRejectsAPointOutsideTheImageWithTheOutsideMessage()
        {
            if (!NativeAvailable()) return;
            var fixture = GreyFixture();
            Assert.False(fixture is null, "the committed grey fixture is missing");

            var ex = Assert.Throws<WhiteBalanceSampleException>(() =>
                WhiteBalanceSampler.Sample(fixture!, new AdjustmentState(), 1.5, 0.5));
            Assert.Equal(WhiteBalanceSampleFailure.OutsideImage, ex.Failure);
        }
    }
}

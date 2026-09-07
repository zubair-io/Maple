// WhiteBalanceProvenanceTests — the edit-time clearing/stamping rules
// (#2434) behind the Temp/Tint sliders and AUTO on Windows.
//
// `AdjustmentSliderViewModel` and `EditSessionViewModel.ApplyAuto` live in
// WinUI-dependent files this project cannot link, so the seam under test is
// the static helper both of them call: the Temp/Tint slider setters ARE
// `SetManualTemperature` / `SetManualTint`, and AUTO calls `MarkAuto` right
// after writing the recommended pair.

using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class WhiteBalanceProvenanceTests
    {
        private static AdjustmentState SampledOnAnotherHost() => new()
        {
            Temperature = 5200,
            Tint = -14.5,
            WhiteBalancePreset = WhiteBalancePresets.Daylight,
            WbSource = WbSource.Sampled,
            WbSampleX = 0.25,
            WbSampleY = 0.75,
            WbAlgorithmVersion = 1,
        };

        private static void AssertManualWithNothingDerived(AdjustmentState state)
        {
            Assert.Equal(WhiteBalancePresets.Custom, state.WhiteBalancePreset);
            Assert.Equal(WbSource.Manual, state.WbSource);
            Assert.Equal(0, state.WbSampleX);
            Assert.Equal(0, state.WbSampleY);
            Assert.Equal(0, state.WbAlgorithmVersion);
        }

        [Fact]
        public void TemperatureSliderWriteClearsSampledProvenance()
        {
            var state = SampledOnAnotherHost();

            WhiteBalanceProvenance.SetManualTemperature(state, 5600);

            Assert.Equal(5600, state.Temperature);
            Assert.Equal(-14.5, state.Tint);
            AssertManualWithNothingDerived(state);
        }

        [Fact]
        public void TintSliderWriteClearsSampledProvenance()
        {
            var state = SampledOnAnotherHost();

            WhiteBalanceProvenance.SetManualTint(state, 20);

            Assert.Equal(5200, state.Temperature);
            Assert.Equal(20, state.Tint);
            AssertManualWithNothingDerived(state);
        }

        [Fact]
        public void AutoStampsTheGeneratedAlgorithmVersionAndNoSamplePoint()
        {
            var state = SampledOnAnotherHost();

            WhiteBalanceProvenance.MarkAuto(state);

            Assert.Equal(WhiteBalancePresets.Auto, state.WhiteBalancePreset);
            Assert.Equal(WbSource.Auto, state.WbSource);
            Assert.Equal(0, state.WbSampleX);
            Assert.Equal(0, state.WbSampleY);
            Assert.Equal(WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion, state.WbAlgorithmVersion);
            Assert.NotEqual(0, state.WbAlgorithmVersion);
        }

        [Fact]
        public void ManualEditAfterAutoLeavesNothingDerived()
        {
            var state = new AdjustmentState();
            WhiteBalanceProvenance.MarkAuto(state);

            WhiteBalanceProvenance.SetManualTint(state, -5);

            AssertManualWithNothingDerived(state);
        }

        [Fact]
        public void ProvenanceIsNotARenderInputAndNeverReachesTheChain()
        {
            // The provenance fields are metadata: the model-side clone the
            // render loop consumes carries them untouched, and nothing in the
            // per-tick parameter build reads them (they have no raw-ffi twin).
            var state = SampledOnAnotherHost();

            var clone = state.Clone();

            Assert.Equal(state.WbSource, clone.WbSource);
            Assert.Equal(state.WhiteBalancePreset, clone.WhiteBalancePreset);
            Assert.Equal((state.WbSampleX, state.WbSampleY), (clone.WbSampleX, clone.WbSampleY));
            Assert.Equal(state.WbAlgorithmVersion, clone.WbAlgorithmVersion);
        }
    }
}

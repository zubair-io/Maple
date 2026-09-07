// WhiteBalancePickerModelTests — the model half of the Windows eyedropper,
// preset picker and provenance readout (#2434): what a committed sample, a
// named illuminant, As Shot and the Custom choice write onto
// AdjustmentState, the readout text each source produces, and that every
// one of those states survives the sidecar round trip unchanged.
//
// The Apple twin is `WhiteBalancePicker.swift` / `EditorState+WhiteBalancePreset.swift`,
// the web twin `editor-state.wb-preset.ts` / `editor-state.wb-sample.ts`;
// the semantics here are theirs.

using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class WhiteBalancePickerModelTests
    {
        private static AdjustmentState Manual() => new()
        {
            Temperature = 4800,
            Tint = 12,
            WhiteBalancePreset = WhiteBalancePresets.Custom,
            WbSource = WbSource.Manual,
        };

        private static void AssertNothingDerived(AdjustmentState state)
        {
            Assert.Equal(0, state.WbSampleX);
            Assert.Equal(0, state.WbSampleY);
            Assert.Equal(0, state.WbAlgorithmVersion);
        }

        private static AdjustmentState RoundTrip(AdjustmentState state)
        {
            var xml = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = state.Clone() });
            var parsed = XmpParser.Parse(xml);
            Assert.NotNull(parsed);
            return parsed!.Adjustments;
        }

        // --- Sampled ---

        [Fact]
        public void SampleWritesThePairThePointAndTheVersionAsSampledCustom()
        {
            var state = new AdjustmentState { WhiteBalancePreset = WhiteBalancePresets.Daylight, WbSource = WbSource.Preset };

            WhiteBalanceProvenance.MarkSampled(state, 5200, -14.5, 0.25, 0.75, 1);

            Assert.Equal(5200, state.Temperature);
            Assert.Equal(-14.5, state.Tint);
            Assert.Equal(WhiteBalancePresets.Custom, state.WhiteBalancePreset);
            Assert.Equal(WbSource.Sampled, state.WbSource);
            Assert.Equal(0.25, state.WbSampleX);
            Assert.Equal(0.75, state.WbSampleY);
            Assert.Equal(1, state.WbAlgorithmVersion);
        }

        [Fact]
        public void ManualSliderWriteAfterASampleClearsThePointAndVersion()
        {
            var state = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(state, 5200, -14.5, 0.25, 0.75, 1);

            WhiteBalanceProvenance.SetManualTemperature(state, 5600);

            Assert.Equal(WbSource.Manual, state.WbSource);
            Assert.Equal(WhiteBalancePresets.Custom, state.WhiteBalancePreset);
            AssertNothingDerived(state);
        }

        [Fact]
        public void SampledStateRoundTripsThroughTheSidecar()
        {
            var state = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(state, 5200, -14.5, 0.25, 0.75, 1);

            AdjustmentStateAssert.Equal(state, RoundTrip(state));
        }

        // --- Named illuminants ---

        [Theory]
        [InlineData(WhiteBalancePresets.Daylight)]
        [InlineData(WhiteBalancePresets.Cloudy)]
        [InlineData(WhiteBalancePresets.Shade)]
        [InlineData(WhiteBalancePresets.Tungsten)]
        [InlineData(WhiteBalancePresets.Fluorescent)]
        [InlineData(WhiteBalancePresets.Flash)]
        public void NamedIlluminantWritesTheGeneratedPairAsPresetProvenance(string name)
        {
            var state = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(state, 5200, -14.5, 0.25, 0.75, 1);

            Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(state, name));

            var pair = WhiteBalancePresets.Pair(name);
            Assert.NotNull(pair);
            Assert.Equal(pair!.Value.Temperature, state.Temperature);
            Assert.Equal(pair.Value.Tint, state.Tint);
            Assert.Equal(name, state.WhiteBalancePreset);
            Assert.Equal(WbSource.Preset, state.WbSource);
            AssertNothingDerived(state);
            AdjustmentStateAssert.Equal(state, RoundTrip(state));
        }

        [Fact]
        public void CustomKeepsTheCurrentPairAndReadsAsManual()
        {
            var state = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(state, 5200, -14.5, 0.25, 0.75, 1);

            Assert.True(WhiteBalanceProvenance.ApplyNamedPreset(state, WhiteBalancePresets.Custom));

            Assert.Equal(5200, state.Temperature);
            Assert.Equal(-14.5, state.Tint);
            Assert.Equal(WhiteBalancePresets.Custom, state.WhiteBalancePreset);
            Assert.Equal(WbSource.Manual, state.WbSource);
            AssertNothingDerived(state);
            AdjustmentStateAssert.Equal(state, RoundTrip(state));
        }

        [Theory]
        [InlineData(WhiteBalancePresets.AsShot)]
        [InlineData(WhiteBalancePresets.Auto)]
        [InlineData("Candlelight")]
        public void NamesWithoutAGeneratedPairAreNotAppliedHere(string name)
        {
            var state = Manual();

            Assert.False(WhiteBalanceProvenance.ApplyNamedPreset(state, name));

            Assert.Equal(4800, state.Temperature);
            Assert.Equal(WbSource.Manual, state.WbSource);
        }

        // --- As Shot ---

        [Fact]
        public void AsShotWritesTheCameraPairAndClearsEverythingDerived()
        {
            var state = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(state, 5200, -14.5, 0.25, 0.75, 1);

            WhiteBalanceProvenance.ApplyAsShot(state, 5430, 3.5);

            Assert.Equal(5430, state.Temperature);
            Assert.Equal(3.5, state.Tint);
            Assert.Equal(WhiteBalancePresets.AsShot, state.WhiteBalancePreset);
            Assert.Equal(WbSource.AsShot, state.WbSource);
            AssertNothingDerived(state);
            AdjustmentStateAssert.Equal(state, RoundTrip(state));
        }

        // --- Picker selection ---

        [Fact]
        public void LegacyAsShotWithoutANameSelectsAsShotInThePicker()
        {
            // Older sidecars carry As Shot provenance with the name omitted
            // (Custom); the picker must show As Shot, not Custom (Swift
            // `selectedPreset`).
            var state = new AdjustmentState { WhiteBalancePreset = WhiteBalancePresets.Custom, WbSource = WbSource.AsShot };
            Assert.Equal(WhiteBalancePresets.AsShot, WhiteBalanceProvenance.SelectedPresetName(state));

            Assert.Equal(WhiteBalancePresets.Custom, WhiteBalanceProvenance.SelectedPresetName(Manual()));
            var sampled = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(sampled, 5200, -14.5, 0.25, 0.75, 1);
            Assert.Equal(WhiteBalancePresets.Custom, WhiteBalanceProvenance.SelectedPresetName(sampled));
            var daylight = new AdjustmentState();
            WhiteBalanceProvenance.ApplyNamedPreset(daylight, WhiteBalancePresets.Daylight);
            Assert.Equal(WhiteBalancePresets.Daylight, WhiteBalanceProvenance.SelectedPresetName(daylight));
        }

        // --- Readout ---

        [Fact]
        public void ReadoutNamesEverySource()
        {
            Assert.Equal("White balance: As Shot", WhiteBalanceProvenance.ProvenanceText(new AdjustmentState()));
            Assert.Equal("White balance: Manual", WhiteBalanceProvenance.ProvenanceText(Manual()));

            var daylight = new AdjustmentState();
            WhiteBalanceProvenance.ApplyNamedPreset(daylight, WhiteBalancePresets.Daylight);
            Assert.Equal("White balance: Daylight", WhiteBalanceProvenance.ProvenanceText(daylight));

            var unnamedPreset = new AdjustmentState { WbSource = WbSource.Preset };
            Assert.Equal("White balance: Preset", WhiteBalanceProvenance.ProvenanceText(unnamedPreset));

            var auto = new AdjustmentState();
            WhiteBalanceProvenance.MarkAuto(auto);
            Assert.Equal("White balance: Auto · version 1", WhiteBalanceProvenance.ProvenanceText(auto));
            Assert.Equal("White balance: Auto",
                WhiteBalanceProvenance.ProvenanceText(new AdjustmentState { WbSource = WbSource.Auto }));

            var sampled = new AdjustmentState();
            WhiteBalanceProvenance.MarkSampled(sampled, 5200, -14.5, 0.25, 0.75, 1);
            Assert.Equal("White balance: Sampled · (0.250, 0.750) · version 1",
                WhiteBalanceProvenance.ProvenanceText(sampled));

            // A pasted look copies the source but not the point or version.
            Assert.Equal("White balance: Copied sample",
                WhiteBalanceProvenance.ProvenanceText(new AdjustmentState { WbSource = WbSource.Sampled }));
        }

        [Fact]
        public void ReadoutFormatsThePointWithInvariantDecimals()
        {
            var previous = System.Globalization.CultureInfo.CurrentCulture;
            System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("de-DE");
            try
            {
                var sampled = new AdjustmentState();
                WhiteBalanceProvenance.MarkSampled(sampled, 5200, -14.5, 0.25, 0.75, 1);
                Assert.Equal("White balance: Sampled · (0.250, 0.750) · version 1",
                    WhiteBalanceProvenance.ProvenanceText(sampled));
            }
            finally
            {
                System.Globalization.CultureInfo.CurrentCulture = previous;
            }
        }
    }
}

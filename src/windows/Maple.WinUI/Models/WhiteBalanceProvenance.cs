// WhiteBalanceProvenance — the edit-time rules for the white-balance name +
// provenance fields on AdjustmentState (#2434).
//
// The sidecar reader hydrates `WhiteBalancePreset` / `WbSource` /
// `WbSampleX` / `WbSampleY` / `WbAlgorithmVersion` from a sidecar any host
// may have written. Once the user changes the pair, that provenance is no
// longer true, and re-saving it verbatim would let the sidecar claim a
// sample point or a preset the pixels no longer reflect. These helpers are
// the only writers of those fields outside the parser, and each mirrors
// what the other editors do for the same action:
//
//  - a Temp/Tint slider write → Manual / Custom, point and version cleared
//    (Swift `ToolValueMapping` for the WB tools, TS `manualWbPatch`);
//  - AUTO → Auto / Auto, point cleared, version stamped from the same
//    raw-core constant the other hosts stamp (Swift
//    `EditorState+AutoReset`, TS `editor-state.auto`), generated into
//    `WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion`;
//  - the eyedropper → Sampled / Custom, the normalised point and the
//    sampler's own version (Swift `WhiteBalancePicker.pick`, TS
//    `sampledWbPatch`);
//  - a named illuminant → its generated pair, the name, Preset; Custom →
//    the current pair kept, Manual; As Shot → the camera pair, AsShot
//    (Swift `EditorState+WhiteBalancePreset` / `resetToAsShot`, TS
//    `applyWhiteBalancePresetInto`).
//
// `ProvenanceText` is the readout the panel shows (Swift
// `WhiteBalancePicker.provenance`, the web `wb-provenance` caption).

using System.Globalization;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Models
{
    public static class WhiteBalanceProvenance
    {
        /// <summary>A manual temperature write: the pair is now the user's
        /// own, so any sampled/preset/auto provenance is cleared with it.</summary>
        public static void SetManualTemperature(AdjustmentState state, double temperature)
        {
            state.Temperature = temperature;
            MarkManual(state);
        }

        /// <summary>A manual tint write — see <see cref="SetManualTemperature"/>.</summary>
        public static void SetManualTint(AdjustmentState state, double tint)
        {
            state.Tint = tint;
            MarkManual(state);
        }

        /// <summary>Manual provenance: no name, no point, nothing derived.</summary>
        public static void MarkManual(AdjustmentState state)
        {
            state.WhiteBalancePreset = WhiteBalancePresets.Custom;
            state.WbSource = WbSource.Manual;
            ClearDerived(state);
        }

        /// <summary>AUTO provenance: the pair came from raw-core's estimator
        /// at the generated algorithm version; no sample point.</summary>
        public static void MarkAuto(AdjustmentState state)
        {
            state.WhiteBalancePreset = WhiteBalancePresets.Auto;
            state.WbSource = WbSource.Auto;
            ClearDerived(state);
            state.WbAlgorithmVersion = WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion;
        }

        /// <summary>A committed eyedropper sample: the solved pair, the
        /// normalised point it was picked at (uncropped, display-oriented)
        /// and the sampler's derivation version — what makes the value
        /// reproducible. The name is Custom: no illuminant was chosen.</summary>
        public static void MarkSampled(
            AdjustmentState state, double temperature, double tint, double x, double y, double algorithmVersion)
        {
            state.Temperature = temperature;
            state.Tint = tint;
            state.WhiteBalancePreset = WhiteBalancePresets.Custom;
            state.WbSource = WbSource.Sampled;
            state.WbSampleX = x;
            state.WbSampleY = y;
            state.WbAlgorithmVersion = algorithmVersion;
        }

        /// <summary>As Shot: the camera's own pair (the decode-exported
        /// identity the session holds), named and sourced As Shot.</summary>
        public static void ApplyAsShot(AdjustmentState state, double temperature, double tint)
        {
            state.Temperature = temperature;
            state.Tint = tint;
            state.WhiteBalancePreset = WhiteBalancePresets.AsShot;
            state.WbSource = WbSource.AsShot;
            ClearDerived(state);
        }

        /// <summary>
        /// A picker choice this helper can resolve on its own: one of the six
        /// generated illuminants (its pair, its name, Preset) or Custom (the
        /// current pair kept, Manual). Returns false — and leaves the state
        /// untouched — for As Shot and Auto, which need the session (the
        /// camera pair, the estimator), and for a name this build does not
        /// know.
        /// </summary>
        public static bool ApplyNamedPreset(AdjustmentState state, string name)
        {
            if (name == WhiteBalancePresets.Custom)
            {
                MarkManual(state);
                return true;
            }
            if (WhiteBalancePresets.Pair(name) is not { } pair)
                return false;
            state.Temperature = pair.Temperature;
            state.Tint = pair.Tint;
            state.WhiteBalancePreset = name;
            state.WbSource = WbSource.Preset;
            ClearDerived(state);
            return true;
        }

        /// <summary>The picker's displayed choice. Older sidecars carry As
        /// Shot provenance with the name omitted (Custom); they show As Shot,
        /// not Custom (Swift `selectedPreset`).</summary>
        public static string SelectedPresetName(AdjustmentState state) =>
            state.WhiteBalancePreset == WhiteBalancePresets.Custom && state.WbSource == WbSource.AsShot
                ? WhiteBalancePresets.AsShot
                : state.WhiteBalancePreset;

        /// <summary>The provenance readout — the same lines Apple's picker
        /// shows, so the two native shells read alike.</summary>
        public static string ProvenanceText(AdjustmentState state)
        {
            var version = state.WbAlgorithmVersion;
            return state.WbSource switch
            {
                WbSource.AsShot => "White balance: As Shot",
                WbSource.Manual => "White balance: Manual",
                WbSource.Preset => "White balance: " + (state.WhiteBalancePreset == WhiteBalancePresets.Custom
                    ? "Preset"
                    : state.WhiteBalancePreset),
                WbSource.Auto => version > 0
                    ? string.Format(CultureInfo.InvariantCulture, "White balance: Auto · version {0:0}", version)
                    : "White balance: Auto",
                WbSource.Sampled => version > 0
                    ? string.Format(CultureInfo.InvariantCulture,
                        "White balance: Sampled · ({0:0.000}, {1:0.000}) · version {2:0}",
                        state.WbSampleX, state.WbSampleY, version)
                    : "White balance: Copied sample",
                _ => "White balance",
            };
        }

        private static void ClearDerived(AdjustmentState state)
        {
            state.WbSampleX = 0;
            state.WbSampleY = 0;
            state.WbAlgorithmVersion = 0;
        }
    }
}

// WhiteBalanceProvenance — the edit-time rules for the white-balance name +
// provenance fields on AdjustmentState (#2434).
//
// The sidecar reader hydrates `WhiteBalancePreset` / `WbSource` /
// `WbSampleX` / `WbSampleY` / `WbAlgorithmVersion` from a sidecar another
// host may have written (a neutral sampled on Web or Apple, a named
// illuminant picked on Apple). Once the user changes the pair here, that
// provenance is no longer true, and re-saving it verbatim would let the
// sidecar claim a sample point or a preset the pixels no longer reflect.
// These two helpers are the only writers of those fields outside the
// parser, and they mirror what the other editors do for the same action:
//
//  - a Temp/Tint slider write → Manual / Custom, point and version cleared
//    (Swift `ToolValueMapping` for the WB tools, TS `editor-state.wb-preset`
//    for the Custom choice);
//  - AUTO → Auto / Auto, point cleared, version stamped from the same
//    raw-core constant the other hosts stamp (Swift
//    `EditorState+AutoReset`, TS `editor-state.auto`), generated into
//    `WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion`.

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
            state.WbSampleX = 0;
            state.WbSampleY = 0;
            state.WbAlgorithmVersion = 0;
        }

        /// <summary>AUTO provenance: the pair came from raw-core's estimator
        /// at the generated algorithm version; no sample point.</summary>
        public static void MarkAuto(AdjustmentState state)
        {
            state.WhiteBalancePreset = WhiteBalancePresets.Auto;
            state.WbSource = WbSource.Auto;
            state.WbSampleX = 0;
            state.WbSampleY = 0;
            state.WbAlgorithmVersion = WhiteBalancePresets.AutoWhiteBalanceAlgorithmVersion;
        }
    }
}

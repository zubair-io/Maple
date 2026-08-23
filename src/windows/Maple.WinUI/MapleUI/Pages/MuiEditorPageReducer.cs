using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageEditor</c>'s cross-organism wiring (#3012) — both the
    /// Adjustments Panel (full tool tree) and the Control Surface (the
    /// currently-armed Tool Dock tool) feed slider drags into one shared
    /// "slider id -> value" map, and both read their Value Chip summaries
    /// back out of it, so nudging Exposure from either surface shows up
    /// on the other. A slider left at its resting value (0) never earns a
    /// chip — only touched sliders clutter the summary row, same as the
    /// real editor's own value-chip behavior.</summary>
    public static class MuiEditorPageReducer
    {
        /// <summary>One slider's identity for chip formatting — deliberately
        /// its own tiny WinUI-free record rather than reusing
        /// <c>MuiAdjustmentSlider</c> (declared in a WinUI-dependent file,
        /// so unusable from a file this project links into
        /// Maple.WinUI.Tests).</summary>
        public readonly record struct SliderDef(string Id, string Label, string Unit);

        public static IReadOnlyDictionary<string, double> WithValue(
            IReadOnlyDictionary<string, double> state, string sliderId, double value)
        {
            var next = new Dictionary<string, double>(state) { [sliderId] = value };
            return next;
        }

        /// <summary>Formats every touched (non-zero) slider in
        /// <paramref name="defs"/> order as a (label, signed value+unit)
        /// pair — e.g. Exposure at +0.7 becomes ("Exposure", "+0.7 EV").</summary>
        public static IReadOnlyList<(string Label, string Value)> ValueChips(
            IReadOnlyDictionary<string, double> state, IReadOnlyList<SliderDef> defs)
        {
            var chips = new List<(string, string)>();
            foreach (var def in defs)
            {
                if (!state.TryGetValue(def.Id, out var value) || Math.Abs(value) < 0.0001) continue;
                var sign = value > 0 ? "+" : "";
                chips.Add((def.Label, $"{sign}{value:0.##}{def.Unit}"));
            }
            return chips;
        }
    }
}

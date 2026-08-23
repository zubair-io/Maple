using System;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free value&lt;-&gt;position math behind the Maple.UI
    /// Slider and Living Slider molecules (unified-component-catalog.md
    /// §2.1). Split out the same way Atoms/MuiTimestampFormatter.cs and
    /// friends are, so it links into Maple.WinUI.Tests (net8.0, no WinUI)
    /// and is the one part of these molecules CI can actually verify.
    ///
    /// Ports the web molecules' shared `internal/pointer-drag.ts` helpers
    /// (`percentInRange`, `formatSignedValue`, `arrowKeyDelta`) plus the
    /// pointer-delta-to-value math `mui-living-slider.component.ts`'s
    /// `onPointerMove` inlines, so both platforms compute the same track
    /// position and readout text for the same inputs.
    /// </summary>
    public static class MuiSliderMath
    {
        /// <summary>Clamps <paramref name="value"/> into [<paramref name="min"/>,
        /// <paramref name="max"/>]. A no-op (returns value unchanged) when
        /// min &gt; max — callers own passing a sane range.</summary>
        public static double Clamp(double value, double min, double max)
        {
            if (min > max) return value;
            return Math.Min(max, Math.Max(min, value));
        }

        /// <summary>Rounds <paramref name="raw"/> to the nearest multiple of
        /// <paramref name="step"/>. Returns <paramref name="raw"/> unchanged
        /// when step is non-positive (nothing to snap to).</summary>
        public static double SnapToStep(double raw, double step)
        {
            if (step <= 0) return raw;
            return Math.Round(raw / step) * step;
        }

        /// <summary>Maps a value's position within [min, max] to a [0, 100]
        /// percentage — the shared trackPct/thumbPct/markerPct calc. Ports
        /// `percentInRange`. <paramref name="fallbackPct"/> covers the
        /// degenerate min == max case (a centered thumb vs. an empty track,
        /// depending on the caller).</summary>
        public static double PercentInRange(double value, double min, double max, double fallbackPct)
        {
            if (max.Equals(min)) return fallbackPct;
            return (value - min) / (max - min) * 100.0;
        }

        /// <summary>Computes a Living Slider's new value from a pointer drag:
        /// the pointer moved <paramref name="dx"/> px since the drag started
        /// at <paramref name="pointerDownValue"/>, across a track
        /// <paramref name="trackWidth"/> px wide spanning [min, max]. Ports
        /// `MuiLivingSliderComponent.onPointerMove`. Snaps to
        /// <paramref name="step"/> and clamps to range. A zero/negative
        /// track width leaves the value unchanged (no measured track yet).</summary>
        public static double ValueFromPointerDelta(
            double pointerDownValue, double dx, double trackWidth, double min, double max, double step)
        {
            if (trackWidth <= 0) return Clamp(pointerDownValue, min, max);
            var range = max - min;
            var delta = dx / trackWidth * range;
            var raw = pointerDownValue + delta;
            return Clamp(SnapToStep(raw, step), min, max);
        }

        /// <summary>Converts an arrow-key name into a signed step delta
        /// along the control's axis ("Left"/"Down" decrease, "Right"/"Up"
        /// increase); null for any other key. Takes a plain key-name string
        /// rather than <c>Windows.System.VirtualKey</c> so this stays
        /// WinUI-free — the control maps its VirtualKey to one of these
        /// names before calling in. Ports `arrowKeyDelta`.</summary>
        public static double? ArrowKeyDelta(string key, double step) => key switch
        {
            "Left" or "Down" => -step,
            "Right" or "Up" => step,
            _ => null,
        };

        /// <summary>Formats a scrub control's numeric value with an
        /// explicit '+' sign for positive values and an optional unit
        /// suffix. Decimal precision scales with the control's step size
        /// (sub-0.1 steps show 2 decimals, sub-1 steps show 1, whole steps
        /// show none). Ports `formatSignedValue`.</summary>
        public static string FormatSignedValue(double value, double step, string unit)
        {
            var decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
            var formatted = value.ToString("F" + decimals);
            var signed = value > 0 ? "+" + formatted : formatted;
            return string.IsNullOrEmpty(unit) ? signed : $"{signed} {unit}";
        }
    }
}

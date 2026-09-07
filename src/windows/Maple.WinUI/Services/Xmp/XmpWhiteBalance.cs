// XmpWhiteBalance — the white-balance name + provenance block of the sidecar
// contract (docs/xmp-canonical-format.md § "White balance", #2434) for the
// Windows shell: `crs:WhiteBalance`, `papp:WbSource`, `papp:WbSampleX`,
// `papp:WbSampleY`, `papp:WbAlgorithmVersion`.
//
// Before this class the five attributes were not in XmpParser's consumed
// set, so they rode through as passthrough and XmpWriter re-emitted them
// verbatim — a sidecar sampled on Web or Apple kept `WbSource="Sampled"`
// and its stale sample point after any Windows edit of the pair. The
// value decoding, the post-walk resolution rules the other three readers
// apply, and the writer's gated emit all live here so the block cannot
// drift back into passthrough one attribute at a time.

using System;
using System.Collections.Generic;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services.Xmp
{
    internal static class XmpWhiteBalance
    {
        public const string PresetKey = "crs:WhiteBalance";
        public const string SourceKey = "papp:WbSource";
        public const string SampleXKey = "papp:WbSampleX";
        public const string SampleYKey = "papp:WbSampleY";
        public const string AlgorithmVersionKey = "papp:WbAlgorithmVersion";

        /// <summary>Every attribute this block consumes (never passthrough).</summary>
        public static readonly string[] Keys =
        {
            PresetKey, SourceKey, SampleXKey, SampleYKey, AlgorithmVersionKey,
        };

        /// <summary>A name this build doesn't know reads as Custom — the
        /// same fallback as Swift's `WhiteBalancePreset(rawValue:) ?? .custom`.</summary>
        public static string ParsePreset(string value) =>
            Array.IndexOf(WhiteBalancePresets.Names, value) >= 0 ? value : WhiteBalancePresets.Custom;

        /// <summary>Case-insensitive like the other `papp:` enums. An unknown
        /// label is a caption this build can't read, not a reason to drop the
        /// sidecar: null keeps the default and the adjustments alongside
        /// survive (raw-core / Swift / TS parity, #3309).</summary>
        public static WbSource? ParseSource(string value) => value.ToLowerInvariant() switch
        {
            "asshot" => WbSource.AsShot,
            "auto" => WbSource.Auto,
            "preset" => WbSource.Preset,
            "sampled" => WbSource.Sampled,
            "manual" => WbSource.Manual,
            _ => null,
        };

        /// <summary>
        /// Post-walk resolution, once every attribute has been applied (the
        /// rules depend on what else the element carried, and attribute
        /// order is not guaranteed):
        /// <list type="bullet">
        /// <item>A named illuminant resolves to its pair for whichever
        /// component was not explicitly authored — an explicit
        /// `crs:Temperature`/`crs:Tint` always wins — and, absent an
        /// explicit `papp:WbSource`, labels the pair Preset
        /// (`applyNamedWhiteBalance` in `xmp-adjustment-walk.ts`).</item>
        /// <item>A foreign (non-Maple-authored) sidecar with an authored pair
        /// and a Custom or absent name reads as Manual provenance. A
        /// Maple-authored document keeps its legacy AsShot omission
        /// semantics untouched (Swift `parserDidEndDocument`). The label
        /// changes; the stored pair and its scale never do.</item>
        /// </list>
        /// </summary>
        public static void Resolve(
            AdjustmentState state, bool sourceSeen, bool temperatureSeen, bool tintSeen, bool mapleAuthored)
        {
            if (WhiteBalancePresets.Pair(state.WhiteBalancePreset) is { } pair)
            {
                if (!temperatureSeen) state.Temperature = pair.Temperature;
                if (!tintSeen) state.Tint = pair.Tint;
                if (!sourceSeen) state.WbSource = WbSource.Preset;
            }

            var foreignAuthoredPair = !mapleAuthored && (temperatureSeen || tintSeen);
            if (foreignAuthoredPair
                && state.WhiteBalancePreset == WhiteBalancePresets.Custom
                && state.WbSource == WbSource.AsShot)
            {
                state.WbSource = WbSource.Manual;
            }
        }

        /// <summary>
        /// Writer half, the same gating as raw-core's `xmp::serialize`,
        /// Swift's `XMPSerialization+Attrs` and TS's `XmpSerializerService`:
        /// the name only off Custom, the source only off AsShot, and — a
        /// non-zero version being the "this pair was derived" flag — the
        /// sample point only with a derived Sampled source and the version
        /// only with the two sources that can derive one (Auto, Sampled). A
        /// `Sampled` label with no version is what a pasted look carries
        /// (`wbSource` copies, the point and version do not); writing `0,0`
        /// there would claim a sample that never happened (#3309).
        /// </summary>
        public static void AppendAttributes(List<string> parts, AdjustmentState state)
        {
            if (state.WhiteBalancePreset != WhiteBalancePresets.Custom)
            {
                parts.Add($"{PresetKey}=\"{XmpSchema.EscapeAttr(state.WhiteBalancePreset)}\"");
            }
            if (state.WbSource != WbSource.AsShot)
            {
                parts.Add($"{SourceKey}=\"{state.WbSource}\"");
            }
            var derived = state.WbAlgorithmVersion != 0;
            if (state.WbSource == WbSource.Sampled && derived)
            {
                parts.Add($"{SampleXKey}=\"{XmpSchema.FormatNumber(state.WbSampleX)}\"");
                parts.Add($"{SampleYKey}=\"{XmpSchema.FormatNumber(state.WbSampleY)}\"");
            }
            if (derived && state.WbSource is WbSource.Auto or WbSource.Sampled)
            {
                parts.Add($"{AlgorithmVersionKey}=\"{XmpSchema.FormatNumber(state.WbAlgorithmVersion)}\"");
            }
        }
    }
}

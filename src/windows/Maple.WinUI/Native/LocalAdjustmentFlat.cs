// LocalAdjustmentFlat — C# mirror of raw-core's flat `f32` wire for a
// local-adjustment layer stack (`raw_core::types::local_adjustment::flat`,
// #1698). One layout serves the FFI `(ptr, len)` pair on both
// MapleAdjustmentParams (CPU chain) and MapleGpuLiveParams (GPU live chain) —
// `local_adjustments_ptr`/`local_adjustments_len`, already present on both
// C# struct mirrors (#3406) but never populated before this file, which is
// why a sidecar authored on web/Apple rendered correctly on Windows (the
// Rust stage runs) while a layer added ON Windows never reached the
// renderer.
//
// This is encode-only: Windows never reads the flat wire back (the sidecar
// round-trip owns reads — Services/Xmp/XmpLocalAdjustments.cs), it only
// serializes the in-memory model for the per-tick FFI call, same as Swift's
// `LocalAdjustmentFlat.swift` and TS's flat encoder.

using System;
using System.Collections.Generic;
using Maple.WinUI.Models;

namespace Maple.WinUI.Native
{
    internal static class LocalAdjustmentFlat
    {
        /// <summary>Floats per serialized layer — eight WGSL vec4&lt;f32&gt;
        /// members, matching raw-core's `LAYER_FLAT_LEN`.</summary>
        public const int LayerFlatLen = 32;

        private const float KindLinear = 0f;
        private const float KindRadial = 1f;

        private const uint PresentExposure = 1u << 0;
        private const uint PresentContrast = 1u << 1;
        private const uint PresentHighlights = 1u << 2;
        private const uint PresentShadows = 1u << 3;
        private const uint PresentWhites = 1u << 4;
        private const uint PresentBlacks = 1u << 5;
        private const uint PresentSaturation = 1u << 6;
        private const uint PresentVibrance = 1u << 7;
        private const uint PresentTemperature = 1u << 8;
        private const uint PresentTint = 1u << 9;
        private const uint PresentHue = 1u << 10;

        /// <summary>Serialize a layer stack to the flat wire — length is
        /// always <c>layers.Count * LayerFlatLen</c>; an empty stack yields
        /// an empty array (both FFI structs read that as "no local
        /// adjustments," the bit-identical short-circuit raw-core's own
        /// `apply` takes on an empty slice).</summary>
        public static float[] ToFlat(IReadOnlyList<LocalAdjustment> layers)
        {
            var flat = new float[layers.Count * LayerFlatLen];
            for (var i = 0; i < layers.Count; i++)
                WriteLayer(layers[i], flat.AsSpan(i * LayerFlatLen, LayerFlatLen));
            return flat;
        }

        private static void WriteLayer(LocalAdjustment layer, Span<float> slot)
        {
            WriteMask(layer.Mask, slot);
            WriteAdjustments(layer.Adjustments, slot);
            WriteRange(layer.Range, slot);
        }

        private static void WriteMask(LocalMask mask, Span<float> slot)
        {
            switch (mask)
            {
                case LinearMask l:
                    slot[0] = (float)l.Start.X;
                    slot[1] = (float)l.Start.Y;
                    slot[2] = (float)l.End.X;
                    slot[3] = (float)l.End.Y;
                    slot[4] = (float)l.Feather;
                    slot[6] = KindLinear;
                    break;
                case RadialMask r:
                    slot[0] = (float)r.Center.X;
                    slot[1] = (float)r.Center.Y;
                    slot[2] = (float)r.Radii.X;
                    slot[3] = (float)r.Radii.Y;
                    slot[4] = (float)r.Feather;
                    slot[5] = (float)r.Angle;
                    slot[6] = KindRadial;
                    slot[7] = r.Invert ? 1f : 0f;
                    break;
                default:
                    throw new InvalidOperationException($"unknown mask shape {mask.GetType().Name}");
            }
        }

        // A local function closing over `slot` (a ref struct) is not legal
        // C# (CS9108), so this is unrolled rather than looped over a
        // (field, bit) descriptor table the way the Rust encoder does.
        private static void WriteAdjustments(PartialAdjustments a, Span<float> slot)
        {
            var present = 0u;
            if (a.Exposure is { } exposure) { slot[12] = (float)exposure; present |= PresentExposure; }
            if (a.Contrast is { } contrast) { slot[13] = (float)contrast; present |= PresentContrast; }
            if (a.Highlights is { } highlights) { slot[14] = (float)highlights; present |= PresentHighlights; }
            if (a.Shadows is { } shadows) { slot[15] = (float)shadows; present |= PresentShadows; }
            if (a.Whites is { } whites) { slot[16] = (float)whites; present |= PresentWhites; }
            if (a.Blacks is { } blacks) { slot[17] = (float)blacks; present |= PresentBlacks; }
            if (a.Saturation is { } saturation) { slot[18] = (float)saturation; present |= PresentSaturation; }
            if (a.Vibrance is { } vibrance) { slot[19] = (float)vibrance; present |= PresentVibrance; }
            if (a.Temperature is { } temperature) { slot[20] = (float)temperature; present |= PresentTemperature; }
            if (a.Tint is { } tint) { slot[21] = (float)tint; present |= PresentTint; }
            if (a.Hue is { } hue) { slot[22] = (float)hue; present |= PresentHue; }
            slot[8] = present;
        }

        private static void WriteRange(ColorRangeRefinement? range, Span<float> slot)
        {
            if (range is not { } r)
                return; // slot[24] stays 0 == RANGE_KIND_NONE, the array default.
            slot[24] = 1f; // RANGE_KIND_COLOR
            slot[25] = (float)r.HueDeg;
            slot[26] = (float)r.HueHalfWidthDeg;
            slot[27] = (float)r.ChromaMin;
            slot[28] = (float)r.LMin;
            slot[29] = (float)r.LMax;
            slot[30] = (float)r.Feather;
        }
    }
}

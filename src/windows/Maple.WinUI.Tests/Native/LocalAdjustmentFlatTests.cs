// LocalAdjustmentFlatTests — pins the C# flat-wire encoder
// (Maple.WinUI/Native/LocalAdjustmentFlat.cs, #3406) against the documented
// slot map in raw-core's `types::local_adjustment::flat` and the values its
// own `#[cfg(test)]` module asserts, so the Rust reader and the C# writer
// stay in lockstep even though neither can execute the other's code.

using System.Collections.Generic;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Xunit;

namespace Maple.WinUI.Tests.Native
{
    public class LocalAdjustmentFlatTests
    {
        [Fact]
        public void EmptyStackSerializesToAnEmptyWire() =>
            Assert.Empty(LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment>()));

        [Fact]
        public void EachLayerIsThirtyTwoFloats()
        {
            var layers = new List<LocalAdjustment>
            {
                new(new LinearMask(new MaskPoint(0, 0), new MaskPoint(1, 0), 0.5), new PartialAdjustments()),
                new(new RadialMask(new MaskPoint(0.5, 0.5), new MaskPoint(0.2, 0.2), 0, 0.5, false), new PartialAdjustments()),
            };
            Assert.Equal(64, LocalAdjustmentFlat.ToFlat(layers).Length);
        }

        /// <summary>Pins the exact fixture raw-core's own
        /// `the_shared_swift_fixture_serializes_to_the_documented_slots`
        /// test asserts: a linear layer, start (0.1, 0.2), end (0.9, 0.8),
        /// feather 0.4, exposure 0.5, shadows −20 — one JSON fixture
        /// (test-fixtures/local-adjustments/layer-stack.json), now four
        /// writers agreeing on it.</summary>
        [Fact]
        public void LinearLayerMatchesTheSharedFixtureSlots()
        {
            var layer = new LocalAdjustment(
                new LinearMask(new MaskPoint(0.1, 0.2), new MaskPoint(0.9, 0.8), 0.4),
                new PartialAdjustments { Exposure = 0.5, Shadows = -20.0 });

            var flat = LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment> { layer });

            Assert.Equal(0.1f, flat[0]);
            Assert.Equal(0.2f, flat[1]);
            Assert.Equal(0.9f, flat[2]);
            Assert.Equal(0.8f, flat[3]);
            Assert.Equal(0.4f, flat[4]);
            Assert.Equal(0f, flat[6]); // KIND_LINEAR
            Assert.Equal(0.5f, flat[12]); // exposure
            Assert.Equal(-20.0f, flat[15]); // shadows
        }

        [Fact]
        public void RadialLayerCarriesKindInvertAndAngle()
        {
            var layer = new LocalAdjustment(
                new RadialMask(new MaskPoint(0.4, 0.6), new MaskPoint(0.3, 0.2), 1.25, 0.5, true),
                new PartialAdjustments());

            var flat = LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment> { layer });

            Assert.Equal(0.4f, flat[0]);
            Assert.Equal(0.6f, flat[1]);
            Assert.Equal(0.3f, flat[2]);
            Assert.Equal(0.2f, flat[3]);
            Assert.Equal(0.5f, flat[4]);
            Assert.Equal(1.25f, flat[5]);
            Assert.Equal(1f, flat[6]); // KIND_RADIAL
            Assert.Equal(1f, flat[7]); // invert
        }

        /// <summary>Presence bitmask: every one of the eleven controls set
        /// yields exactly 2047 (bits 0..10) — the same value raw-core's
        /// `presence_mask_is_exactly_representable_when_every_field_is_set`
        /// pins.</summary>
        [Fact]
        public void PresenceMaskWithEveryControlSetIs2047()
        {
            var layer = new LocalAdjustment(
                new LinearMask(new MaskPoint(0, 0.5), new MaskPoint(1, 0.5), 0),
                new PartialAdjustments
                {
                    Exposure = 0.75, Contrast = -30, Highlights = 45, Shadows = -12.5, Whites = 8, Blacks = -60,
                    Saturation = 22, Vibrance = -5, Temperature = 1500, Tint = -9, Hue = 12,
                });

            var flat = LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment> { layer });

            Assert.Equal(2047f, flat[8]);
            Assert.Equal(12f, flat[22]); // hue rides slot 22
        }

        [Fact]
        public void AbsentControlsStayAtZeroWithNoPresenceBit()
        {
            var layer = new LocalAdjustment(
                new LinearMask(new MaskPoint(0, 0), new MaskPoint(1, 1), 0.5),
                new PartialAdjustments { Saturation = 0.0 }); // explicit 0, distinct from "not set"

            var flat = LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment> { layer });

            Assert.Equal(1u << 6, (uint)flat[8]); // PRESENT_SATURATION only
            Assert.Equal(0f, flat[12]); // exposure slot untouched
        }

        [Fact]
        public void NoRangeRefinementLeavesRangeKindAtZero()
        {
            var layer = new LocalAdjustment(
                new LinearMask(new MaskPoint(0, 0), new MaskPoint(1, 0), 0.5), new PartialAdjustments());
            var flat = LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment> { layer });
            Assert.Equal(0f, flat[24]); // RANGE_KIND_NONE
        }

        [Fact]
        public void ColorRangeRefinementRidesSlots25To30()
        {
            var layer = new LocalAdjustment(
                new LinearMask(new MaskPoint(0, 0), new MaskPoint(1, 0), 0.5),
                new PartialAdjustments(),
                new ColorRangeRefinement(55, 25, 0.02, 0.15, 0.95, 0.3));

            var flat = LocalAdjustmentFlat.ToFlat(new List<LocalAdjustment> { layer });

            Assert.Equal(1f, flat[24]); // RANGE_KIND_COLOR
            Assert.Equal(new[] { 55f, 25f, 0.02f, 0.15f, 0.95f, 0.3f }, flat[25..31]);
        }

        [Fact]
        public void MultipleLayersKeepTheirOrder()
        {
            var layers = new List<LocalAdjustment>
            {
                new(new LinearMask(new MaskPoint(0, 0), new MaskPoint(1, 0), 0), new PartialAdjustments { Exposure = 1.0 }),
                new(new RadialMask(new MaskPoint(0.5, 0.5), new MaskPoint(0.2, 0.2), 0, 0.5, false), new PartialAdjustments { Exposure = -1.0 }),
            };

            var flat = LocalAdjustmentFlat.ToFlat(layers);

            Assert.Equal(1.0f, flat[12]); // layer 0's exposure
            Assert.Equal(-1.0f, flat[LocalAdjustmentFlat.LayerFlatLen + 12]); // layer 1's exposure
        }
    }
}

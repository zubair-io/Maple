// AdjustmentStateAssert — deep field-by-field equality for AdjustmentState.
//
// AdjustmentState (Models/AdjustmentState.cs) is a plain field bag with ~70
// public fields and no Equals override, so a round-trip test that wants to
// assert "the model came back exactly as it went in" needs a real deep
// comparison rather than a handful of hand-picked field checks (which would
// silently stop covering a field the moment someone adds one). Reflection
// over the public instance fields gives that once, here, instead of in every
// test that needs it.

using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Maple.WinUI.Models;
using Xunit;

namespace Maple.WinUI.Tests.Support
{
    internal static class AdjustmentStateAssert
    {
        private static readonly FieldInfo[] Fields =
            typeof(AdjustmentState).GetFields(BindingFlags.Public | BindingFlags.Instance);

        /// <summary>Asserts every public field of <paramref name="expected"/> and
        /// <paramref name="actual"/> holds an equal value. Tone-curve fields
        /// (`List&lt;CurvePoint&gt;`) and the local-adjustment stack
        /// (`List&lt;LocalAdjustment&gt;`) compare by sequence, not by reference.</summary>
        public static void Equal(AdjustmentState expected, AdjustmentState actual)
        {
            foreach (var field in Fields)
            {
                var e = field.GetValue(expected);
                var a = field.GetValue(actual);
                if (e is List<CurvePoint> curveExpected && a is List<CurvePoint> curveActual)
                {
                    Assert.True(
                        curveExpected.SequenceEqual(curveActual),
                        $"{field.Name}: expected [{string.Join(", ", curveExpected)}], " +
                        $"got [{string.Join(", ", curveActual)}]");
                    continue;
                }
                if (e is List<LocalAdjustment> layersExpected && a is List<LocalAdjustment> layersActual)
                {
                    // Records compare by value, so SequenceEqual is a deep
                    // layer-by-layer comparison (#358).
                    Assert.True(
                        layersExpected.SequenceEqual(layersActual),
                        $"{field.Name}: expected [{string.Join(", ", layersExpected)}], " +
                        $"got [{string.Join(", ", layersActual)}]");
                    continue;
                }
                Assert.True(Equals(e, a), $"{field.Name}: expected {e}, got {a}");
            }
        }
    }
}

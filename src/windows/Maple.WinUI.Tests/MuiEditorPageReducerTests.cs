// MuiEditorPageReducerTests — the shared slider-value map and Value Chip
// formatting behind the Maple.UI Editor page (Windows Pages wave,
// #3012). No WinUI/live Window involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiEditorPageReducerTests
    {
        private static readonly IReadOnlyList<MuiEditorPageReducer.SliderDef> Defs = new[]
        {
            new MuiEditorPageReducer.SliderDef("exposure", "Exposure", " EV"),
            new MuiEditorPageReducer.SliderDef("contrast", "Contrast", ""),
        };

        [Fact]
        public void WithValue_AddsOrOverwritesTheGivenSlider()
        {
            var state = new Dictionary<string, double>();
            var next = MuiEditorPageReducer.WithValue(state, "exposure", 0.5);
            Assert.Equal(0.5, next["exposure"]);
        }

        [Fact]
        public void WithValue_LeavesOtherSlidersUntouched()
        {
            var state = new Dictionary<string, double> { ["contrast"] = 10 };
            var next = MuiEditorPageReducer.WithValue(state, "exposure", 0.5);
            Assert.Equal(10, next["contrast"]);
        }

        [Fact]
        public void ValueChips_SkipsUntouchedZeroValueSliders()
        {
            var state = new Dictionary<string, double> { ["exposure"] = 0, ["contrast"] = 0 };
            var chips = MuiEditorPageReducer.ValueChips(state, Defs);
            Assert.Empty(chips);
        }

        [Fact]
        public void ValueChips_FormatsPositiveValueWithLeadingSign()
        {
            var state = new Dictionary<string, double> { ["exposure"] = 0.7 };
            var chips = MuiEditorPageReducer.ValueChips(state, Defs);
            Assert.Equal(("Exposure", "+0.7 EV"), Assert.Single(chips));
        }

        [Fact]
        public void ValueChips_FormatsNegativeValueWithoutDoubleSign()
        {
            var state = new Dictionary<string, double> { ["contrast"] = -15 };
            var chips = MuiEditorPageReducer.ValueChips(state, Defs);
            Assert.Equal(("Contrast", "-15"), Assert.Single(chips));
        }

        [Fact]
        public void ValueChips_PreservesDefsOrderNotDictionaryOrder()
        {
            var state = new Dictionary<string, double> { ["contrast"] = 5, ["exposure"] = 1 };
            var chips = MuiEditorPageReducer.ValueChips(state, Defs);
            Assert.Equal(new[] { "Exposure", "Contrast" }, new[] { chips[0].Label, chips[1].Label });
        }
    }
}

// MaskLayerSelectionLogicTests — pins the four delete-vs-selection
// situations (#3435 review) for MainWindow.Mask.cs's DeleteMaskLayer.

using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MaskLayerSelectionLogicTests
    {
        [Fact]
        public void DeletingALayerBeforeTheSelectionDecrementsTheSelection()
        {
            // [A, B, C(selected=2)] -> delete A(0) -> [B, C(selected=1)]:
            // C's identity is preserved by following it to its new index.
            var next = MaskLayerSelectionLogic.AfterDelete(selectedIndex: 2, deletedIndex: 0, newCount: 2);
            Assert.Equal(1, next);
        }

        [Fact]
        public void DeletingTheSelectedLayerSelectsThePreviousOneWhenOneExists()
        {
            // [A, B(selected=1), C] -> delete B(1) -> [A, C]: A (index 0) takes over.
            var next = MaskLayerSelectionLogic.AfterDelete(selectedIndex: 1, deletedIndex: 1, newCount: 2);
            Assert.Equal(0, next);
        }

        [Fact]
        public void DeletingTheSelectedFirstLayerSelectsTheLayerThatShiftedIntoItsSlot()
        {
            // [A(selected=0), B, C] -> delete A(0) -> [B, C]: no previous layer
            // exists, so the layer that shifted into slot 0 (B) takes over.
            var next = MaskLayerSelectionLogic.AfterDelete(selectedIndex: 0, deletedIndex: 0, newCount: 2);
            Assert.Equal(0, next);
        }

        [Fact]
        public void DeletingALayerAfterTheSelectionLeavesItAlone()
        {
            // [A(selected=0), B, C] -> delete C(2) -> [A, B]: A's index is untouched.
            var next = MaskLayerSelectionLogic.AfterDelete(selectedIndex: 0, deletedIndex: 2, newCount: 2);
            Assert.Equal(0, next);
        }

        [Fact]
        public void DeletingTheLastRemainingLayerLeavesNothingSelected()
        {
            // [A(selected=0)] -> delete A(0) -> []: no layers left.
            var next = MaskLayerSelectionLogic.AfterDelete(selectedIndex: 0, deletedIndex: 0, newCount: 0);
            Assert.Equal(-1, next);
        }

        [Fact]
        public void NoSelectionStaysUnselectedRegardlessOfWhatWasDeleted()
        {
            var next = MaskLayerSelectionLogic.AfterDelete(selectedIndex: -1, deletedIndex: 1, newCount: 2);
            Assert.Equal(-1, next);
        }
    }
}

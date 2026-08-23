// MuiDialogLogicTests — the confirm/cancel result logic behind the Maple.UI
// Dialog molecule (Maple.WinUI/MapleUI/MoleculesL2/MuiDialogLogic.cs, wave
// N4 of the Windows Maple.UI molecules L2, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiDialogLogicTests
    {
        [Fact]
        public void Confirm_ReturnsConfirmedResultWithPromptValue()
        {
            var result = MuiDialogLogic.Confirm("Golden Hour Portraits");

            Assert.Equal(MuiDialogResultKind.Confirmed, result.Kind);
            Assert.Equal("Golden Hour Portraits", result.Value);
        }

        [Fact]
        public void Confirm_OnAConfirmVariantDialog_EmitsEmptyPromptValueVerbatim()
        {
            // A Confirm-variant dialog never wires anything to change the
            // prompt value away from its empty default.
            var result = MuiDialogLogic.Confirm(string.Empty);

            Assert.Equal(MuiDialogResultKind.Confirmed, result.Kind);
            Assert.Equal(string.Empty, result.Value);
        }

        [Fact]
        public void Cancel_ReturnsCancelledResultWithEmptyValue()
        {
            var result = MuiDialogLogic.Cancel();

            Assert.Equal(MuiDialogResultKind.Cancelled, result.Kind);
            Assert.Equal(string.Empty, result.Value);
        }
    }
}

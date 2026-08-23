// MuiPairingPageReducerTests — the scanned-code accept/reject step
// machine behind the Maple.UI Pairing page (Windows Pages wave, #3012).
// No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiPairingPageReducerTests
    {
        private const string Expected = "maple-pair:AB12-CD34";

        [Fact]
        public void Advance_ScanWithMatchingCode_MovesToConnecting()
        {
            Assert.Equal(MuiMockPairStep.Connecting, MuiPairingPageReducer.Advance(MuiMockPairStep.Scan, Expected, Expected));
        }

        [Fact]
        public void Advance_ScanWithMismatchedCode_StaysOnScan()
        {
            Assert.Equal(MuiMockPairStep.Scan, MuiPairingPageReducer.Advance(MuiMockPairStep.Scan, "wrong-code", Expected));
        }

        [Fact]
        public void Advance_Connecting_AlwaysMovesToDone()
        {
            Assert.Equal(MuiMockPairStep.Done, MuiPairingPageReducer.Advance(MuiMockPairStep.Connecting, "anything", Expected));
        }

        [Fact]
        public void Advance_ShowCode_IsUnaffectedByAScan()
        {
            Assert.Equal(MuiMockPairStep.ShowCode, MuiPairingPageReducer.Advance(MuiMockPairStep.ShowCode, Expected, Expected));
        }

        [Fact]
        public void Advance_Done_StaysDone()
        {
            Assert.Equal(MuiMockPairStep.Done, MuiPairingPageReducer.Advance(MuiMockPairStep.Done, Expected, Expected));
        }
    }
}

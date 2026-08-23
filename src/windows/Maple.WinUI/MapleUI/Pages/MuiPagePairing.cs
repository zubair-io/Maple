using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Pairing page (unified-component-catalog.md §6 — App
    /// Shell template hosting a single Pair Device flow). Windows Pages
    /// wave (#3012).
    ///
    /// Real wiring through <see cref="MuiPairingPageReducer"/>: the
    /// modal's own Scanner optimistically jumps to "Connecting" the
    /// moment ANY code is pasted — this page validates the pasted code
    /// against the one this device is displaying and, on a mismatch,
    /// steps the flow back to "Scan" instead of letting a wrong code
    /// silently "pair."
    /// </summary>
    public sealed class MuiPagePairing : ContentControl
    {
        private const string ExpectedPayload = "maple-pair:AB12-CD34";

        private readonly MuiPairDeviceModal _modal = new() { IsOpen = true, Contained = true, Payload = ExpectedPayload };

        public MuiPagePairing()
        {
            _modal.CodeScanned += (_, code) =>
            {
                var accepted = MuiPairingPageReducer.Advance(MuiMockPairStep.Scan, code, ExpectedPayload) == MuiMockPairStep.Connecting;
                _modal.Step = accepted ? MuiPairDeviceStep.Done : MuiPairDeviceStep.Scan;
            };

            var shell = new MuiAppShell { MainContent = _modal };
            Content = shell;
            HorizontalContentAlignment = Microsoft.UI.Xaml.HorizontalAlignment.Stretch;
            VerticalContentAlignment = Microsoft.UI.Xaml.VerticalAlignment.Stretch;
        }
    }
}

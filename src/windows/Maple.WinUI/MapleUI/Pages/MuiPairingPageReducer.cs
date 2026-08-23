namespace Maple.UI
{
    /// <summary>Step state for a Pairing page demo — mirrors
    /// <c>MuiPairDeviceStep</c> (declared in the WinUI-dependent
    /// MuiPairDeviceModal.cs) so this reducer stays linkable into
    /// Maple.WinUI.Tests; the page maps between the two.</summary>
    public enum MuiMockPairStep { ShowCode, Scan, Connecting, Done }

    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPagePairing</c>'s cross-organism wiring (#3012) — a scanned
    /// code only advances the wizard from Scan to Connecting when it
    /// matches the code this device is displaying; a mismatched scan
    /// stays put on Scan (reject-and-retry, not a silent skip). Connecting
    /// always resolves to Done — this demo has no failure path for an
    /// already-matched pairing.</summary>
    public static class MuiPairingPageReducer
    {
        public static MuiMockPairStep Advance(MuiMockPairStep step, string scannedPayload, string expectedPayload) =>
            step switch
            {
                MuiMockPairStep.Scan => scannedPayload == expectedPayload ? MuiMockPairStep.Connecting : MuiMockPairStep.Scan,
                MuiMockPairStep.Connecting => MuiMockPairStep.Done,
                _ => step,
            };
    }
}

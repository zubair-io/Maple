// MuiPagePairing.swift — Maple UI Pages (unified-component-catalog.md
// §6). App Shell hosting a single Pair Device organism, rendered inline
// (`contained: true`) rather than as a floating overlay — this page IS
// the pairing destination (reached from Settings → Devices → "Pair a
// device"), not a modal stacked on top of something else.
//
// Pair Device's step sequence and its per-step gating are already
// organism-tested (`MuiPairDeviceModalTests`), so there's no new pure
// reducer to add here — this page's job is just owning the step/connected
// state Pair Device is driven by and reacting once pairing finishes.

import SwiftUI

public struct MuiPagePairing: View {
    public let paired: ((String) -> Void)?

    @State private var step = 0
    @State private var connected = false

    public init(paired: ((String) -> Void)? = nil) {
        self.paired = paired
    }

    public var body: some View {
        MuiAppShell {
            EmptyView()
        } content: {
            ZStack {
                MuiTokens.bg
                MuiPairDeviceModal(
                    isPresented: true,
                    contained: true,
                    step: step,
                    pairingCode: "MAPLE-7XQ2",
                    connected: connected,
                    stepChanged: { step = $0 },
                    paired: { code in
                        connected = true
                        paired?(code)
                    }
                )
            }
        }
        .background(MuiTokens.bg)
    }
}

#Preview("MuiPagePairing") {
    MuiPagePairing()
        .frame(width: 420, height: 460)
}

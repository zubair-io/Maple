// MuiPairDeviceModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Three-step device pairing flow — Show Code,
// Scanning, Connected — built on Overlay Shell from QR Code, QR Scanner,
// Progress, Progress Step.
//
// The step sequence is driven entirely by the `step` input: this view never
// advances itself except by emitting `stepChanged` for the caller to apply.

import SwiftUI

public struct MuiPairDeviceModal: View {
    public static let steps = ["Show Code", "Scanning", "Connected"]

    public let isPresented: Bool
    public let contained: Bool
    /// 0 = Show Code, 1 = Scanning, 2 = Connected.
    public let step: Int
    public let pairingCode: String
    public let connected: Bool
    public let stepChanged: ((Int) -> Void)?
    public let paired: ((String) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        step: Int,
        pairingCode: String,
        connected: Bool = false,
        stepChanged: ((Int) -> Void)? = nil,
        paired: ((String) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.step = step
        self.pairingCode = pairingCode
        self.connected = connected
        self.stepChanged = stepChanged
        self.paired = paired
        self.dismissed = dismissed
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, size: .sm, accessibilityLabel: "Pair Device", contained: contained) {
            MuiText("Pair Device", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
                ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, label in
                    MuiProgressStep(index: index + 1, label: label, status: Self.status(for: index, current: step))
                }

                switch step {
                case 0:
                    MuiQrCode(value: pairingCode, size: .md)
                case 1:
                    MuiQrScanner(scanned: { _ in stepChanged?(2) })
                default:
                    MuiText("Device connected.", variant: .body, color: .muted)
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                if step < 2 {
                    MuiButton(label: "Next", variant: .primary) { advance() }
                } else {
                    MuiButton(label: "Finish", variant: .primary) { paired?(pairingCode) }
                }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private func advance() {
        stepChanged?(min(2, step + 1))
    }

    /// The `MuiProgressStep` status for step `index` given the current
    /// `step`. Public + static so this is unit-testable without rendering a
    /// view.
    public static func status(for index: Int, current: Int) -> MuiProgressStepStatus {
        index < current ? .done : (index == current ? .active : .pending)
    }
}

#Preview("MuiPairDeviceModal") {
    struct Demo: View {
        @State private var open = false
        @State private var step = 0
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Pair Device", variant: .primary) { open = true }
                MuiPairDeviceModal(
                    isPresented: open, step: step, pairingCode: "MAPLE-7XQ2",
                    stepChanged: { step = $0 }, dismissed: { open = false }
                )
            }
            .frame(width: 360, height: 380)
        }
    }
    return Demo()
}

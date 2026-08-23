// MuiProgressStep.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). One step of a wizard, built from Text, Progress, Button.

import SwiftUI

public enum MuiProgressStepStatus: Sendable {
    case pending, active, done
}

public struct MuiProgressStep: View {
    public let index: Int
    public let label: String
    public let status: MuiProgressStepStatus
    public let continueLabel: String
    public let continued: (() -> Void)?

    public init(
        index: Int,
        label: String,
        status: MuiProgressStepStatus = .pending,
        continueLabel: String = "Continue",
        continued: (() -> Void)? = nil
    ) {
        self.index = index
        self.label = label
        self.status = status
        self.continueLabel = continueLabel
        self.continued = continued
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            HStack(spacing: MuiTokens.spacingSm) {
                Group {
                    if status == .done {
                        MuiIcon(name: "checkmark", size: .xs, color: MuiTokens.successText)
                    } else {
                        Text("\(index)")
                            .font(MuiTokens.TypeScale.font(.chipLabel))
                            .foregroundStyle(status == .active ? MuiTokens.textMain : MuiTokens.textMuted)
                    }
                }
                .frame(width: 20, height: 20)

                MuiText(label, variant: .rowLabel)
            }

            MuiProgress(shape: .bar, size: .sm, value: Self.progressValue(status: status))

            if status == .active {
                MuiButton(label: continueLabel, variant: .primary, size: .sm) {
                    continued?()
                }
            }
        }
    }

    /// The progress bar's value for a step's status — `100` once done,
    /// `nil` (indeterminate — still running) while active, `0` while
    /// pending. Public + static so this is unit-testable without
    /// rendering a view.
    public static func progressValue(status: MuiProgressStepStatus) -> Double? {
        switch status {
        case .done: return 100
        case .active: return nil
        case .pending: return 0
        }
    }
}

#Preview("MuiProgressStep") {
    VStack(alignment: .leading, spacing: 20) {
        MuiProgressStep(index: 1, label: "Select photos", status: .done)
        MuiProgressStep(index: 2, label: "Choose destination", status: .active)
        MuiProgressStep(index: 3, label: "Confirm", status: .pending)
    }
    .padding()
    .frame(width: 260)
    .background(MuiTokens.bg)
}

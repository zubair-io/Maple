// MuiDiagnostics.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). Validation-check runs plus raw
// output, built from Button, Code Block, Badge.
//
// Badge only has two pill tones (`count` = neutral, `signal` = warn), so a
// failing check gets `signal` and pending/passing checks get `count` — the
// pill's text ("Pass"/"Fail"/"Pending") carries the rest of the meaning.

import SwiftUI

public enum MuiDiagnosticCheckStatus: Sendable {
    case pending, pass, fail
}

public struct MuiDiagnosticCheck: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let status: MuiDiagnosticCheckStatus

    public init(id: String, label: String, status: MuiDiagnosticCheckStatus) {
        self.id = id
        self.label = label
        self.status = status
    }
}

public struct MuiDiagnostics: View {
    public let checks: [MuiDiagnosticCheck]
    public let output: String
    public let running: Bool
    public let runRequested: (() -> Void)?

    public init(checks: [MuiDiagnosticCheck], output: String = "", running: Bool = false, runRequested: (() -> Void)? = nil) {
        self.checks = checks
        self.output = output
        self.running = running
        self.runRequested = runRequested
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            HStack {
                MuiText("Validation checks", variant: .eyebrow, color: .muted)
                Spacer()
                MuiButton(label: "Run", variant: .primary, size: .sm, isLoading: running, disabled: running) { runRequested?() }
            }

            VStack(spacing: 0) {
                ForEach(checks) { check in
                    HStack {
                        MuiText(check.label, variant: .rowLabel)
                        Spacer()
                        MuiBadge(variant: Self.badgeVariant(check.status), value: Self.statusLabel(check.status))
                    }
                    .padding(.vertical, MuiTokens.spacingXs)
                }
            }

            if !output.isEmpty {
                MuiCodeBlock(code: output, language: nil)
            }
        }
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func statusLabel(_ status: MuiDiagnosticCheckStatus) -> String {
        switch status {
        case .pending: return "Pending"
        case .pass: return "Pass"
        case .fail: return "Fail"
        }
    }

    public static func badgeVariant(_ status: MuiDiagnosticCheckStatus) -> MuiBadgeVariant {
        status == .fail ? .signal : .count
    }
}

#Preview("MuiDiagnostics") {
    MuiDiagnostics(
        checks: [
            MuiDiagnosticCheck(id: "1", label: "XMP sidecars readable", status: .pass),
            MuiDiagnosticCheck(id: "2", label: "Rust core loaded", status: .pass),
            MuiDiagnosticCheck(id: "3", label: "GPU pipeline available", status: .fail),
        ],
        output: "gpu: no compatible adapter found"
    )
    .padding()
    .frame(width: 320)
    .background(MuiTokens.bg)
}

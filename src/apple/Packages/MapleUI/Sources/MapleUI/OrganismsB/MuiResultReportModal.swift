// MuiResultReportModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Per-item outcome report after a batch job
// (export, rename, …), built on Overlay Shell from List Row, Badge, Empty
// State.

import SwiftUI

public enum MuiResultStatus: Sendable {
    case success, error, skipped
}

public struct MuiResultItem: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let status: MuiResultStatus
    public let detail: String?

    public init(id: String, label: String, status: MuiResultStatus, detail: String? = nil) {
        self.id = id
        self.label = label
        self.status = status
        self.detail = detail
    }
}

public struct MuiResultReportModal: View {
    public let isPresented: Bool
    public let contained: Bool
    public let results: [MuiResultItem]
    public let dismissed: (() -> Void)?
    public let retryFailedRequested: (([String]) -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        results: [MuiResultItem],
        dismissed: (() -> Void)? = nil,
        retryFailedRequested: (([String]) -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.results = results
        self.dismissed = dismissed
        self.retryFailedRequested = retryFailedRequested
    }

    private var failedIds: [String] {
        results.filter { $0.status == .error }.map(\.id)
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Result Report", contained: contained) {
            MuiText("Result Report", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiText(Self.summary(results), variant: .body, color: .muted)

                if results.isEmpty {
                    MuiEmptyState(icon: "checkmark.circle", title: "No results yet")
                } else {
                    VStack(spacing: 0) {
                        ForEach(results) { result in
                            MuiListRow(label: result.label, subtitle: result.detail, trailing: {
                                MuiBadge(variant: Self.badgeVariant(result.status), value: Self.statusLabel(result.status))
                            })
                        }
                    }
                }
            }
        } footer: {
            HStack {
                if !failedIds.isEmpty {
                    MuiButton(label: "Retry Failed", variant: .secondary) { retryFailedRequested?(failedIds) }
                }
                Spacer()
                MuiButton(label: "Done", variant: .primary) { dismissed?() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func summary(_ results: [MuiResultItem]) -> String {
        let succeeded = results.filter { $0.status == .success }.count
        let failed = results.filter { $0.status == .error }.count
        let skipped = results.filter { $0.status == .skipped }.count
        return "\(succeeded) succeeded, \(failed) failed, \(skipped) skipped"
    }

    public static func statusLabel(_ status: MuiResultStatus) -> String {
        switch status {
        case .success: return "Success"
        case .error: return "Error"
        case .skipped: return "Skipped"
        }
    }

    public static func badgeVariant(_ status: MuiResultStatus) -> MuiBadgeVariant {
        status == .error ? .signal : .count
    }
}

#Preview("MuiResultReportModal") {
    struct Demo: View {
        @State private var open = false
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Result Report", variant: .primary) { open = true }
                MuiResultReportModal(
                    isPresented: open,
                    results: [
                        MuiResultItem(id: "1", label: "IMG_0042.dng", status: .success),
                        MuiResultItem(id: "2", label: "IMG_0043.dng", status: .error, detail: "Disk full"),
                    ],
                    dismissed: { open = false }
                )
            }
            .frame(width: 380, height: 340)
        }
    }
    return Demo()
}

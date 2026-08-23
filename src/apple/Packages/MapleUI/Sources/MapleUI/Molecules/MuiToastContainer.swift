// MuiToastContainer.swift — Maple UI Molecules-L1
// (unified-component-catalog.md §2.3). Stacks and positions MuiToast atoms;
// each slot's entrance/exit gets a small per-index delay so a multi-toast
// change cascades rather than every toast animating on the same frame.

import SwiftUI

public struct MuiToastEntry: Identifiable, Sendable {
    public let id: String
    public let variant: MuiToastVariant
    public let message: String
    public let actionLabel: String?
    public let autoDismissMs: Int?

    public init(id: String, variant: MuiToastVariant, message: String, actionLabel: String? = nil, autoDismissMs: Int? = 5000) {
        self.id = id
        self.variant = variant
        self.message = message
        self.actionLabel = actionLabel
        self.autoDismissMs = autoDismissMs
    }
}

public enum MuiToastContainerPosition: Sendable {
    case topRight, bottomRight, bottomCenter
}

private let exitStaggerMs = 60

public struct MuiToastContainer: View {
    public let toasts: [MuiToastEntry]
    public let position: MuiToastContainerPosition
    public let actionPressed: ((String) -> Void)?
    public let dismissed: ((String) -> Void)?

    public init(
        toasts: [MuiToastEntry],
        position: MuiToastContainerPosition = .bottomRight,
        actionPressed: ((String) -> Void)? = nil,
        dismissed: ((String) -> Void)? = nil
    ) {
        self.toasts = toasts
        self.position = position
        self.actionPressed = actionPressed
        self.dismissed = dismissed
    }

    public var body: some View {
        VStack(alignment: horizontalAlignment, spacing: MuiTokens.spacingXs) {
            ForEach(Array(toasts.enumerated()), id: \.element.id) { index, entry in
                MuiToast(
                    variant: entry.variant,
                    message: entry.message,
                    actionLabel: entry.actionLabel,
                    autoDismissMs: entry.autoDismissMs,
                    action: { actionPressed?(entry.id) },
                    dismissed: { dismissed?(entry.id) }
                )
                .animation(.default.delay(Self.exitDelay(forIndex: index)), value: toasts.map(\.id))
            }
        }
        .frame(maxWidth: .infinity, alignment: frameAlignment)
    }

    private var horizontalAlignment: HorizontalAlignment {
        position == .bottomCenter ? .center : .trailing
    }

    private var frameAlignment: Alignment {
        switch position {
        case .topRight: return .topTrailing
        case .bottomRight: return .bottomTrailing
        case .bottomCenter: return .bottom
        }
    }

    /// The transition delay, in seconds, for the toast at `index` — a
    /// small per-slot stagger so a multi-toast dismissal cascades. Public +
    /// static so this is unit-testable without rendering a view.
    public static func exitDelay(forIndex index: Int) -> Double {
        Double(index * exitStaggerMs) / 1000
    }
}

#Preview("MuiToastContainer") {
    MuiToastContainer(
        toasts: [
            MuiToastEntry(id: "1", variant: .success, message: "Export finished", autoDismissMs: nil),
            MuiToastEntry(id: "2", variant: .info, message: "3 photos imported", autoDismissMs: nil),
            MuiToastEntry(id: "3", variant: .error, message: "Batch failed", actionLabel: "Retry", autoDismissMs: nil),
        ],
        position: .bottomRight
    )
    .padding()
    .frame(width: 320, height: 220)
    .background(MuiTokens.bg)
}

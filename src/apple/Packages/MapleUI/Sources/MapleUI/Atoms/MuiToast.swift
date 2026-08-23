// MuiToast.swift — Maple UI Toast atom.
// Contract: docs/design/maple-ui/components/toast.md

import SwiftUI

public enum MuiToastVariant: Sendable {
    case info, success, warning, error
}

/// Drives the enter/resting/leaving lifecycle and the auto-dismiss timer —
/// factored out of the view so the timing is unit-testable against an
/// injected clock instead of racing the real wall clock (toast.md §Props:
/// `autoDismissMs`, `dismissed`).
@MainActor
public final class MuiToastController: ObservableObject {
    public enum Phase: Equatable {
        case entering, resting, leaving, dismissed
    }

    @Published public private(set) var phase: Phase = .entering

    public let autoDismissMs: Int?
    private let sleep: @Sendable (UInt64) async -> Void
    private let onDismissed: () -> Void

    public init(
        autoDismissMs: Int? = 5000,
        sleep: @escaping @Sendable (UInt64) async -> Void = { ns in try? await Task.sleep(nanoseconds: ns) },
        onDismissed: @escaping () -> Void = {}
    ) {
        self.autoDismissMs = autoDismissMs
        self.sleep = sleep
        self.onDismissed = onDismissed
    }

    /// Transitions `entering -> resting`, then (if `autoDismissMs` is set)
    /// waits and dismisses — unless something already started a manual
    /// dismiss in the meantime.
    public func present() async {
        phase = .resting
        guard let autoDismissMs else { return }
        await sleep(UInt64(autoDismissMs) * 1_000_000)
        guard phase == .resting else { return }
        await dismiss()
    }

    /// Starts (or no-ops on top of) the exit transition; `dismissed` fires
    /// only once the transition's own duration has elapsed (toast.md
    /// §States — a caller removing the toast from a list never cuts the
    /// animation short).
    public func dismiss() async {
        guard phase != .leaving, phase != .dismissed else { return }
        phase = .leaving
        await sleep(UInt64(MapleUITokens.Motion.sheetDismiss.ms) * 1_000_000)
        phase = .dismissed
        onDismissed()
    }
}

/// A transient, non-blocking notification for something that just happened
/// outside the user's direct focus (toast.md §Purpose).
public struct MuiToast: View {
    public let variant: MuiToastVariant
    public let message: String
    public let actionLabel: String?
    public let action: (() -> Void)?

    @StateObject private var controller: MuiToastController

    public init(
        variant: MuiToastVariant = .info,
        message: String,
        actionLabel: String? = nil,
        autoDismissMs: Int? = 5000,
        action: (() -> Void)? = nil,
        dismissed: @escaping () -> Void = {},
        sleep: @escaping @Sendable (UInt64) async -> Void = { ns in try? await Task.sleep(nanoseconds: ns) }
    ) {
        self.variant = variant
        self.message = message
        self.actionLabel = actionLabel
        self.action = action
        self._controller = StateObject(
            wrappedValue: MuiToastController(autoDismissMs: autoDismissMs, sleep: sleep, onDismissed: dismissed)
        )
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            MuiIcon(name: Self.iconName(for: variant), size: .sm, color: Self.iconColor(for: variant))
            Text(message)
                .font(MuiTokens.TypeScale.font(.body))
                .foregroundStyle(MuiTokens.textMain)
            Spacer(minLength: MuiTokens.spacingSm)
            if let actionLabel {
                Button(actionLabel) { action?() }
                    .buttonStyle(.plain)
                    .font(MuiTokens.TypeScale.font(.chipLabel))
                    .foregroundStyle(MuiTokens.primary)
            }
            Button {
                Task { await controller.dismiss() }
            } label: {
                MuiIcon(name: "xmark", size: .xs, color: MuiTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, MuiTokens.spacingMd)
        .padding(.vertical, MuiTokens.spacingSm)
        .background(MuiTokens.surfaceAlt, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                .stroke(MuiTokens.border, lineWidth: 1)
        )
        .opacity(controller.phase == .resting ? 1 : 0)
        .offset(y: controller.phase == .entering ? 8 : 0)
        .animation(
            controller.phase == .leaving ? MuiTokens.Motion.sheetDismiss : MuiTokens.Motion.sheetPresent,
            value: controller.phase
        )
        .task { await controller.present() }
        // Non-blocking arrival announcement, unlike a dialog's role="alert"
        // + focus trap (toast.md §Accessibility: role="status" + polite).
        .accessibilityElement(children: .contain)
    }

    private static func iconName(for variant: MuiToastVariant) -> String {
        switch variant {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    private static func iconColor(for variant: MuiToastVariant) -> Color {
        switch variant {
        case .info: return MuiTokens.textMuted
        case .success: return MuiTokens.successText
        case .warning: return MuiTokens.warn
        case .error: return MuiTokens.errorText
        }
    }
}

#Preview("MuiToast — Variants") {
    VStack(alignment: .leading, spacing: 12) {
        MuiToast(variant: .info, message: "Import started", autoDismissMs: nil)
        MuiToast(variant: .success, message: "Export finished", autoDismissMs: nil)
        MuiToast(variant: .warning, message: "3 photos skipped", autoDismissMs: nil)
        MuiToast(variant: .error, message: "Batch export failed", actionLabel: "Retry", autoDismissMs: nil)
    }
    .padding()
    .background(MuiTokens.bg)
}

// MuiBotOutput.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Streaming generated result, built from Text, Progress,
// Avatar.
//
// Reveal timing is driven by an injected clock — same split
// `MuiToastController`/`MuiCodeBlockController` use for their own timing —
// so the tick loop is unit-testable without racing the real wall clock.

import SwiftUI

/// Drives the character-by-character reveal — factored out of the view so
/// it's unit-testable against an injected clock instead of the real timer
/// the web reference drives with `setInterval`.
@MainActor
final class MuiBotOutputController: ObservableObject {
    @Published private(set) var visibleLength = 0

    private let sleep: @Sendable (UInt64) async -> Void

    init(sleep: @escaping @Sendable (UInt64) async -> Void = { ns in try? await Task.sleep(nanoseconds: ns) }) {
        self.sleep = sleep
    }

    /// Reveals `text` progressively, `charsPerTick` characters every
    /// `intervalMs`, until the whole string is visible — or shows it
    /// whole immediately when `streaming` is false. Calls `onCompleted`
    /// exactly once, when the full text becomes visible under streaming
    /// (never for a non-streaming reveal — matching the web reference's
    /// `completed` output, which only fires from its timer path). Exits
    /// early without calling `onCompleted` if the enclosing task is
    /// cancelled (the view disappeared, or `text`/`streaming` changed
    /// mid-reveal).
    func reveal(text: String, streaming: Bool, charsPerTick: Int, intervalMs: Int, onCompleted: () -> Void) async {
        guard streaming else {
            visibleLength = text.count
            return
        }
        visibleLength = 0
        while visibleLength < text.count {
            if Task.isCancelled { return }
            await sleep(UInt64(max(1, intervalMs)) * 1_000_000)
            if Task.isCancelled { return }
            visibleLength = Swift.min(text.count, visibleLength + max(1, charsPerTick))
        }
        onCompleted()
    }
}

public struct MuiBotOutput: View {
    public let text: String
    /// When true, `text` is revealed progressively rather than shown whole.
    public let streaming: Bool
    public let botName: String
    /// Characters revealed per tick.
    public let charsPerTick: Int
    public let intervalMs: Int
    /// Fires once when the full `text` has been revealed under streaming.
    public let completed: (() -> Void)?

    @StateObject private var controller: MuiBotOutputController

    public init(
        text: String,
        streaming: Bool = false,
        botName: String = "Maple AI",
        charsPerTick: Int = 2,
        intervalMs: Int = 30,
        completed: (() -> Void)? = nil
    ) {
        self.text = text
        self.streaming = streaming
        self.botName = botName
        self.charsPerTick = charsPerTick
        self.intervalMs = intervalMs
        self.completed = completed
        self._controller = StateObject(wrappedValue: MuiBotOutputController())
    }

    init(
        text: String,
        streaming: Bool,
        botName: String,
        charsPerTick: Int,
        intervalMs: Int,
        completed: (() -> Void)?,
        controller: @autoclosure @escaping () -> MuiBotOutputController
    ) {
        self.text = text
        self.streaming = streaming
        self.botName = botName
        self.charsPerTick = charsPerTick
        self.intervalMs = intervalMs
        self.completed = completed
        self._controller = StateObject(wrappedValue: controller())
    }

    public var body: some View {
        HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
            MuiAvatar(name: botName, size: .sm)
            VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                MuiText(visibleText, variant: .body, color: .muted, block: true)
                if isRevealing {
                    MuiProgress(shape: .ring, size: .sm, value: nil, label: "Generating")
                }
            }
        }
        .task(id: revealKey) {
            await controller.reveal(text: text, streaming: streaming, charsPerTick: charsPerTick, intervalMs: intervalMs) {
                completed?()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var visibleText: String {
        String(text.prefix(controller.visibleLength))
    }

    private var isRevealing: Bool {
        streaming && controller.visibleLength < text.count
    }

    /// Re-runs the reveal task whenever the source text or streaming flag
    /// changes — mirrors the web reference's `ngOnChanges` gate on those
    /// two inputs.
    private var revealKey: String {
        "\(text)|\(streaming)"
    }
}

#Preview("MuiBotOutput") {
    VStack(alignment: .leading, spacing: 16) {
        MuiBotOutput(text: "This photo was likely taken at golden hour near a coastline.", streaming: true)
        MuiBotOutput(text: "Already-complete caption.", streaming: false)
    }
    .padding()
    .frame(width: 340)
    .background(MuiTokens.bg)
}

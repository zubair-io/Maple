// MuiCodeBlock.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.7; Built from: Text, Button). A monospace block with a
// copy-to-clipboard button; briefly flips to a "Copied" state after a
// successful copy.

import SwiftUI

private let copiedResetNs: UInt64 = 1_500_000_000

/// Drives the copy/reset lifecycle — factored out of the view so it's
/// unit-testable against an injected pasteboard + clock instead of the
/// real system pasteboard and wall clock, the same split
/// `MuiToastController` uses for its own timing.
@MainActor
final class MuiCodeBlockController: ObservableObject {
    @Published private(set) var copied = false

    private let pasteboard: MuiPasteboardWriting
    private let sleep: @Sendable (UInt64) async -> Void

    init(
        pasteboard: MuiPasteboardWriting = MuiSystemPasteboard(),
        sleep: @escaping @Sendable (UInt64) async -> Void = { ns in try? await Task.sleep(nanoseconds: ns) }
    ) {
        self.pasteboard = pasteboard
        self.sleep = sleep
    }

    /// Copies `code` to the pasteboard and flips `copied` on for
    /// `copiedResetNs`.
    func copy(_ code: String) async {
        pasteboard.copy(code)
        copied = true
        await sleep(copiedResetNs)
        copied = false
    }
}

public struct MuiCodeBlock: View {
    public let code: String
    public let language: String?

    @StateObject private var controller: MuiCodeBlockController

    public init(code: String, language: String? = nil) {
        self.code = code
        self.language = language
        self._controller = StateObject(wrappedValue: MuiCodeBlockController())
    }

    init(code: String, language: String?, controller: @autoclosure @escaping () -> MuiCodeBlockController) {
        self.code = code
        self.language = language
        self._controller = StateObject(wrappedValue: controller())
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            HStack {
                if let language {
                    MuiText(language, variant: .toolLabel, color: .muted)
                }
                Spacer()
                MuiButton(
                    label: controller.copied ? "Copied" : "Copy",
                    variant: .ghost,
                    size: .sm,
                    leadingIcon: controller.copied ? "checkmark" : "doc.on.doc"
                ) {
                    Task { await controller.copy(code) }
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(MuiTokens.textMain)
            }
        }
        .padding(MuiTokens.spacingSm)
        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

#Preview("MuiCodeBlock") {
    MuiCodeBlock(code: "let exposure = 0.3\nlet contrast = 1.1", language: "swift")
        .padding()
        .background(MuiTokens.bg)
}

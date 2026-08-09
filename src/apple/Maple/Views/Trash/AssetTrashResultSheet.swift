// AssetTrashResultSheet.swift — end-of-batch report for a grid multi-select
// trash (#2653). Presented only when something's worth telling the user
// about (`AppShell+Trash.swift`'s `presentTrashResultIfNeeded`) — a clean,
// single-destination batch completes silently. Mirrors
// `AssetDropResultSheet`'s structure.

import SwiftUI
import MapleCore

struct AssetTrashResultSheet: View {
    let results: [AssetTrashItemResult]
    let onDismiss: () -> Void

    private var succeededCount: Int {
        results.filter { if case .trashed = $0.outcome { return true }; return false }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Move to Trash Results")
                    .font(MapleTokens.Typography.sheetTitle)
                    .foregroundStyle(MapleTokens.textMain)
                Text("\(succeededCount) of \(results.count) succeeded.")
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMuted)
            }
            .padding(20)

            Divider()

            List(results) { result in
                HStack(spacing: 10) {
                    icon(for: result.outcome)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(result.displayName)
                            .font(MapleTokens.Typography.rowLabel)
                            .foregroundStyle(MapleTokens.textMain)
                        Text(description(for: result.outcome))
                            .font(MapleTokens.Typography.body)
                            .foregroundStyle(MapleTokens.textMuted)
                    }
                    Spacer()
                }
                .accessibilityIdentifier("assetTrashResult.\(result.displayName)")
            }
            .listStyle(.plain)

            Divider()

            HStack {
                Spacer()
                Button("Done", action: onDismiss)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("assetTrashResult.done")
            }
            .padding(16)
        }
        .frame(minWidth: 420, minHeight: 320)
    }

    @ViewBuilder
    private func icon(for outcome: AssetTrashItemResult.Outcome) -> some View {
        switch outcome {
        case .trashed:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(MapleTokens.successText)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
    }

    private func description(for outcome: AssetTrashItemResult.Outcome) -> String {
        switch outcome {
        case .trashed(let destination):
            switch destination {
            case .osTrash: return "Moved to the Trash (Finder)"
            case .mapleTrash: return "Moved to Maple's Trash"
            case .cloudTrash: return "Moved to the server's Trash"
            }
        case .failed(let message):
            return message
        }
    }
}

// MARK: - Previews

#Preview {
    AssetTrashResultSheet(
        results: [
            AssetTrashItemResult(displayName: "IMG_0001.dng", outcome: .trashed(destination: .osTrash)),
            AssetTrashItemResult(displayName: "IMG_0002.dng", outcome: .trashed(destination: .mapleTrash)),
            AssetTrashItemResult(displayName: "IMG_0003.dng", outcome: .failed("This photo no longer exists on the server")),
        ],
        onDismiss: {}
    )
}

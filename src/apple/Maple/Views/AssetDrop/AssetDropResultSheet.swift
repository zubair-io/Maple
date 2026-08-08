// AssetDropResultSheet.swift — end-of-batch report for a drag-onto-
// source-tree move/copy (#2646). Presented only when at least one item
// was skipped or failed (`AppShell+AssetDrop.swift`'s
// `presentDropResultIfNeeded`) — a fully-clean batch completes silently.
// Per-item outcomes, never collapsed into a single alert: a partial
// failure must stay legible about WHICH assets didn't make it.

import SwiftUI
import MapleCore

struct AssetDropResultSheet: View {
    let results: [AssetDropItemResult]
    let onDismiss: () -> Void

    private var succeededCount: Int {
        results.filter { if case .moved = $0.outcome { return true }; if case .copied = $0.outcome { return true }; return false }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Move / Copy Results")
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
                .accessibilityIdentifier("assetDropResult.\(result.displayName)")
            }
            .listStyle(.plain)

            Divider()

            HStack {
                Spacer()
                Button("Done", action: onDismiss)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("assetDropResult.done")
            }
            .padding(16)
        }
        .frame(minWidth: 420, minHeight: 320)
    }

    @ViewBuilder
    private func icon(for outcome: AssetDropItemResult.Outcome) -> some View {
        switch outcome {
        case .moved:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(MapleTokens.successText)
        case .copied:
            Image(systemName: "doc.on.doc.fill").foregroundStyle(MapleTokens.successText)
        case .skipped:
            Image(systemName: "arrow.uturn.forward.circle.fill").foregroundStyle(MapleTokens.textMuted)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
    }

    private func description(for outcome: AssetDropItemResult.Outcome) -> String {
        switch outcome {
        case .moved: return "Moved"
        case .copied: return "Copied"
        case .skipped(let reason): return "Skipped — \(reason)"
        case .failed(let message): return message
        }
    }
}

// MARK: - Previews

#Preview {
    AssetDropResultSheet(
        results: [
            AssetDropItemResult(id: UUID(), displayName: "IMG_0001.dng", outcome: .moved),
            AssetDropItemResult(id: UUID(), displayName: "IMG_0002.dng", outcome: .copied),
            AssetDropItemResult(id: UUID(), displayName: "IMG_0003.dng", outcome: .skipped(reason: "collision")),
            AssetDropItemResult(id: UUID(), displayName: "IMG_0004.dng", outcome: .failed("Destination is no longer reachable")),
        ],
        onDismiss: {}
    )
}

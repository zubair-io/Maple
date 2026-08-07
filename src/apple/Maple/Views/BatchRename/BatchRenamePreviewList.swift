// BatchRenamePreviewList.swift — live before→after list for the whole
// selection (#2641, design doc § "Rename" — batch: "live before/after
// preview, applied sequentially"). Renders either the pre-apply preview
// (`vm.preview`) or, once the sheet has applied, the per-file outcome list
// (`vm.applyResults`) — partial failure is reported per file, never
// collapsed into one pass/fail alert.

import SwiftUI
import MapleCore

// MARK: - BatchRenamePreviewList

struct BatchRenamePreviewList: View {
    let vm: BatchRenameViewModel

    var body: some View {
        List {
            if let results = vm.applyResults {
                ForEach(results) { result in
                    BatchRenameResultRow(result: result)
                }
            } else {
                ForEach(vm.preview) { item in
                    BatchRenamePreviewRow(item: item)
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("batch-rename-preview-list")
        .overlay {
            if vm.isPreviewing && vm.preview.isEmpty {
                ProgressView()
            }
        }
    }
}

// MARK: - BatchRenamePreviewRow

private struct BatchRenamePreviewRow: View {
    let item: BatchRenamePreviewItem

    var body: some View {
        HStack(spacing: 8) {
            Text(item.oldFilename)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "arrow.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
            if let newFilename = item.newFilename {
                Text(newFilename)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if item.duplicate {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .help("Collides with another rendered name in this batch")
                        .accessibilityLabel("Duplicate rendered name")
                }
            } else {
                Text(item.error ?? "Unavailable")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .lineLimit(1)
            }
        }
        .accessibilityIdentifier("batch-rename-preview-row")
        .accessibilityElement(children: .combine)
    }
}

// MARK: - BatchRenameResultRow

private struct BatchRenameResultRow: View {
    let result: BatchRenameApplyResult

    var body: some View {
        HStack(spacing: 8) {
            statusIcon
            Text(result.oldFilename)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "arrow.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Text(subtitle)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(subtitleColor)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityIdentifier("batch-rename-result-row")
        .accessibilityElement(children: .combine)
    }

    private var statusIcon: some View {
        switch result.outcome {
        case .renamed:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .skipped:
            Image(systemName: "arrow.uturn.forward.circle.fill").foregroundStyle(.orange)
        case .failed:
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        }
    }

    private var subtitle: String {
        switch result.outcome {
        case .renamed(let newFilename): return newFilename
        case .skipped(let reason): return "Skipped — \(reason)"
        case .failed(let message): return "Failed — \(message)"
        }
    }

    private var subtitleColor: Color {
        switch result.outcome {
        case .renamed: return .primary
        case .skipped: return .orange
        case .failed: return .red
        }
    }
}

// MARK: - Preview

#Preview {
    BatchRenamePreviewList(
        vm: BatchRenameViewModel(
            assets: [AssetRef(url: URL(fileURLWithPath: "/tmp/test.dng"))],
            routing: .filesystem
        )
    )
}

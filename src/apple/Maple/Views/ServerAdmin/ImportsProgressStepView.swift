// ImportsProgressStepView.swift — Imports wizard step 3: watch a job run
// (#2773).
//
// Cancel is offered while the job is non-terminal, and shows a
// "Cancelling…" state once `cancel_requested` is set — cancel is
// between-files, not instant, so the server confirms asynchronously. A
// terminal job swaps in New Import, plus Retry when
// `ImportSummary.isRetryable` says the job left something worth
// re-attempting.

import SwiftUI
import MapleCore

struct ImportsProgressStepView: View {
    let summary: ImportSummary?

    let onCancel: () -> Void
    let onRetry: () -> Void
    let onNewImport: () -> Void

    var body: some View {
        Section("Importing") {
            if let summary {
                loaded(summary)
            } else {
                HStack {
                    Text("Loading import status…").foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            }
        }
        .listRowBackground(MapleTokens.surface)
    }

    @ViewBuilder
    private func loaded(_ summary: ImportSummary) -> some View {
        ProgressView(value: Double(summary.percent), total: 100)
            .accessibilityIdentifier("imports.progressBar")
        Text("\(summary.percent)%")
            .font(.caption)

        Text(
            ImportsSettingsVM.filesSummaryText(summary) + " · "
                + ImportsSettingsVM.countsSummaryText(summary))
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("imports.progressSummary")

        HStack(spacing: 4) {
            Text("Status:")
            Text(summary.status.rawValue).bold()
            if let error = summary.error {
                Text("— \(error)").foregroundStyle(.red)
            }
        }
        .font(.caption)
        .accessibilityIdentifier("imports.statusLine")

        HStack {
            if !summary.isTerminal {
                Button {
                    onCancel()
                } label: {
                    Text(ImportsSettingsVM.cancelButtonTitle(cancelRequested: summary.cancelRequested))
                }
                .disabled(summary.cancelRequested)
                .accessibilityIdentifier("imports.cancel")
            } else {
                if summary.isRetryable {
                    Button("Retry", action: onRetry)
                        .accessibilityIdentifier("imports.retry")
                }
                Button("New import", action: onNewImport)
                    .accessibilityIdentifier("imports.newImport")
            }
        }
    }
}

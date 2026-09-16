import SwiftUI

struct BackupIssueDetails: View {
  let progress: BackupProgressViewModel
  let failures: Bool
  let startError: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    ViewThatFits(in: .vertical) {
      details.fixedSize(horizontal: false, vertical: true)
      ScrollView { details }
    }
    .frame(width: 280)
    .frame(maxHeight: 320)
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(failures ? "Backup errors" : "Backup warnings")
          .font(.headline)
        Spacer()
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close backup details")
      }
      if failures {
        if BackupStatusPresentation.failureCount(progress, startError: startError) > 0 {
          Text("Stop and start backup to retry failed photos.")
        } else {
          Text("No current errors.")
        }
        if let startError {
          Label(startError, systemImage: "exclamationmark.circle")
        }
        if case .failed(let reason) = progress.walkPhase {
          Label("Library check: \(reason)", systemImage: "exclamationmark.circle")
        }
        if let count = progress.lastWalkSummary?.failedPermanently,
          count > progress.issues.failureCount
        {
          Text(
            "The last library check found \(count.formatted()) failed photos, including earlier runs."
          )
        }
      } else {
        Text(
          progress.issues.warningCount > 0
            ? "Will retry automatically. Other photos continue backing up."
            : "No photos are waiting to retry.")
      }
      ForEach(progress.issues.details(failures: failures)) { detail in
        VStack(alignment: .leading, spacing: 4) {
          Text("\(detail.count.formatted()) \(detail.count == 1 ? "photo" : "photos")")
            .fontWeight(.semibold)
          Text(detail.message)
        }
      }
    }
    .font(.callout)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
  }
}

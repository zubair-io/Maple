import SwiftUI

struct BackupIssueDetails: View {
  let progress: BackupProgressViewModel
  let failures: Bool
  let startError: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if failures {
            Text("Photos that failed need attention. Stop and start backup to retry them.")
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
                "The last library check found \(count.formatted()) failed photos, including failures from earlier runs."
              )
            }
          } else {
            Text("These photos will retry automatically. Backup continues for other photos.")
          }
          ForEach(progress.issues.details(failures: failures)) { detail in
            VStack(alignment: .leading, spacing: 4) {
              Text("\(detail.count.formatted()) \(detail.count == 1 ? "photo" : "photos")")
                .font(.headline)
              Text(detail.message)
            }
          }
          if !failures && progress.issues.warningCount == 0 {
            Text("No photos are waiting to retry.")
          }
          if failures
            && BackupStatusPresentation.failureCount(progress, startError: startError) == 0
          {
            Text("No current errors.")
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
      }
      .navigationTitle(failures ? "Backup errors" : "Backup warnings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .frame(minWidth: 300, minHeight: 280)
  }
}

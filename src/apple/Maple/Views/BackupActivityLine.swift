import SwiftUI

/// One reserved line. New events cannot reset the five-second dwell time.
struct BackupActivityLine: View {
  let progress: BackupProgressViewModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .caption) private var lineHeight = 20.0
  @State private var displayedId: String?

  var body: some View {
    let activities = BackupStatusPresentation.activities(progress)
    let current = activities.first(where: { $0.id == displayedId }) ?? activities.first

    ZStack(alignment: .leading) {
      if let current {
        Label(current.text, systemImage: current.symbol)
          .id(current.id)
          .transition(.opacity)
          .lineLimit(1)
          .truncationMode(.tail)
          .help(current.text)
      } else {
        Text(" ").accessibilityHidden(true)
      }
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .monospacedDigit()
    .frame(maxWidth: .infinity, alignment: .leading)
    .frame(height: lineHeight)
    .clipped()
    .accessibilityIdentifier("backup.status.activity")
    .task {
      displayedId = BackupStatusPresentation.activities(progress).first?.id
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
        guard !Task.isCancelled else { return }
        let next = BackupStatusPresentation.next(
          after: displayedId, in: BackupStatusPresentation.activities(progress))
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) {
          displayedId = next?.id
        }
      }
    }
  }
}

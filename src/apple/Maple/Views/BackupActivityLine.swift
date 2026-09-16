import SwiftUI

/// One reserved line. New events cannot reset the five-second dwell time.
struct BackupActivityLine: View {
  let progress: BackupProgressViewModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .caption) private var lineHeight = 20.0
  @State private var displayed: BackupStatusPresentation.Activity?

  var body: some View {
    ZStack(alignment: .leading) {
      if let displayed = displayed ?? BackupStatusPresentation.activities(progress).first {
        Label(displayed.text, systemImage: displayed.symbol)
          .id(displayed)
          .transition(.opacity)
          .lineLimit(1)
          .truncationMode(.tail)
          .help(displayed.text)
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
      displayed = BackupStatusPresentation.activities(progress).first
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
        guard !Task.isCancelled else { return }
        let next = BackupStatusPresentation.next(
          after: displayed?.id, in: BackupStatusPresentation.activities(progress))
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) {
          displayed = next
        }
      }
    }
  }
}

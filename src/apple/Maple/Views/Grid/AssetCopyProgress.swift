#if os(macOS)
  import MapleUI
  import Observation
  import SwiftUI

  /// Where a Copy of remote originals stands: how many files are done and how far the
  /// current download has got.
  @MainActor
  @Observable
  final class AssetCopyProgress {
    let fileCount: Int
    private(set) var finishedFiles = 0
    private(set) var receivedBytes: Int64 = 0
    private(set) var expectedBytes: Int64?

    init(fileCount: Int) { self.fileCount = fileCount }

    var currentFile: Int { min(finishedFiles + 1, fileCount) }

    /// Nil while a lone download has no known size.
    var fraction: Double? {
      let current: Double? = expectedBytes.flatMap { total in
        total > 0 ? min(1, Double(receivedBytes) / Double(total)) : nil
      }
      guard fileCount > 1 else { return current }
      return (Double(finishedFiles) + (current ?? 0)) / Double(fileCount)
    }

    var title: String {
      fileCount > 1 ? "Copying \(currentFile) of \(fileCount) files" : "Copying file"
    }

    /// A report that arrives after its file finished is ignored.
    func report(received: Int64, total: Int64?, forFile index: Int) {
      guard index == finishedFiles else { return }
      receivedBytes = received
      expectedBytes = total
    }

    func finishFile() {
      finishedFiles += 1
      receivedBytes = 0
      expectedBytes = nil
    }
  }

  struct AssetCopyProgressCard: View {
    let clipboard: AssetFileClipboard

    var body: some View {
      if let progress = clipboard.progress {
        VStack(alignment: .leading, spacing: 8) {
          Text(progress.title)
            .font(.callout.weight(.semibold))
          MuiProgress(shape: .bar, size: .md, value: progress.fraction.map { $0 * 100 })
            .accessibilityLabel("Copy progress")
            .accessibilityIdentifier("copy-progress-bar")
          if progress.receivedBytes > 0 {
            Text(
              EditorCanvasViewVM.downloadByteCountText(
                receivedBytes: progress.receivedBytes, expectedBytes: progress.expectedBytes)
            )
            .font(.caption.monospacedDigit())
            .foregroundStyle(MapleTokens.textMuted)
          }
          MuiButton(label: "Cancel copy", variant: .secondary, size: .sm) {
            clipboard.cancelCopy()
          }
          .accessibilityIdentifier("copy-progress-cancel")
        }
        .padding(14)
        .frame(width: 260, alignment: .leading)
        .background(MapleTokens.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(MapleTokens.border))
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(progress.title)
        .accessibilityIdentifier("copy-progress-card")
      }
    }
  }
#endif

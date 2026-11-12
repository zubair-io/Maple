// StackFilesRow.swift — Info content for a stacked RAW+JPEG tile (#5050): the two files behind
// the one image, each with its name, type and size, the RAW marked as the primary. Renders
// nothing for any other asset, whose one filename `AssetFilenameRow` already shows.

import MapleCore
import SwiftUI

struct StackFilesRow: View {
  let stack: RawJpegStack?

  var body: some View {
    if let stack {
      VStack(alignment: .leading, spacing: 8) {
        Text("Files in this stack")
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.textMuted)
        ForEach(stack.infoRows, id: \.name) { row in
          fileRow(row)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("info-panel-stack-files")
    }
  }

  private func fileRow(_ row: RawJpegStack.InfoRow) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(row.name)
          .font(MapleTokens.Typography.filename)
          .foregroundStyle(MapleTokens.textMain)
          .lineLimit(2)
          .truncationMode(.middle)
          .textSelection(.enabled)
        if row.isPrimary {
          Text("Primary")
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMuted)
        }
      }
      Text([row.type, row.size].compactMap { $0 }.joined(separator: " · "))
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(row.isPrimary ? "info-stack-primary" : "info-stack-companion")
  }
}

#Preview("StackFilesRow") {
  StackFilesRow(
    stack: RawJpegStack(
      primary: .init(name: "IMG_0001.CR3", size: 26_214_400),
      companion: .init(name: "IMG_0001.JPG", size: 8_388_608),
      location: .local(URL(fileURLWithPath: "/tmp/IMG_0001.JPG")))
  )
  .padding()
  .background(MapleTokens.bg)
}

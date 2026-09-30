// AssetDropCollisionSheet.swift — Skip / Replace / Keep Both prompt for
// ONE colliding asset during a drag-onto-source-tree move/copy (#2646).
// Presented per-asset, sequentially, from `AppShell+AssetDrop.swift`'s
// routing loop via `assetDropCollisionPrompt`.

import MapleCore
import MapleUI
import SwiftUI

struct AssetDropCollisionSheet: View {
  let displayName: String
  let onChoice: (AssetDropCollisionChoice) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Text("“\(displayName)” already exists here")
          .font(MapleTokens.Typography.sheetTitle)
          .foregroundStyle(MapleTokens.textMain)
        Text("Choose what to do with this file.")
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.textMuted)
      }

      VStack(spacing: 8) {
        Button {
          onChoice(.replace)
        } label: {
          Label {
            Text("Replace")
          } icon: {
            MuiIcon(name: "sync", size: .sm)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("assetDropCollision.replace")

        Button {
          onChoice(.keepBoth)
        } label: {
          Label {
            Text("Keep Both")
          } icon: {
            MuiIcon(name: "content_copy", size: .sm)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("assetDropCollision.keepBoth")

        Button {
          onChoice(.skip)
        } label: {
          Label {
            Text("Skip")
          } icon: {
            MuiIcon(name: "redo", size: .sm)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("assetDropCollision.skip")
      }
      .buttonStyle(.bordered)
    }
    .padding(24)
    .frame(minWidth: 320)
  }
}

// MARK: - Previews

#Preview {
  AssetDropCollisionSheet(displayName: "IMG_0042.dng", onChoice: { _ in })
}

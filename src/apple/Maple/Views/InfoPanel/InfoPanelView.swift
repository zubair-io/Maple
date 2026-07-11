// InfoPanelView.swift — Responsive-program S6 Info content.
//
// Spec: docs/design/responsive-program/s6-info-inspector.md.
// Tracking ticket: #621 (closes via PR). Epic: #577.
//
// One component, two slots:
//   • Phone bottom sheet (S1c `.mapleBottomSheet`) triggered by the `i`
//     icon in the Editor (S5) header. `isInsideSheet = true` shows the
//     sheet's own header (close X) since the bottom sheet has no chrome
//     beyond the grab handle.
//   • Tablet / desktop right inspector pane (existing `DetailPanel` Info
//     tab). `isInsideSheet = false` drops the header because the tab
//     itself already says "Info". Pane visibility is driven by the
//     existing `cm.detailHidden` persistence key.
//
// Sections (in order):
//   1. RatingFlagsRow      — pick/unflag/reject pill row + 5-star tap row.
//   2. HistogramBlock      — live RGB curves: Self-Hosted via the server
//                            endpoint, local/PhotoKit via the on-device Rust
//                            core (placeholder only for non-RAW / no source).
//   3. CameraLocationGrid  — Body / Lens / Aperture / Shutter / ISO / Focal /
//                            Coords / City. Pulled from ImageMetadataReader
//                            EXIF entries, async-loaded into @State.
//   4. KeywordChipsRow     — editable via `EditSession.setKeywords` (#632).
//                            Tap a chip to remove; tap `+ Add` to dock an
//                            inline TextField, submit on Return.
//
// Field-name notes (PR #609 review):
//   • `CullingState.stars` (NOT `starCount`).
//   • `AssetRef.displayName` (NOT `filename`).
//   • `EditSession.setKeywords(_:)` replaces the full list — there's no
//     `addKeyword`/`removeKeyword` (the chip row diffs against the live
//     `session.culling.keywords` and rewrites the full list on change).
//
// Phone consumer (when S5 Editor lands):
//
//   content
//       .mapleBottomSheet(isPresented: $isInfoOpen) {
//           InfoPanelView(session: editorSession, isInsideSheet: true) {
//               isInfoOpen = false
//           }
//       }
//
// Tablet/desktop consumer (this PR):
//
//   case .info:
//       InfoPanelView(session: session, isInsideSheet: false)

import MapleCore
import SwiftUI

// MARK: - InfoPanelView

struct InfoPanelView: View {
  /// The active editing session. `nil` when no image is selected — the
  /// panel stays visible with disabled / em-dash content so the layout
  /// doesn't jump.
  let session: EditSession?

  /// `true` on the phone bottom sheet — renders the sheet's own header
  /// (title + close X). `false` in the right-pane inspector slot, where
  /// the parent tab bar already labels the panel "Info".
  let isInsideSheet: Bool

  /// Preview can present metadata without editor-only culling and histogram
  /// controls. Other InfoPanel consumers keep the full inspector by default.
  var showsCullingAndHistogram: Bool = true

  /// Phone-only dismiss callback for the sheet's close X. Ignored when
  /// `isInsideSheet == false`. Defaults to a no-op so the desktop slot
  /// can omit it entirely.
  var onClose: () -> Void = {}

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: MapleTokens.Spacing.sectionGap) {
        if isInsideSheet {
          InfoSheetHeader(onClose: onClose)
        }
        if showsCullingAndHistogram {
          RatingFlagsRow(session: session)
          HistogramBlock(session: session)
        }
        CameraLocationGrid(asset: session?.asset)
        KeywordChipsRow(session: session)
      }
      .padding(MapleTokens.Spacing.panelInset)
      // 16pt bottom inset on the sheet so the last chip row clears the
      // home indicator on iPhone with edge-to-edge presentation.
      .padding(.bottom, isInsideSheet ? 16 : 0)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(MapleTokens.sidebar)
    .accessibilityIdentifier("info-panel")
  }
}

// MARK: - InfoSheetHeader

/// Sheet-local title + close X. Only rendered when `isInsideSheet == true`
/// (the bottom-sheet primitive provides only a grab handle; everything else
/// is the content's job).
struct InfoSheetHeader: View {
  let onClose: () -> Void

  var body: some View {
    HStack {
      Text("Info")
        .font(MapleTokens.Typography.sheetTitle)
        .foregroundStyle(MapleTokens.textMain)
      Spacer()
      Button(action: onClose) {
        Image(systemName: "xmark")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(MapleTokens.textMuted)
          .frame(width: 28, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close")
      .accessibilityIdentifier("info-panel-close")
    }
    // Subtle bottom rule keeps the title visually anchored when scroll
    // content slides under it.
    .padding(.bottom, 4)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(MapleTokens.border)
        .frame(height: 0.5)
    }
  }
}

// MARK: - Previews

#Preview("InfoPanelView — sheet slot (no session)") {
  InfoPanelView(session: nil, isInsideSheet: true)
    .frame(width: 380, height: 600)
    .background(MapleTokens.bg)
}

#Preview("InfoPanelView — inspector slot (no session)") {
  InfoPanelView(session: nil, isInsideSheet: false)
    .frame(width: 280, height: 600)
    .background(MapleTokens.bg)
}

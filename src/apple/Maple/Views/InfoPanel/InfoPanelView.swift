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
//   5. EnrichmentBlock     — Self-Hosted AI-derived data (description / OCR /
//                            transcript) fetched from `GET /api/assets/:id`.
//                            Renders nothing for local / PhotoKit assets, or
//                            when the asset carries no enrichment.
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

  // Self-Hosted rich detail (description / OCR / transcript / place / vision /
  // faces / city / size), fetched once here and shared by the camera grid
  // (City / Size) and the enrichment sections — so both read one server call
  // (#2518). `nil` for local / PhotoKit assets or before the fetch resolves.
  @Environment(\.cloudAssetDetailClient) private var detailClient
  @State private var enrichment: CloudEnrichmentSections?
  /// Identity of the asset `enrichment` was fetched for — clears stale
  /// content on an asset switch.
  @State private var shownAssetID: UUID?
  /// Generation guard so a late fetch for a superseded asset can't clobber
  /// the current one.
  @State private var loadGeneration = 0

  private var asset: AssetRef? { session?.asset }

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
        CameraLocationGrid(asset: session?.asset, enrichment: enrichment)
        KeywordChipsRow(session: session)
        EnrichmentBlock(sections: enrichment)
      }
      .padding(MapleTokens.Spacing.panelInset)
      // 16pt bottom inset on the sheet so the last chip row clears the
      // home indicator on iPhone with edge-to-edge presentation.
      .padding(.bottom, isInsideSheet ? 16 : 0)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(MapleTokens.sidebar)
    .accessibilityIdentifier("info-panel")
    .task(
      id: EnrichmentKey(
        assetID: asset?.id,
        address: asset?.catalog?.address,
        clientHost: detailClient?.server.absoluteString
      )
    ) {
      await loadEnrichment()
    }
  }

  /// Fetch the rich detail for the current (asset, client) tuple via the
  /// address-based endpoint. Local / PhotoKit assets (no client, or no
  /// catalog address) clear to `nil` and the dependent rows fall back to "—".
  @MainActor
  private func loadEnrichment() async {
    loadGeneration &+= 1
    let gen = loadGeneration

    // Clear on an asset SWITCH so the previous asset's content doesn't linger
    // while the new fetch is in flight.
    if asset?.id != shownAssetID {
      enrichment = nil
    }

    guard let detailClient, let asset, let address = asset.catalog?.address else {
      enrichment = nil
      return
    }

    do {
      let detail = try await detailClient.detail(address: address)
      guard gen == loadGeneration else { return }
      enrichment = detail.sections
      shownAssetID = asset.id
    } catch {
      // Fetch failed — leave any prior content rather than flashing empty; a
      // genuinely enrichment-less asset stays nil from the asset-switch clear.
    }
  }

  /// Hashable `.task(id:)` key — re-fetches on asset swap or server change.
  private struct EnrichmentKey: Hashable {
    let assetID: UUID?
    let address: String?
    let clientHost: String?
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

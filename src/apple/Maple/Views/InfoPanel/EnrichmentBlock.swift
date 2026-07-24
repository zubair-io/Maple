// EnrichmentBlock.swift — S6 Info content, enrichment section.
//
// Surfaces the AI-derived, per-asset data the Self-Hosted worker stages
// produce: the qwen3-vl description, recognised text (OCR), and the
// speech-to-text transcript for video/audio. This data lives in Mongo
// only (never the XMP sidecar), so it is fetched from the server via
// `GET /api/assets/:id` — mirroring how `HistogramBlock` sources its
// curves from the server for cloud assets.
//
// Availability mirrors HistogramBlock exactly:
//   • Self-Hosted — a `\.cloudAssetDetailClient` is injected AND the asset
//     carries a server `stableID`: fetch + render whichever of the three
//     sections have content.
//   • Filesystem / PhotoKit — no client (or no stableID): the whole block
//     renders nothing (these assets have no server-side enrichment).
//
// Each section hides independently when its field is empty, and the block
// emits no chrome at all when the asset carries no enrichment — so a plain
// local RAW's Info panel is unchanged.

import MapleCore
import SwiftUI

// MARK: - Environment key

/// Environment slot for the Self-Hosted asset-detail client. `nil` (the
/// default) means "no server in this context" — the enrichment block
/// renders nothing. Set by the Cloud action setup when a Self-Hosted
/// asset is opened, cleared when leaving cloud context. Mirrors
/// `CloudHistogramClientKey`.
struct CloudAssetDetailClientKey: EnvironmentKey {
  static let defaultValue: CloudAssetDetailClient? = nil
}

extension EnvironmentValues {
  var cloudAssetDetailClient: CloudAssetDetailClient? {
    get { self[CloudAssetDetailClientKey.self] }
    set { self[CloudAssetDetailClientKey.self] = newValue }
  }
}

// MARK: - EnrichmentBlock

struct EnrichmentBlock: View {
  /// The active editing session. Enrichment is keyed on `session.asset`.
  /// `nil` ⇒ nothing to show.
  let session: EditSession?

  @Environment(\.cloudAssetDetailClient) private var client
  @State private var sections: CloudEnrichmentSections?
  /// Identity of the asset the current `sections` were fetched for — used
  /// to clear stale content on an asset switch.
  @State private var shownAssetID: UUID?
  /// Generation guard so a late fetch for a superseded asset can't clobber
  /// the current one.
  @State private var loadGeneration = 0

  private var asset: AssetRef? { session?.asset }

  var body: some View {
    content
      // Built in `body` (MainActor) so reading the asset is legal; `.task`
      // re-runs whenever the (asset, client) tuple changes.
      .task(
        id: TaskKey(
          assetID: asset?.id,
          stableID: asset?.stableID,
          clientHost: client?.server.absoluteString
        )
      ) {
        await refresh()
      }
  }

  @ViewBuilder
  private var content: some View {
    if let sections, !sections.isEmpty {
      VStack(alignment: .leading, spacing: MapleTokens.Spacing.sectionGap) {
        if let description = sections.description {
          textSection("Description", body: description)
        }
        if let ocrText = sections.ocrText {
          textSection("Text", body: ocrText, monospaced: true)
        }
        if let transcriptText = sections.transcriptText {
          textSection("Transcript", body: transcriptText, footer: sections.transcriptFooter)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("info-panel-enrichment")
    }
  }

  /// One titled plain-text section. `monospaced` for OCR (preserves the
  /// on-image layout the way the web pane's `<pre>` does); `footer` is the
  /// small muted provenance line under the transcript.
  private func textSection(
    _ title: String,
    body: String,
    monospaced: Bool = false,
    footer: String? = nil
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title.uppercased())
        .font(MapleTokens.Typography.eyebrow)
        .foregroundStyle(MapleTokens.textMuted)
        .tracking(1.4)
      Text(body)
        .font(monospaced ? .system(.footnote, design: .monospaced) : MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMain)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let footer {
        Text(footer)
          .font(MapleTokens.Typography.toolLabel)
          .foregroundStyle(MapleTokens.textMuted)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("info-enrichment-\(title.lowercased())")
  }

  // MARK: - Fetch

  /// Fetch enrichment for the current (asset, client) tuple. Only the
  /// Self-Hosted path exists — enrichment lives on the server, so a local
  /// asset (no client / no stableID) clears to `nil` and the block hides.
  @MainActor
  private func refresh() async {
    loadGeneration &+= 1
    let gen = loadGeneration

    // Clear stale content on an asset SWITCH so the previous asset's
    // description doesn't linger while the new fetch is in flight.
    if asset?.id != shownAssetID {
      sections = nil
    }

    guard let client, let asset, let assetID = asset.stableID else {
      sections = nil
      return
    }

    do {
      let detail = try await client.detail(assetID: assetID)
      guard gen == loadGeneration else { return }
      sections = detail.sections
      shownAssetID = asset.id
    } catch {
      // Fetch failed — leave any prior content in place rather than
      // flashing empty; a genuinely enrichment-less asset stays nil from
      // the asset-switch clear above.
    }
  }

  /// Hashable `.task(id:)` key — re-fetches on asset swap or server change.
  private struct TaskKey: Hashable {
    let assetID: UUID?
    let stableID: String?
    let clientHost: String?
  }
}

// MARK: - Previews

#Preview("EnrichmentBlock — no session") {
  // No session ⇒ no client ⇒ renders nothing.
  EnrichmentBlock(session: nil)
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}

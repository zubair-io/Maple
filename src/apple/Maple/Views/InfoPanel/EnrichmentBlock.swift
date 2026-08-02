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

/// Renders the Self-Hosted enrichment sections. Pure — the detail fetch is
/// owned by `InfoPanelView`, which passes the projected `sections` in (and
/// `nil` for local / PhotoKit assets or before the fetch resolves, in which
/// case the block renders nothing). Description / OCR / Transcript / Vision
/// hide when empty; Place and Faces always render once the detail is fetched
/// (mirroring the web pane, which shows "No place set" / "0 faces detected").
struct EnrichmentBlock: View {
  let sections: CloudEnrichmentSections?

  var body: some View {
    if let sections {
      VStack(alignment: .leading, spacing: MapleTokens.Spacing.sectionGap) {
        PlaceBlock(place: sections.place)
        if let description = sections.description {
          textSection("Description", body: description)
        }
        if let ocrText = sections.ocrText {
          textSection("Text", body: ocrText, monospaced: true)
        }
        if let vision = sections.vision {
          VisionBlock(vision: vision)
        }
        if let transcriptText = sections.transcriptText {
          textSection("Transcript", body: transcriptText, footer: sections.transcriptFooter)
        }
        FacesBlock(faces: sections.faces)
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
}

// MARK: - Previews

#Preview("EnrichmentBlock — nil sections") {
  // No sections ⇒ renders nothing (local / PhotoKit asset).
  EnrichmentBlock(sections: nil)
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}

#Preview("EnrichmentBlock — populated") {
  EnrichmentBlock(sections: CloudEnrichmentSections(
    description: "A red barn at golden hour.",
    ocrText: "OPEN 24 HOURS",
    transcriptText: nil,
    transcriptFooter: nil,
    city: "Albany",
    fileSize: 42_000_000,
    place: CloudPlaceDisplay(rollupLine: "Albany, New York", displayName: "Albany, NY, USA"),
    vision: CloudVisionDisplay(
      isScreenshot: false,
      subjects: ["barn", "field"],
      primaryChips: ["outdoor", "farm"],
      secondaryChips: ["warm", "golden hour"],
      notableObjects: ["tractor"],
      colors: ["red", "gold"],
      footer: "qwen2.5-vl · prompt v6"),
    faces: CloudFacesDisplay(
      count: 2,
      tagged: [FaceTag(personID: "p1", name: "Ada")],
      untaggedCount: 1)))
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}

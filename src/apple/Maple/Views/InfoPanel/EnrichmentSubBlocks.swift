// EnrichmentSubBlocks.swift — S6 Info pane, the Place / Vision / Faces
// enrichment sections (#2518). Read-only display parity with the web
// `info-place` / `info-vision` / `info-faces` components. Pure renderers of
// the pre-formatted `CloudEnrichmentSections` projections — no fetching, no
// logic; the fetch is owned by `InfoPanelView`.
//
// (The web pane also offers inline edit / re-geocode / re-detect affordances
// backed by the enrichment-management endpoints and settings-page links;
// those are a separate web feature and out of scope here — the Apple info
// pane is a read-only inspector.)

import MapleCore
import SwiftUI

// MARK: - Shared chrome

/// Small bordered chip, matching the web enrichment chips.
struct InfoChip: View {
  let text: String
  var muted: Bool = false

  var body: some View {
    Text(text)
      .font(MapleTokens.Typography.chipLabel)
      .foregroundStyle(muted ? MapleTokens.textMuted : MapleTokens.textMain)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(MapleTokens.surfaceAlt, in: RoundedRectangle(cornerRadius: 3))
      .overlay(
        RoundedRectangle(cornerRadius: 3)
          .stroke(MapleTokens.border, lineWidth: 0.5)
      )
  }
}

/// Eyebrow section header, matching `EnrichmentBlock.textSection`.
struct EnrichmentHeader: View {
  let title: String
  var body: some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
  }
}

// MARK: - Place

struct PlaceBlock: View {
  let place: CloudPlaceDisplay?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      EnrichmentHeader(title: "Place")
      if let place {
        if let rollup = place.rollupLine {
          Text(rollup)
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMain)
            .textSelection(.enabled)
        }
        if let name = place.displayName {
          Text(name)
            .font(MapleTokens.Typography.toolLabel)
            .foregroundStyle(MapleTokens.textMuted)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
      } else {
        Text("No place set")
          .font(MapleTokens.Typography.body)
          .foregroundStyle(MapleTokens.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("info-enrichment-place")
  }
}

// MARK: - Vision

struct VisionBlock: View {
  let vision: CloudVisionDisplay

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      EnrichmentHeader(title: "Vision")
      if vision.isScreenshot {
        InfoChip(text: "Screenshot")
      }
      chipGroup("Subjects", vision.subjects)
      if !vision.primaryChips.isEmpty {
        FlowLayout(spacing: 6) {
          ForEach(vision.primaryChips, id: \.self) { InfoChip(text: $0) }
        }
      }
      if !vision.secondaryChips.isEmpty {
        FlowLayout(spacing: 6) {
          ForEach(vision.secondaryChips, id: \.self) { InfoChip(text: $0, muted: true) }
        }
      }
      chipGroup("Notable objects", vision.notableObjects)
      chipGroup("Colors", vision.colors)
      if let footer = vision.footer {
        Text(footer)
          .font(MapleTokens.Typography.toolLabel)
          .foregroundStyle(MapleTokens.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-enrichment-vision")
  }

  @ViewBuilder
  private func chipGroup(_ label: String, _ values: [String]) -> some View {
    if !values.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text(label.uppercased())
          .font(MapleTokens.Typography.toolLabel)
          .foregroundStyle(MapleTokens.textMuted)
          .tracking(0.3)
        FlowLayout(spacing: 6) {
          ForEach(values, id: \.self) { InfoChip(text: $0) }
        }
      }
    }
  }
}

// MARK: - Faces

struct FacesBlock: View {
  let faces: CloudFacesDisplay

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      EnrichmentHeader(title: "Faces")
      Text("\(faces.count) \(faces.count == 1 ? "face" : "faces") detected")
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMain)
      if !faces.taggedPersonIDs.isEmpty || faces.untaggedCount > 0 {
        FlowLayout(spacing: 6) {
          ForEach(faces.taggedPersonIDs, id: \.self) { InfoChip(text: $0) }
          if faces.untaggedCount > 0 {
            InfoChip(text: "+ \(faces.untaggedCount) unnamed", muted: true)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-enrichment-faces")
  }
}

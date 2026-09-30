// MuiIcon.swift — Maple UI Icon atom.
// Contract: docs/design/maple-ui/components/icon.md
//
// New icons use canonical Google Material Symbols Rounded names (#3686).
// Legacy SF names remain during the tracked caller migration in #3899;
// cloud/calendar keep their deliberate cross-platform custom outlines.

import SwiftUI

/// Icon atom size scale (icon.md §Tokens used — not yet tokenized in
/// `ui_tokens.rs`; hardcoded per the contract's explicit five-step scale
/// until a follow-up foundation task adds `ICON_SIZE_TOKENS`).
public enum MuiIconSize: Sendable {
  case xs, sm, md, lg, xl

  var points: CGFloat {
    switch self {
    case .xs: return 14
    case .sm: return 16
    case .md: return 24
    case .lg: return 30
    case .xl: return 36
    }
  }
}

/// A single glyph, `currentColor`-tinted by default (icon.md §Tokens used).
///
/// Decorative by default — hidden from assistive technology, since most
/// icons pair with visible text elsewhere (icon.md §Accessibility). Pass
/// `accessibilityLabel` only for the rare standalone, meaningful-on-its-own
/// icon; a bare `MuiIcon` is never itself an interactive unlabeled control —
/// that's the wrapping component's job (e.g. `MuiButton`'s icon-only mode).
public struct MuiIcon: View {
  public let name: String
  public let size: MuiIconSize
  public let filled: Bool
  public let color: Color?
  public let accessibilityLabel: String?

  public init(
    name: String,
    size: MuiIconSize = .md,
    filled: Bool = false,
    color: Color? = nil,
    accessibilityLabel: String? = nil
  ) {
    self.name = name
    self.size = size
    self.filled = filled
    self.color = color
    self.accessibilityLabel = accessibilityLabel
  }

  public var body: some View {
    Group {
      if let mirroredPath = MuiIconRegistry.path(for: name) {
        // #3024: "cloud"/"calendar" mirror Windows' hand-drawn paths
        // byte-for-byte instead of resolving to an SF Symbol, so
        // they read identically to the Windows/Web chrome.
        strokeGlyph(mirroredPath)
      } else if let materialPath = MuiMaterialSymbols.path(
        for: MuiIconLegacyNames.materialName(for: name),
        filled: filled || MuiIconLegacyNames.isFilled(name))
      {
        materialGlyph(materialPath)
      } else if let color {
        Image(systemName: name)
          .font(.system(size: size.points))
          .foregroundStyle(color)
      } else {
        // No explicit color: inherit from the surrounding
        // environment (SwiftUI's nearest equivalent to CSS
        // `currentColor`) rather than forcing a token.
        Image(systemName: name)
          .font(.system(size: size.points))
      }
    }
    .frame(width: size.points, height: size.points)
    .accessibilityHidden(accessibilityLabel == nil)
    .accessibilityLabel(accessibilityLabel ?? "")
  }

  @ViewBuilder
  private func materialGlyph(_ path: Path) -> some View {
    let scaled = path.applying(.init(scaleX: size.points / 24, y: size.points / 24))
    if let color {
      scaled.fill(color)
    } else {
      scaled.fill()
    }
  }

  /// Renders a `MuiIconRegistry` path at the requested size, scaled up
  /// from its native 16×16 design space so the stroke width scales
  /// proportionally with it — the same effect an SVG viewBox or XAML
  /// Viewbox gives the Web/Windows versions of the same glyph.
  @ViewBuilder
  private func strokeGlyph(_ path: Path) -> some View {
    let stroked = path.stroke(
      style: StrokeStyle(lineWidth: MuiIconRegistry.strokeWidth, lineCap: .round, lineJoin: .round))
    Group {
      if let color {
        stroked.foregroundStyle(color)
      } else {
        stroked
      }
    }
    .frame(width: 16, height: 16)
    .scaleEffect(size.points / 16)
  }
}

#Preview("MuiIcon — Sizes") {
  HStack(alignment: .bottom, spacing: 16) {
    ForEach([MuiIconSize.xs, .sm, .md, .lg, .xl], id: \.points) { size in
      VStack(spacing: 4) {
        MuiIcon(name: "star", size: size, filled: true, color: MuiTokens.primary)
        Text("\(Int(size.points))").font(.caption2).foregroundStyle(MuiTokens.textMuted)
      }
    }
  }
  .padding()
  .background(MuiTokens.bg)
}

#Preview("MuiIcon — currentColor inheritance") {
  VStack(spacing: 12) {
    MuiIcon(name: "favorite", filled: true).foregroundStyle(MuiTokens.errorText)
    MuiIcon(name: "check_circle", filled: true).foregroundStyle(MuiTokens.successText)
  }
  .padding()
  .background(MuiTokens.bg)
}

#Preview("MuiIcon — Material Symbols Rounded") {
  HStack(spacing: 16) {
    MuiIcon(name: "lan", color: .green)
    MuiIcon(name: "public", color: .orange)
    MuiIcon(name: "photo_camera")
    MuiIcon(name: "tune")
  }
  .padding()
}

#Preview("MuiIcon — Mirrored glyphs (#3024)") {
  HStack(alignment: .bottom, spacing: 16) {
    ForEach([MuiIconSize.xs, .sm, .md, .lg, .xl], id: \.points) { size in
      VStack(spacing: 4) {
        MuiIcon(name: "cloud", size: size, color: MuiTokens.textMain)
        MuiIcon(name: "calendar", size: size, color: MuiTokens.textMain)
        Text("\(Int(size.points))").font(.caption2).foregroundStyle(MuiTokens.textMuted)
      }
    }
  }
  .padding()
  .background(MuiTokens.bg)
}

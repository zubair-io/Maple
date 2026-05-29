// RatingFlagsRow.swift — S6 Info content, section 1.
//
// One row, two halves:
//   • Three 24pt pill circles: Pick (P / green) · Unflagged (— / muted) ·
//     Reject (X / red). The active flag has a filled background; the other
//     two render as ghosted outlines.
//   • Five-star tap row on the right. Tapping a star sets `culling.stars`;
//     tapping the currently-selected star clears it (Lightroom-style toggle).
//
// Binds the EditSession's `culling` value-type. Writes go through
// EditSession's `didSet` which schedules the 750ms-debounced XMP save and
// the render bump (`Task { await sidecarStore.update(...) }`).

import MapleCore
import SwiftUI

// MARK: - RatingFlagsRow

struct RatingFlagsRow: View {
  /// Live EditSession. When `nil`, the row renders disabled (taps do
  /// nothing, opacity drops). Keeps the layout stable across cold-open.
  let session: EditSession?

  var body: some View {
    HStack(spacing: 16) {
      FlagsPillRow(session: session)
      Spacer(minLength: 8)
      StarsTapRow(session: session)
    }
    .padding(.vertical, 4)
    .opacity(session == nil ? 0.5 : 1.0)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-rating-flags")
  }
}

// MARK: - FlagsPillRow

struct FlagsPillRow: View {
  let session: EditSession?

  var body: some View {
    HStack(spacing: 8) {
      FlagPill(
        flag: .pick,
        active: currentFlag == .pick,
        action: { toggle(.pick) }
      )
      FlagPill(
        flag: .none,
        active: currentFlag == .none,
        action: { toggle(.none) }
      )
      FlagPill(
        flag: .reject,
        active: currentFlag == .reject,
        action: { toggle(.reject) }
      )
    }
  }

  private var currentFlag: CullFlag {
    session?.culling.flag ?? .none
  }

  /// Tapping a flag pill sets it as the new flag. Tapping the currently
  /// selected pill is a no-op (the visual already shows it active —
  /// users that want to unflag tap the middle pill).
  private func toggle(_ flag: CullFlag) {
    guard let session, session.culling.flag != flag else { return }
    session.culling.flag = flag
  }
}

// MARK: - FlagPill

struct FlagPill: View {
  let flag: CullFlag
  let active: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        Circle()
          .fill(activeFill)
          .overlay(Circle().stroke(activeStroke, lineWidth: 1))
          .frame(width: 24, height: 24)
        glyph
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(glyphColor)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityIdentifier("info-panel-flag-\(identifier)")
    .accessibilityAddTraits(active ? .isSelected : [])
  }

  private var glyph: some View {
    Group {
      switch flag {
      case .pick: Text("P")
      case .none: Text("—")
      case .reject: Image(systemName: "xmark")
      }
    }
  }

  private var activeFill: Color {
    guard active else { return MapleTokens.surfaceAlt }
    switch flag {
    case .pick: return MapleTokens.successBg
    case .reject: return MapleTokens.errorBg
    case .none: return MapleTokens.surfaceHover
    }
  }

  private var activeStroke: Color {
    guard active else { return MapleTokens.border }
    switch flag {
    case .pick: return MapleTokens.successText
    case .reject: return MapleTokens.errorText
    case .none: return MapleTokens.borderHi
    }
  }

  private var glyphColor: Color {
    switch flag {
    case .pick: return active ? MapleTokens.successText : MapleTokens.textMuted
    case .reject: return active ? MapleTokens.errorText : MapleTokens.textMuted
    case .none: return active ? MapleTokens.textMain : MapleTokens.textMuted
    }
  }

  private var label: String {
    switch flag {
    case .pick: return "Pick"
    case .none: return "Unflagged"
    case .reject: return "Reject"
    }
  }

  private var identifier: String {
    switch flag {
    case .pick: return "pick"
    case .none: return "unflagged"
    case .reject: return "reject"
    }
  }
}

// MARK: - StarsTapRow

struct StarsTapRow: View {
  let session: EditSession?

  var body: some View {
    HStack(spacing: 4) {
      ForEach(1...5, id: \.self) { i in
        Button(action: { tap(i) }) {
          Image(systemName: i <= currentStars ? "star.fill" : "star")
            .font(.system(size: 14))
            .foregroundStyle(i <= currentStars ? MapleTokens.star : MapleTokens.textMuted)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(i) star\(i == 1 ? "" : "s")")
        .accessibilityIdentifier("info-panel-star-\(i)")
        .accessibilityAddTraits(i <= currentStars ? .isSelected : [])
      }
    }
  }

  private var currentStars: Int {
    session?.culling.stars ?? 0
  }

  /// Tap-same-star clears the rating (toggle to 0). Tap a different star
  /// sets the new value. Matches Lightroom + the existing keyboard handler
  /// in EditorShell ("0 to clear, 1–5 to set").
  private func tap(_ star: Int) {
    guard let session else { return }
    session.culling.stars = (session.culling.stars == star) ? 0 : star
  }
}

// MARK: - Previews

#Preview("RatingFlagsRow — no session (disabled)") {
  RatingFlagsRow(session: nil)
    .padding()
    .background(MapleTokens.bg)
}

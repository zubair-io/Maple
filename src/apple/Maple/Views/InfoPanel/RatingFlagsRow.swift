// RatingFlagsRow.swift — S6 Info content, section 1.
//
// Thin adapter around MapleUI's `MuiRatingFlags` molecule (Maple UI
// adoption epic #3019, wave MA3). Two consumers share this exact type —
// `InfoPanelView` (the inspector pane) and `PreviewView`'s flag popover /
// bottom sheet — so the file keeps its original `RatingFlagsRow(session:)`
// call-site shape while delegating the actual star/flag rendering to the
// design-system component.
//
// Binds the EditSession's `culling` value-type. Writes go through
// EditSession's `didSet` which schedules the 750ms-debounced XMP save and
// the render bump (`Task { await sidecarStore.update(...) }`).
//
// Interaction note: `MuiRatingFlags` cycles the flag through
// none → pick → reject → none behind a single flag icon, replacing the
// previous three-pill (Pick / Unflagged / Reject) direct-select row. The
// underlying `CullFlag` data model and the 5-star tap-to-clear behavior
// are unchanged — only the flag control's gesture shape moved to match
// the shared design system.

import MapleCore
import MapleUI
import SwiftUI

// MARK: - RatingFlagsRow

struct RatingFlagsRow: View {
  /// Live EditSession. When `nil`, the row renders disabled (taps do
  /// nothing, opacity drops). Keeps the layout stable across cold-open.
  let session: EditSession?

  var body: some View {
    MuiRatingFlags(
      rating: Binding(
        get: { session?.culling.stars ?? 0 },
        set: { session?.culling.stars = $0 }
      ),
      flag: Binding(
        get: { RatingFlagsRow.muiFlag(for: session?.culling.flag ?? .none) },
        set: { session?.culling.flag = RatingFlagsRow.cullFlag(for: $0) }
      ),
      disabled: session == nil
    )
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-rating-flags")
  }

  /// `CullFlag` → `MuiRatingFlagState`. The two enums share the same
  /// three-way vocabulary (none / pick / reject) by design, so this is a
  /// direct case mapping. `static` so it's unit-testable without
  /// rendering a view.
  static func muiFlag(for flag: CullFlag) -> MuiRatingFlagState {
    switch flag {
    case .none: return .none
    case .pick: return .pick
    case .reject: return .reject
    }
  }

  /// `MuiRatingFlagState` → `CullFlag`, the inverse of `muiFlag(for:)`.
  static func cullFlag(for state: MuiRatingFlagState) -> CullFlag {
    switch state {
    case .none: return .none
    case .pick: return .pick
    case .reject: return .reject
    }
  }
}

// MARK: - Previews

#Preview("RatingFlagsRow — no session (disabled)") {
  RatingFlagsRow(session: nil)
    .padding()
    .background(MapleTokens.bg)
}

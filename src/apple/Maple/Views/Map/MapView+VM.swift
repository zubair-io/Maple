// MapView+VM.swift — pure-function view-model helpers for MapView.
//
// Co-located sibling of MapView.swift. Holds derivations that take typed
// inputs and return typed outputs — no SwiftUI, no @State, no view-builder
// closures. The view file calls these helpers and feeds the returned
// values into its body + tap-callback closures.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI` — a grep gate
// in CI enforces it. MapKit IS imported (for `MKCoordinateRegion`, the type
// a SwiftUI `Map`'s camera-change callback hands back) — that's a data
// type, not a view framework, so it doesn't defeat the testability this
// pattern exists for.

import Foundation
import MapKit
import MapleCore

enum MapViewVM {
  /// Converts MapKit's region type into the framework-free
  /// `MapViewportRegion` `MapViewModel`/`MapViewport` operate on. The
  /// conversion itself lives in MapleCloudKit
  /// (`MapViewportRegion+MapKit.swift`) so tvOS — which cannot link this
  /// target — shares the one implementation instead of forking its own, and
  /// the bbox both platforms ask the server for can't drift apart.
  static func viewportRegion(from region: MKCoordinateRegion) -> MapViewportRegion {
    MapViewportRegion(region)
  }

  /// Empty-state copy — distinct from the error-state copy below. A
  /// legitimately empty region ("no located photos here") vs a fetch
  /// failure both need to tell the user something, but not the same thing.
  static let emptyStateTitle = "No photos with location here"
  static let emptyStateDetail = "Pan or zoom to a different area, or check your active filters."

  static let errorStateTitle = "Couldn't load photo locations"
  static func errorStateDetail(_ error: Error) -> String {
    error.localizedDescription
  }
}

// MapCameraTracker.swift — shared live-camera signal for heatmap overlays (#2869).
//
// Originated on tvOS as `TVMapCameraTracker` (#2834) and generalized here so
// macOS/iOS's heatmap fix (#2869) reuses the exact same type instead of
// forking a near-identical one — this repo treats cross-platform drift as a
// defect, and the invalidation-containment trick below is subtle enough that
// a second, independently-maintained copy is exactly the kind of duplication
// that produces new bugs.
//
// The trick: hold the live camera in a reference type marked `@Observable`
// rather than in `@State` on the screen that owns the `Map`. SwiftUI's
// Observation only invalidates a view that actually READS an `@Observable`
// property during its own body evaluation — so a screen that holds the
// tracker but never reads `.region` is untouched by per-frame camera
// updates, while a small subtree that reads `.region` (the heatmap layer)
// redraws in step with the tiles. Putting the same value in `@State` on the
// screen instead re-evaluates the ENTIRE screen body — including annotation
// content — at the camera's update frequency (effectively 60 FPS during a
// pan/zoom), which is the second half of #2869.
//
// CRITICAL, and the reason the type exists as a separate reference type at
// all rather than just moving `.onMapCameraChange` closer to the heat layer:
// `.onMapCameraChange` only fires when attached to a `Map` or an ANCESTOR of
// one — never a sibling. Every heat layer (`MapHeatmapLayerView` on
// macOS/iOS, `TVMapHeatmapLayerView` on tvOS) sits as a SIBLING of the `Map`
// in a `ZStack`, so the listener cannot move down to the layer itself; it
// has to stay on the ancestor and WRITE into this tracker, which the layer
// then READS. Getting this backwards cost two tvOS review rounds (#2863) —
// see `MapView.swift` / `TVMapScreen.swift` for where each platform attaches
// the listener.
//
// A view that never reads `region` (or `zoomLevel` below) is not invalidated
// by either changing — that's what makes containment work, and also why a
// draw closure must never actually consume `region` for anything other than
// "this input changed, please redraw": the real per-frame math still goes
// through `MapProxy.convert`, which projects against the live camera on its
// own.

import Foundation
import MapKit
import Observation

@Observable
public final class MapCameraTracker {
  public var region: MKCoordinateRegion?

  public init() {}

  /// Same zoom convention `MapViewModel.fetch` uses for the
  /// `/api/map/clusters` `zoom` param, so a heat layer's crossfade lines up
  /// with the data actually on screen. `0` (fully opaque, matching a
  /// whole-world view) before the first camera report — harmless, since the
  /// points being drawn are empty then too.
  public var zoomLevel: Int {
    guard let region else { return 0 }
    return MapViewport.zoomLevel(for: MapViewportRegion(region))
  }
}

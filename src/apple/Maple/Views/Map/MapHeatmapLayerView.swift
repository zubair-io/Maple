// MapHeatmapLayerView.swift — SwiftUI bridge for the heatmap overlay (#2831).
//
// SwiftUI's native `Map` (used by MapView.swift, #2830) has no public API
// to host an arbitrary `MKOverlay`/`MKOverlayRenderer` — confirmed against
// the `_MapKit_SwiftUI` SDK interface, whose `MapContent` conformances are
// limited to Marker/Annotation/MapCircle/MapPolygon/MapPolyline (plus a
// `mapOverlayLevel` z-order modifier for those, not a way to add a raw
// overlay). This view bridges the REAL heatmap drawing core
// (`MapHeatmapPainter`, shared verbatim with `MapHeatmapOverlayRenderer` —
// not reimplemented) onto the SwiftUI Map via `MapReader`'s `MapProxy`
// (the supported way to add custom-drawn content synced to the map's live
// camera — see `MapView.swift`) and a `Canvas`, which exposes the real
// `CGContext` through `GraphicsContext.withCGContext`.
//
// tvOS's future classic-`MKMapView` host (#2834) doesn't need this file —
// it can `mapView.addOverlay(MapHeatmapOverlay.from(cells:))` directly and
// return `MapHeatmapOverlayRenderer` from its delegate.
//
// Reuses `MapViewModel.cells` via the `cells` parameter — no second fetch,
// no parallel data path. Non-interactive: sits above the `Map` in z-order
// but must not steal pin taps.
//
// `region` (#2869) is a per-frame change signal, not drawing input — see
// this struct's doc comment on that property, and `MapHeatmapCameraLayer`
// below for how it's fed from the live camera without invalidating the rest
// of `MapView`.

import SwiftUI
import MapKit
import MapleCore

struct MapHeatmapLayerView: View {
  /// Already-normalized weights straight off `MapViewModel.heatmapPoints`
  /// — deliberately NOT the raw `[MapCluster]`. Normalizing here would run
  /// an O(n) max plus an array allocation inside the draw closure below,
  /// which fires on every camera tick; the VM derives this once per fetch
  /// instead (see `MapViewModel.heatmapPoints`).
  let points: [MapHeatmapPoint]
  let zoomLevel: Int
  /// The live camera. The draw closure never reads it — `proxy.convert`
  /// already projects against the current camera — but it is taken as an
  /// input so SwiftUI has something that actually CHANGES during a pan.
  ///
  /// Without it this view's inputs are effectively constant mid-pan:
  /// `points` only change on a refetch, and `zoomLevel` is a rounded `Int`
  /// that holds steady across a whole pan. SwiftUI would skip re-evaluating
  /// the body, the `Canvas` would never redraw, and the blobs would sit
  /// glued to the screen while the tiles slid underneath — geographically
  /// wrong until the gesture ended, then snapping into place (#2869).
  let region: MKCoordinateRegion?
  let proxy: MapProxy

  var body: some View {
    Canvas { context, _ in
      let opacity = MapHeatmapZoomCrossfade.opacity(forZoomLevel: zoomLevel)
      // Cheap rejects first: past the crossfade, or nothing to draw at all.
      // Both skip the projection pass entirely.
      guard opacity > 0, !points.isEmpty else { return }
      context.withCGContext { cgContext in
        MapHeatmapPainter.draw(blobs: heatmapBlobs(), opacity: opacity, in: cgContext)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// Projects the pre-weighted points into screen space for the CURRENT
  /// camera — the only genuinely per-frame work here, since `proxy.convert`
  /// depends on the live camera and its result changes every tick. Drops
  /// coordinates MapKit can't currently project (effectively off-map)
  /// rather than propagating a `nil`.
  ///
  /// `lazy` so the projected blobs are consumed straight by the painter
  /// without materializing an intermediate array on every draw. There's no
  /// per-tile cull to do here (unlike the `MKOverlayRenderer` path): a
  /// SwiftUI `Canvas` draws the whole layer in one pass, and `proxy.convert`
  /// already returns `nil` for anything off-map.
  private func heatmapBlobs() -> some Sequence<MapHeatmapBlob> {
    points.lazy.compactMap { heatPoint in
      guard let center = proxy.convert(
        CLLocationCoordinate2D(latitude: heatPoint.latitude, longitude: heatPoint.longitude),
        to: .local
      ) else { return nil }
      return MapHeatmapBlob(center: center, radius: MapHeatmapPainter.radius(forWeight: heatPoint.weight), weight: heatPoint.weight)
    }
  }
}

/// The heat layer plus the zoom derivation, isolated so that reading the
/// live camera invalidates only this subtree — mirrors tvOS's
/// `TVMapHeatmapOverlay` (`Maple TV/TVMapHeatmapLayerView.swift`), sharing
/// the same `MapCameraTracker` type (MapleCloudKit) rather than forking a
/// second one (#2869).
///
/// `MapView` holds the tracker but never reads `.region`/`.zoomLevel`
/// itself, so a pan/zoom invalidates only this small subtree instead of the
/// whole screen (including the annotation content) at the camera's update
/// frequency. See `MapCameraTracker`'s doc comment for why the listener that
/// writes into the tracker has to stay on `MapView`'s `Map` — an ancestor —
/// rather than move down here, onto a sibling of the `Map`.
struct MapHeatmapCameraLayer: View {
  let points: [MapHeatmapPoint]
  let tracker: MapCameraTracker
  let proxy: MapProxy

  var body: some View {
    MapHeatmapLayerView(
      points: points, zoomLevel: tracker.zoomLevel, region: tracker.region, proxy: proxy)
  }
}

// MapViewportRegion+MapKit.swift
//
// Bridges MapKit's `MKCoordinateRegion` — the type a SwiftUI `Map`'s
// camera-change callback hands back — into the framework-free
// `MapViewportRegion` that `MapViewport` and `MapViewModel` operate on.
//
// Deliberately a SEPARATE file from `MapViewport.swift`: that file is
// `import Foundation` only, so the region/bbox/zoom math stays unit-testable
// with no MapKit involvement. This file is the one place that knows about
// MapKit's type, and it is shared rather than duplicated per platform —
// macOS/iOS (`MapView+VM.swift`) and tvOS (`TVMapScreen`) both convert the
// live camera the same way, so the bbox a client asks the server for cannot
// drift between platforms.

import Foundation
import MapKit

extension MapViewportRegion {
  /// The viewport MapKit is currently showing.
  public init(_ region: MKCoordinateRegion) {
    self.init(
      centerLatitude: region.center.latitude,
      centerLongitude: region.center.longitude,
      latitudeDelta: region.span.latitudeDelta,
      longitudeDelta: region.span.longitudeDelta)
  }
}

extension MKCoordinateRegion {
  /// The reverse of `MapViewportRegion.init(_:)` above — needed wherever a
  /// framework-free `MapViewportRegion` constant (e.g.
  /// `MapCameraPolicy.initial`, #2912) has to be handed to a SwiftUI `Map`.
  public init(_ region: MapViewportRegion) {
    self.init(
      center: CLLocationCoordinate2D(latitude: region.centerLatitude,
                                     longitude: region.centerLongitude),
      span: MKCoordinateSpan(latitudeDelta: region.latitudeDelta,
                             longitudeDelta: region.longitudeDelta))
  }
}

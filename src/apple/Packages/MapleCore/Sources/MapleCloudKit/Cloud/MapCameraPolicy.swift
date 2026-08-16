// MapCameraPolicy.swift — the #2912 fix: "data must never drive the camera."
//
// Before this ticket, macOS/iOS's `MapView` (`Maple/Views/Map/MapView.swift`,
// #2830) opened with SwiftUI's `.automatic` camera, bound two-way via
// `Map(position:)`. `.automatic` asks MapKit to fit the camera to the
// current annotation content — combined with fetch-on-camera-change
// (`.onMapCameraChange(frequency: .onEnd)` driving
// `MapViewModel.regionChanged`), that closed a feedback loop: a fetch
// changes the annotations → `.automatic` re-frames the camera wider to fit
// them → the wider camera triggers a refetch over a wider bbox → the wider
// bbox returns cells spread over more area → re-frame wider again,
// indefinitely. The user saw the map zoom out in a runaway loop on load.
//
// tvOS's `TVMapScreen` (#2833) never had this bug: its camera is a fixed
// literal handed to `Map(initialPosition:)` once, and MapKit owns it
// exclusively from then on (#2858's invariant, applied here from the
// content side rather than the app-vs-MapKit side).
//
// This type is the fix for macOS/iOS, structured the same way
// `MapAvailability` is (see that file's doc comment): a plain, MapKit/
// SwiftUI-free namespace living in MapleCloudKit so the invariant is
// checkable by a headless `swift test` run, not just by reading
// `MapView.swift`. `MapView` passes `initial` to `Map(initialPosition:)` —
// never to `Map(position:)` — and holds no `@State` that re-derives it from
// `vm.cells` / `MapAnnotationItem` content. There is deliberately no
// function here that accepts cells or annotations; that absence IS the
// fix — a camera-fit-to-content helper cannot silently creep back in
// through this type, because this type has no such input to give one.
public enum MapCameraPolicy {
  /// The map's ONE starting camera. Fixed and framework-free — same
  /// whole-world framing tvOS's `TVMapScreen.initialCameraPosition` opens
  /// with (duplicated rather than shared: that screen is out of scope for
  /// #2912 and lives in a target this package cannot depend on). Never
  /// derived from fetched cells/annotations, and never reassigned after
  /// the map's first camera report — that's what the `.onMapCameraChange`
  /// listeners already own (see `MapView.swift`).
  public static let initial = MapViewportRegion(
    centerLatitude: 20,
    centerLongitude: 0,
    latitudeDelta: 140,
    longitudeDelta: 360)
}

// MapView.swift — native MapKit map view (#2830).
//
// Third browse-mode surface alongside BrowseGrid / CloudTimelineView /
// AllSourcesTimelineView (see LibrarySidebar's Map row + AppShell+Map.swift).
// Fetches `/api/map/clusters` for the visible region + active search
// filter (debounced, generation-guarded — MapViewModel), renders one
// annotation per cell (thumbnail pin for a single photo, count bubble
// otherwise — MapAnnotationItem), and routes a pin/cluster tap to the
// app's search filtered by the cell's place (AppShell+Map.swift's
// `selectMapPlace`).
//
// Wrapped in `MapReader` (#2831) so `MapHeatmapLayerView` can draw the
// heatmap density overlay in sync with the live camera — SwiftUI's `Map`
// has no way to host a real `MKOverlay`/`MKOverlayRenderer` (see that
// file's header comment), and `MapProxy` is the supported alternative.
//
// The live camera feeds the heatmap through `cameraTracker`
// (`MapCameraTracker`, MapleCloudKit — shared with tvOS's identical fix,
// #2869), not `@State` on this view: `MapHeatmapLayerView`'s inputs
// (`points`, `zoomLevel`) are otherwise constant mid-pan (`points` only
// changes on a refetch, `zoomLevel` is a rounded `Int` that holds steady
// across a whole gesture), so without a per-frame signal SwiftUI skips
// re-evaluating the heat layer's body and the blobs sit glued to the screen
// while the tiles slide underneath. Putting that per-frame value in
// `@State` here instead would fix the heatmap but re-evaluate this view's
// entire body — including `annotationContent` for every pin — at the
// camera's update frequency; `@Observable` on `MapCameraTracker` contains
// the invalidation to `MapHeatmapCameraLayer`, the only subtree that reads
// it, because this body never reads `cameraTracker.region`/`.zoomLevel`.

import SwiftUI
import MapKit
import MapleCore

struct MapView: View {
  @Bindable var vm: MapViewModel
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  /// Namespaces the thumbnail cache the same way `fetchCloudThumbBytes`
  /// callers do — `thumbKey` (an `abs_path`) alone isn't unique across
  /// servers.
  let host: String
  /// Pin/cluster tap → AppShell activates search filtered by the
  /// resolved target (a place name, or the has-GPS scope fallback).
  let onSelectPlace: (MapPlaceSearchTarget) -> Void

  /// The map's ONE starting camera, handed to `Map(initialPosition:)` below
  /// and never re-driven — MapKit owns the camera exclusively from the
  /// first frame on (#2912). MUST NOT be `.automatic`, and MUST NOT be
  /// bound two-way via `Map(position:)`: `.automatic` asks MapKit to fit
  /// the camera to `items`/`vm.cells` content, which combined with
  /// fetch-on-camera-change below closed a runaway zoom-out loop (a fetch
  /// changes the annotations, `.automatic` re-frames wider, the wider
  /// camera fetches a wider bbox, forever). See `MapCameraPolicy`'s doc
  /// comment (MapleCloudKit) for the full history and why the fixed value
  /// lives there instead of inline.
  private static let initialCameraPosition: MapCameraPosition =
    .region(MKCoordinateRegion(MapCameraPolicy.initial))
  @State private var selectedAnnotationID: String?
  /// Written by the `.continuous` listener below, read ONLY by
  /// `MapHeatmapCameraLayer`. See this file's header and
  /// `MapCameraTracker`'s doc comment for why `@Observable` (not `@State`
  /// here) is what keeps a pan/zoom from re-evaluating this whole view.
  @State private var cameraTracker = MapCameraTracker()

  private var items: [MapAnnotationItem] {
    MapAnnotationItem.items(from: vm.cells)
  }

  var body: some View {
    MapReader { proxy in
      ZStack {
        Map(initialPosition: Self.initialCameraPosition) {
          ForEach(items) { item in
            Annotation(item.id, coordinate: CLLocationCoordinate2D(latitude: item.latitude, longitude: item.longitude)) {
              annotationContent(for: item)
            }
          }
        }
        .mapStyle(.standard)
        // `.continuous` so `MapViewModel.regionChanged` sees every pan/zoom
        // tick — its own 300ms debounce is what actually bounds the
        // request rate, matching the design doc's "debounced on region
        // change". Also writes `cameraTracker.region`, which keeps the
        // heatmap layer below tracking the live camera rather than only the
        // debounced fetch. This listener has to stay HERE, on the `Map`
        // itself — `.onMapCameraChange` never fires on a sibling, and
        // `MapHeatmapCameraLayer` below is a sibling of the `Map` inside
        // this `ZStack` (see `MapCameraTracker`'s doc comment).
        .onMapCameraChange(frequency: .continuous) { context in
          vm.regionChanged(MapViewVM.viewportRegion(from: context.region))
          cameraTracker.region = context.region
        }
        .accessibilityIdentifier("map-view")

        MapHeatmapCameraLayer(points: vm.heatmapPoints, tracker: cameraTracker, proxy: proxy)

        if vm.isEmpty {
          statePane(icon: "mappin.slash",
                    title: MapViewVM.emptyStateTitle,
                    detail: MapViewVM.emptyStateDetail)
        } else if let error = vm.loadError, vm.cells.isEmpty {
          // Only shown when there's nothing else to render — a failure with
          // prior cells still on screen keeps showing those (MapViewModel
          // never clears `cells` on error) rather than covering the map.
          statePane(icon: "exclamationmark.triangle",
                    title: MapViewVM.errorStateTitle,
                    detail: MapViewVM.errorStateDetail(error))
        }

        if vm.isLoading {
          ProgressView()
            .controlSize(.small)
            .padding(8)
            .background(MapleTokens.surface, in: RoundedRectangle(cornerRadius: 8))
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            .allowsHitTesting(false)
        }
      }
      .background(MapleTokens.bg)
    }
  }

  // MARK: - Annotation content

  @ViewBuilder
  private func annotationContent(for item: MapAnnotationItem) -> some View {
    let isSelected = selectedAnnotationID == item.id
    Button {
      selectedAnnotationID = item.id
      onSelectPlace(item.searchTarget)
    } label: {
      switch item.kind {
      case .thumbnail(let assetID, let thumbKey):
        MapThumbnailPinView(assetID: assetID, thumbKey: thumbKey, host: host,
                            thumbClient: thumbClient, thumbCache: thumbCache,
                            isSelected: isSelected)
      case .cluster(let count):
        MapClusterBubbleView(count: count, isSelected: isSelected)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(annotationAccessibilityLabel(for: item))
  }

  private func annotationAccessibilityLabel(for item: MapAnnotationItem) -> String {
    switch item.kind {
    case .thumbnail:
      return "Open search for this photo's location"
    case .cluster(let count):
      return "Open search for \(count) photos in this area"
    }
  }

  // MARK: - Empty / error state

  private func statePane(icon: String, title: String, detail: String) -> some View {
    VStack(spacing: 12) {
      Image(systemName: icon)
        .font(.system(size: 36))
        .foregroundStyle(MapleTokens.textMuted)
      Text(title)
        .font(MapleTokens.Typography.sheetTitle)
        .foregroundStyle(MapleTokens.textMain)
      Text(detail)
        .font(MapleTokens.Typography.rowLabel)
        .foregroundStyle(MapleTokens.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
    }
    .padding(24)
    .background(MapleTokens.surface, in: RoundedRectangle(cornerRadius: 12))
    // The map itself keeps panning underneath — the state pane is an
    // informational overlay, not a modal (design doc: "the map still
    // pans").
    .allowsHitTesting(false)
  }
}

#Preview("Loaded") {
  MapView(
    vm: MapViewModel.preview(cells: [
      MapCluster(lat: 48.8566, lng: 2.3522, count: 1, representativeAssetId: "a1",
                placeLabel: "Paris", thumbKey: "/photos/eiffel.dng"),
      MapCluster(lat: 35.6762, lng: 139.6503, count: 42, representativeAssetId: "a2",
                placeLabel: "Tokyo"),
    ]),
    thumbClient: CloudThumbClient.preview(),
    thumbCache: CloudThumbCache.preview(),
    host: "preview.maple.invalid",
    onSelectPlace: { _ in }
  )
}

#Preview("Empty") {
  let vm = MapViewModel.preview()
  MapView(
    vm: vm,
    thumbClient: CloudThumbClient.preview(),
    thumbCache: CloudThumbCache.preview(),
    host: "preview.maple.invalid",
    onSelectPlace: { _ in }
  )
}

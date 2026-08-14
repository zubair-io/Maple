// MapViewModel.swift
//
// Drives the native Map view (#2830). Debounces region-change fetches
// against `/api/map/clusters`, stale-guarded with a generation counter
// (docs/best-practices.md §"Generation counters for async state") so a
// slow in-flight response for a since-superseded region can't clobber
// newer cells.
//
// Lives in MapleCloudKit (not MapleCore), matching `SearchViewModel` —
// the tvOS map (#2833) needs the same region → fetch → cells pipeline and
// cannot link MapleCore (which pulls in RawPipeline).

import Foundation
import Observation

@MainActor
@Observable
public final class MapViewModel {
  // MARK: - Published state

  /// The last successfully fetched cells. A fetch failure — or an
  /// in-flight response superseded by a newer region/filter — leaves this
  /// untouched: a tile/data outage keeps showing the last good pins
  /// rather than blanking the map.
  public private(set) var cells: [MapCluster] = []
  public private(set) var isLoading = false
  public private(set) var loadError: Error?
  /// True once a fetch for the current region+filter has completed
  /// successfully with zero cells — the "no located photos in view" empty
  /// state. Distinct from `loadError`: this is a legitimate empty result,
  /// not a failure.
  public private(set) var isEmpty = false

  /// Mutable search filter — the map respects whatever the user has
  /// filtered search to, same contract as `SearchViewModel.params`. Pin
  /// taps read `placeLabel` off the tapped cell, not this.
  public var filter: SearchParams

  // MARK: - Dependencies

  public nonisolated let server: URL
  private let client: MapClustersClient
  private let debounceDelay: Duration

  /// Bumped on every fetch — in-flight completions check this and drop
  /// results from an older generation.
  private var generation: Int = 0
  private var debounceTask: Task<Void, Never>?
  private var lastRegion: MapViewportRegion?

  public init(server: URL,
              client: MapClustersClient,
              filter: SearchParams = SearchParams(),
              debounceDelay: Duration = .milliseconds(300)) {
    self.server = server
    self.client = client
    self.filter = filter
    self.debounceDelay = debounceDelay
  }

  // MARK: - Loaders

  /// Called on every camera/region change. Debounced — only the last
  /// region within `debounceDelay` actually fires a request, matching the
  /// design doc's "debounced on region change".
  public func regionChanged(_ region: MapViewportRegion) {
    lastRegion = region
    debounceTask?.cancel()
    let delay = debounceDelay
    debounceTask = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled else { return }
      await self?.fetch(region: region)
    }
  }

  /// Re-run against the last-known region — used when the active filter
  /// changes without a region change (e.g. the user edits the search
  /// filter while the map view is open). No-op before the first region is
  /// known (the map hasn't reported an initial camera yet).
  public func refresh() async {
    guard let region = lastRegion else { return }
    debounceTask?.cancel()
    await fetch(region: region)
  }

  /// Not `private` so `MapViewModelTests` can drive it directly, bypassing
  /// the debounce, to exercise the generation guard deterministically.
  func fetch(region: MapViewportRegion) async {
    generation &+= 1
    let g = generation
    let bbox = MapViewport.bbox(for: region)
    let zoom = MapViewport.zoomLevel(for: region)
    isLoading = true
    loadError = nil
    defer { if g == generation { isLoading = false } }
    do {
      let response = try await client.clusters(bbox: bbox, zoom: zoom, filter: filter)
      guard g == generation else { return }
      cells = response.cells
      isEmpty = response.cells.isEmpty
    } catch {
      guard g == generation else { return }
      // Keep the last good cells rendered — see `cells`'s doc comment.
      loadError = error
      isEmpty = false
    }
  }

  // MARK: - Preview

  public static func preview(cells: [MapCluster] = []) -> MapViewModel {
    let server = URL(string: "https://preview.maple.invalid")!
    let vm = MapViewModel(server: server, client: MapClustersClient.preview(server: server))
    vm.cells = cells
    vm.isEmpty = cells.isEmpty
    return vm
  }
}

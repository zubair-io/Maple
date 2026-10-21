import MapleCloudKit
import Observation

@MainActor
@Observable
final class WatchPhotoPage {
  enum Source {
    case recent(String)
    case memory(String)
  }
  private let search: CloudSearchClient
  private let memories: GeneratedSearchClient
  private let source: Source
  private var generation = 0
  private let limit = 20
  private(set) var assets: [SearchAsset] = []
  private(set) var page = 0
  private(set) var hasMore = false
  private(set) var loading = false
  private(set) var error: String?

  init(search: CloudSearchClient, memories: GeneratedSearchClient, source: Source) {
    self.search = search
    self.memories = memories
    self.source = source
  }

  /// Replace pages instead of accumulating the entire library in Watch memory.
  func load(page requestedPage: Int) async {
    generation += 1
    let current = generation
    loading = true
    error = nil
    do {
      let result: [SearchAsset]
      let total: Int
      switch source {
      case .recent(let libraryID):
        let params: SearchParams = {
          var value = SearchParams(libraryID: libraryID)
          value.sort = .capturedDesc
          return value
        }()
        let response = try await search.search(
          params, page: requestedPage, limit: limit)
        result = response.results
        total = response.total
      case .memory(let collectionID):
        let response = try await memories.assets(
          collectionID: collectionID, limit: limit, offset: requestedPage * limit)
        result = response.results
        total = response.total
      }
      guard current == generation, !Task.isCancelled else { return }
      assets = result.filter { !$0.isVideo }
      page = requestedPage
      hasMore = (requestedPage + 1) * limit < total
      loading = false
    } catch {
      guard current == generation, !Task.isCancelled else { return }
      self.error = error.localizedDescription
      loading = false
    }
  }
}

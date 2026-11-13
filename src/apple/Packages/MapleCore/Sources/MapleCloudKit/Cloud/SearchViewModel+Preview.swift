// SearchViewModel+Preview.swift
//
// Sample view models for SwiftUI `#Preview` blocks, split out of
// `SearchViewModel.swift` to keep that file inside its line budget.

import Foundation

extension SearchViewModel {
  public enum PreviewState: Sendable {
    case empty
    case loading
    case loaded
  }

  /// Sample VM for SwiftUI `#Preview` blocks. Points at an unreachable
  /// server so any live request fails fast, then stages the requested
  /// case directly.
  public static func preview(_ state: PreviewState = .loaded) -> SearchViewModel {
    let server = URL(string: "https://preview.maple.invalid")!
    let vm = SearchViewModel(
      server: server,
      libraryID: "preview-library",
      searchClient: CloudSearchClient.preview(server: server))
    switch state {
    case .empty:
      break
    case .loading:
      vm._stagePreview(loading: true, results: [])
    case .loaded:
      vm._stagePreview(
        loading: false,
        results: [
          SearchAsset(
            id: "fs:/photos/IMG_0001.dng", folder_id: "lib",
            abs_path: "/photos/IMG_0001.dng", filename: "IMG_0001.dng",
            rating: 4),
          SearchAsset(
            id: "fs:/photos/IMG_0002.dng", folder_id: "lib",
            abs_path: "/photos/IMG_0002.dng", filename: "IMG_0002.dng"),
        ])
    }
    return vm
  }
}

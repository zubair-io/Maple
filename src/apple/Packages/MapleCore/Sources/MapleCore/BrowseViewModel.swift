// BrowseViewModel.swift — observable state for the Browse grid.
//
// Lives in MapleCore per docs/best-practices.md §"Module boundary": no
// business logic in the app target. Observed by SwiftUI through the
// `@Observable` macro; views hold it as `@State` or `@Bindable`.
//
// Folder loads use a generation counter (docs/best-practices.md
// §"Generation counters for async state") so stale writes from a prior
// folder switch cannot overwrite the current UI state.

import Foundation

@MainActor
@Observable
public final class BrowseViewModel {
    public var assets: [AssetRef] = []
    public var selectedID: AssetRef.ID? = nil
    public var sortOrder: SortOrder = .nameAscending
    /// Non-nil while an async `loadFolder` is in flight.
    public var isLoading: Bool = false
    /// Last load error; views can surface a banner when non-nil.
    public var loadError: Error?

    public enum SortOrder: Sendable { case nameAscending, nameDescending, dateDescending }

    /// Monotonically increasing load generation. Each `loadFolder` bumps it;
    /// stale in-flight tasks check the captured generation before mutating
    /// `assets` / `selectedID`.
    @ObservationIgnored private var loadGeneration: UInt64 = 0

    public var selectedAsset: AssetRef? {
        assets.first { $0.id == selectedID }
    }

    public init() {}

    public func selectNext() {
        guard let idx = assets.firstIndex(where: { $0.id == selectedID }), idx + 1 < assets.count
        else { selectedID = assets.first?.id; return }
        selectedID = assets[idx + 1].id
    }

    public func selectPrev() {
        guard let idx = assets.firstIndex(where: { $0.id == selectedID }), idx > 0
        else { selectedID = assets.last?.id; return }
        selectedID = assets[idx - 1].id
    }

    // MARK: - Folder loading

    /// Synchronously list the RAW files in a folder and replace `assets`.
    /// Used when the caller already has main-thread access to the folder
    /// (e.g. the `fileImporter` success case).
    public func loadFolder(url: URL) {
        loadGeneration &+= 1
        let gen = loadGeneration

        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            loadError = CocoaError(.fileReadUnknown)
            return
        }
        guard gen == loadGeneration else { return }

        let raws = contents
            .filter { RAWExtensions.all.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { AssetRef(url: $0) }

        guard gen == loadGeneration else { return }
        assets = raws
        selectedID = raws.first?.id
        loadError = nil
    }

    /// Async variant that delegates directory enumeration to a `FilesystemSource`
    /// actor. Each `await` is followed by a generation check so that a folder
    /// switch mid-load cannot overwrite the newer selection.
    public func loadFolder(_ folderURL: URL, via source: FilesystemSource) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        defer {
            if gen == loadGeneration { isLoading = false }
        }

        do {
            try await source.open(folderURL: folderURL)
            guard gen == loadGeneration else { return }   // user switched folders

            let fileAssets = await source.assets
            guard gen == loadGeneration else { return }

            let refs = fileAssets.map { AssetRef(url: $0.url) }
            guard gen == loadGeneration else { return }

            assets = refs
            selectedID = refs.first?.id
            loadError = nil
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }
}

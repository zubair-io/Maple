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
    /// The source feeding the grid. Nil until the user picks one.
    /// `@ObservationIgnored` — callers interested in changes should observe
    /// `assets` / `selectedID` which change together with the source.
    @ObservationIgnored public private(set) var currentSource: (any ImageSource)?

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
            currentSource = source
            loadError = nil
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }

    /// Source-agnostic loader. Works for any `ImageSource` implementation
    /// (Filesystem, PhotoKit, SMB, SelfHosted). `ImageRef.url` maps to an
    /// `AssetRef` when the source is file-shaped; sources without a URL
    /// (PhotoKit, SelfHosted) get a synthetic placeholder URL built from
    /// the stable ref id. The `EditSession` layer is already URL-keyed —
    /// the synthetic URLs keep that contract intact until a proper
    /// ref-based `AssetRef` lands.
    public func loadSource(_ source: any ImageSource) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        defer {
            if gen == loadGeneration { isLoading = false }
        }

        do {
            let refs = try await source.images()
            guard gen == loadGeneration else { return }

            let assetRefs = refs.map { ref -> AssetRef in
                if let url = ref.url {
                    return AssetRef(url: url)
                }
                // Synthesise a stable placeholder URL from the ref id so the
                // grid has something to key off. EditSession won't be able to
                // pipe this through `PipelineRenderer.render(rawPath:)`
                // directly — TODO(UI-sourceless-assets): thread `rawBytes`
                // through ImageEditPipeline so sources without a URL (PhotoKit,
                // SelfHosted) can render without being staged to disk.
                return AssetRef(url: URL(string: "maple-source://\(ref.id)") ?? URL(fileURLWithPath: "/"))
            }
            guard gen == loadGeneration else { return }

            assets = assetRefs
            selectedID = assetRefs.first?.id
            currentSource = source
            loadError = nil
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }
}

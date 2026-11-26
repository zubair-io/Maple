// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderExtensionCore+Thumbnails.swift
import FileProvider

/// Files and Finder show an item's icon from here, so a photo that has not
/// been downloaded shows its picture instead of a generic icon (#5503).
/// Indexed photos get the server's pre-built 512 px thumbnail; every other
/// item gets none, and the system draws its usual icon.
extension FileProviderExtensionCore: NSFileProviderThumbnailing {
    public func fetchThumbnails(for itemIdentifiers: [NSFileProviderItemIdentifier],
                                requestedSize size: CGSize,
                                perThumbnailCompletionHandler: @escaping (NSFileProviderItemIdentifier, Data?, Error?) -> Void,
                                completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: Int64(itemIdentifiers.count))
        guard !dormant, let catalog else {
            completionHandler(nil)
            return progress
        }
        let task = Task {
            await withTaskGroup(of: Void.self) { group in
                for (index, identifier) in itemIdentifiers.enumerated() {
                    if index >= Self.concurrentThumbnailFetches, await group.next() != nil {
                        progress.completedUnitCount += 1
                    }
                    guard !Task.isCancelled else { break }
                    group.addTask {
                        let (data, error) = await Self.thumbnail(for: identifier, catalog: catalog)
                        perThumbnailCompletionHandler(identifier, data, error)
                    }
                }
                for await _ in group { progress.completedUnitCount += 1 }
            }
            completionHandler(Task.isCancelled ? Self.userCancelledError() : nil)
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    /// A Finder window asks for a screenful at once; one download at a time
    /// left each icon waiting on every round trip before it. Icons share the
    /// downloads' session, which opens four connections per host on iOS, so
    /// one stays free for a file the user opens meanwhile.
    static let concurrentThumbnailFetches = 3

    /// Streams the thumbnail to a temporary file first, so the ETag cache
    /// never holds image bytes.
    static func thumbnail(for identifier: NSFileProviderItemIdentifier,
                          catalog: RemoteCatalog) async -> (Data?, Error?) {
        guard case .asset(let assetID)? = try? FileProviderIdentifier(rawValue: identifier.rawValue) else {
            return (nil, nil)
        }
        let localURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".avif")
        defer { try? FileManager.default.removeItem(at: localURL) }
        do {
            try await catalog.downloadThumb(assetID: assetID, to: localURL)
            return (try Data(contentsOf: localURL), nil)
        } catch {
            return (nil, error)
        }
    }
}

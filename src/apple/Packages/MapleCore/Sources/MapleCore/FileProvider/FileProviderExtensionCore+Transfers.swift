// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderExtensionCore+Transfers.swift
//
// Memory discipline for the File Provider extension (#5456). iOS kills the
// extension at a hard 20 MB footprint; a Files-app drop of ~1,000 RAWs and
// videos used to start one upload per `createItem` at once and the kernel
// killed the process 65 times in two minutes. Everything that moves bytes
// now waits for a permit first, so queued work holds a continuation and
// nothing else. The budget is documented in docs/apple.md § "File Provider
// memory budget".

import FileProvider
import OSLog

extension FileProviderExtensionCore {
    /// File uploads (`createItem` and content-changing `modifyItem`) in
    /// flight at once. Folder creates, renames, moves and XMP writes are
    /// small requests and run directly, so they never queue behind a bulk
    /// drop.
    public static let writeConcurrency = 3
    /// Content downloads (`fetchContents`) in flight at once.
    public static let fetchConcurrency = 3

    /// Fields the server stores. Every other `NSFileProviderItemFields`
    /// change is local metadata the extension echoes back.
    static let serverTrackedFields: NSFileProviderItemFields = [
        .contents, .filename, .parentItemIdentifier,
    ]

    /// One ephemeral session for every request the extension makes: no
    /// URL cache, cookie or credential storage held in memory. The
    /// per-host connection cap leaves room for every bounded transfer plus
    /// the small listing and metadata requests beside them, because a
    /// request queued inside the session's own pool runs its timeout down
    /// before it ever starts.
    static func makeURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpMaximumConnectionsPerHost = writeConcurrency + fetchConcurrency + 2
        return URLSession(configuration: configuration)
    }

    static func userCancelledError() -> NSError {
        NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)
    }

    /// Runs `work` on a new task once `permits` grants a slot. Cancelling
    /// `progress` while the work is still queued drops it and calls
    /// `cancelled`; once it runs, cancellation reaches its URLSession calls.
    func startBounded(by permits: BoundedAsyncSemaphore,
                      progress: Progress,
                      cancelled: @escaping () -> Void,
                      work: @escaping () async -> Void) {
        let task = Task {
            do {
                try await permits.acquire()
            } catch {
                progress.completedUnitCount = progress.totalUnitCount
                cancelled()
                return
            }
            await work()
            await permits.release()
        }
        progress.cancellationHandler = { task.cancel() }
    }

    /// The item already stored at the upload's target, when this
    /// `createItem` is a redelivery of an upload that landed — nil means
    /// upload. Only `.mayAlreadyExist` qualifies: the OS says the item may
    /// already be synced, and an entry with the same name and size is it
    /// (#2538). Any other create uploads, even over a same-name, same-size,
    /// same-mtime file: the server keeps no content hash, so that file
    /// could hold different bytes, and the upload moves it to the Maple
    /// trash rather than losing it. A local file whose size can't be read
    /// never matches.
    static func existingUpload(catalog: RemoteCatalog,
                               rootCache: LibraryRootCache?,
                               options: NSFileProviderCreateItemOptions,
                               localURL: URL,
                               folderID: String,
                               parentRelativePath: String,
                               targetRelativePath: String,
                               filename: String,
                               parentIdentifier: NSFileProviderItemIdentifier,
                               log: Logger) async throws -> MapleItem? {
        guard options.contains(.mayAlreadyExist),
              let localSize = (try? FileManager.default.attributesOfItem(atPath: localURL.path))?[.size]
                .flatMap({ ($0 as? NSNumber)?.int64Value }) else { return nil }
        guard let parentAbs = await resolveAbsolutePath(folderID: folderID,
                                                        relativePath: parentRelativePath,
                                                        rootCache: rootCache) else { return nil }
        return try await matchExistingUpload(catalog: catalog, parentAbsolutePath: parentAbs,
                                             filename: filename, localSize: localSize,
                                             folderID: folderID, targetRelativePath: targetRelativePath,
                                             parentIdentifier: parentIdentifier, log: log)
    }

    /// New bytes for a non-indexed file edited in place. The server's
    /// upload moves the previous copy to the Maple trash before publishing
    /// the new one, so the old bytes stay recoverable.
    func replaceFileContents(of item: NSFileProviderItem,
                             folderID: String,
                             relativePath: String,
                             contents: URL,
                             catalog: RemoteCatalog,
                             completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        startBounded(by: writePermits, progress: progress,
                     cancelled: { completionHandler(nil, [], false, Self.userCancelledError()) }) {
            defer { progress.completedUnitCount = 1 }
            do {
                self.log.notice("file contents replace folderID=\(folderID, privacy: .public) path=\(relativePath, privacy: .private)")
                let outcome = try await catalog.uploadFile(folderID: folderID,
                                                           targetRelativePath: relativePath,
                                                           fileURL: contents,
                                                           mtime: item.contentModificationDate ?? nil)
                switch outcome {
                case .ok(let resp):
                    let name = (relativePath as NSString).lastPathComponent
                    let file = FileChild(name: name, path: resp.absPath, mtime: resp.mtime,
                                         size: resp.size, ext: (name as NSString).pathExtension.lowercased())
                    completionHandler(MapleItem(file: file, folderID: folderID, relativePath: relativePath,
                                                parentIdentifier: item.parentItemIdentifier), [], false, nil)
                    await self.signalEnumeratorReload(parent: item.parentItemIdentifier)
                case .unsupported:
                    completionHandler(nil, [], false,
                                      NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError))
                }
            } catch {
                self.log.error("file contents replace failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }
}

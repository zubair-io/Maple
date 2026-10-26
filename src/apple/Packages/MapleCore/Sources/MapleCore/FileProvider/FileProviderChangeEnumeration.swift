// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderChangeEnumeration.swift
import FileProvider

/// Shared limits for `enumerateChanges` across the working-set and folder
/// enumerators (#5456). Each call pages the global change feed and builds
/// an item per row plus derived entries, and after an extension relaunch
/// every observed container asks at once; this keeps at most two of those
/// pages in memory.
enum FileProviderChangeEnumeration {
    static let permits = BoundedAsyncSemaphore(value: 2)

    #if os(iOS)
    static let pageLimit = 200
    #else
    static let pageLimit = 500
    #endif

    /// Holds a permit for the calling task until `release()`. Returns
    /// false, after failing `observer`, when the task was cancelled while
    /// waiting.
    static func acquire(for observer: NSFileProviderChangeObserver) async -> Bool {
        do {
            try await permits.acquire()
            return true
        } catch {
            observer.finishEnumeratingWithError(
                NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
            return false
        }
    }

    static func release() {
        Task { await permits.release() }
    }
}

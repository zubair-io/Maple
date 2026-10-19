import Foundation

/// The right to run a backup engine against the shared state database
/// (#4988). The app and the macOS backup helper resolve the same
/// `BackupStorage` root, and each rehydrates every pending and in-flight
/// row on start; two engines at once would upload the same asset twice and
/// overwrite each other's states. An exclusive `flock` on a file in that
/// root serialises them across processes. The kernel drops the lock when
/// the holding process exits or crashes, so a dead host never strands it.
public final class BackupEngineLock: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit { release() }

    public static func lockURL(in root: URL) -> URL {
        root.appendingPathComponent("backup-engine.lock")
    }

    /// The lock, or `nil` when another host is already running an engine.
    public static func acquire(in root: URL) -> BackupEngineLock? {
        let fd = open(lockURL(in: root).path, O_CREAT | O_RDWR | O_CLOEXEC, 0o644)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return nil
        }
        return BackupEngineLock(descriptor: fd)
    }

    /// Waits until the other host lets go, so whichever host loses the race
    /// takes over when the winner finishes instead of staying idle until a
    /// manual restart. Cancelling the wait stops it without holding the lock.
    public static func acquireWhenFree(in root: URL, pollInterval: Duration) async throws -> BackupEngineLock {
        while true {
            try Task.checkCancellation()
            if let lock = acquire(in: root) { return lock }
            try await Task.sleep(for: pollInterval)
        }
    }

    /// Hands the engine slot back on a clean stop. Idempotent.
    public func release() {
        lock.lock()
        defer { lock.unlock() }
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
        descriptor = -1
    }
}

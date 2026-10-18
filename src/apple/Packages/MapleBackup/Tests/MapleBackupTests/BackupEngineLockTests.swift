// Tests/MapleBackupTests/BackupEngineLockTests.swift
//
// #4988: the app and the backup helper share one state database, so only
// one of them may run an engine at a time. Real lock files in a temp dir;
// the cross-process cases use a separate process as the second host.
import XCTest
@testable import MapleBackup

final class BackupEngineLockTests: XCTestCase {
    private func makeRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-lock-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    /// A second host holding the lock: a separate process that takes the
    /// same `flock`, prints "held", then waits until killed. Its output is
    /// captured, never inherited.
    private func startHolder(at root: URL) throws -> Process {
        let lockPath = BackupEngineLock.lockURL(in: root).path
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [
            "-c",
            """
            import fcntl, os, sys, time
            fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(fd, fcntl.LOCK_EX)
            print("held", flush=True)
            time.sleep(60)
            """,
            lockPath,
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        let line = output.fileHandleForReading.availableData
        XCTAssertEqual(String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines), "held")
        return process
    }

    func testOnlyOneHostAcquiresTheLock() throws {
        let root = try makeRoot()
        let first = try XCTUnwrap(BackupEngineLock.acquire(in: root))
        XCTAssertNil(BackupEngineLock.acquire(in: root), "a second engine started on the shared state DB")
        first.release()
        XCTAssertNotNil(BackupEngineLock.acquire(in: root), "a clean stop must free the lock")
    }

    func testDroppingTheHolderReleasesTheLock() throws {
        let root = try makeRoot()
        var first: BackupEngineLock? = try XCTUnwrap(BackupEngineLock.acquire(in: root))
        XCTAssertNotNil(first)
        first = nil
        XCTAssertNotNil(BackupEngineLock.acquire(in: root))
    }

    func testAnotherProcessHoldingTheLockBlocksThisHost() throws {
        let root = try makeRoot()
        let holder = try startHolder(at: root)
        defer { if holder.isRunning { holder.terminate() } }

        XCTAssertNil(BackupEngineLock.acquire(in: root))
    }

    func testACrashedHolderFreesTheLock() throws {
        let root = try makeRoot()
        let holder = try startHolder(at: root)
        XCTAssertNil(BackupEngineLock.acquire(in: root))

        kill(holder.processIdentifier, SIGKILL)
        holder.waitUntilExit()

        XCTAssertNotNil(BackupEngineLock.acquire(in: root), "the kernel frees a dead host's lock")
    }
}

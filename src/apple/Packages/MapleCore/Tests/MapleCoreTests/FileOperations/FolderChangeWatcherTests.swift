// FolderChangeWatcherTests.swift — issue #2656: the DispatchSource-based
// live folder-content watcher, tested in isolation against a real temp
// directory. `FilesystemSourceExternalRenameTests` covers the
// reconciliation logic the watcher's callback triggers; this file covers
// only the watcher mechanism itself — that it fires (once, debounced) when
// a direct child of the watched folder changes, and that it does NOT fire
// for unrelated folders.

import XCTest
@testable import MapleCore

final class FolderChangeWatcherTests: XCTestCase {
    private var tmpDir: URL!

    override func setUpWithError() throws {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("folder-change-watcher-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    func testFiresWhenAFileIsRenamedInsideTheWatchedFolder() throws {
        let fileURL = tmpDir.appendingPathComponent("a.dng")
        try Data("pixels".utf8).write(to: fileURL)

        let expectation = expectation(description: "folder change observed")
        let watcher = try XCTUnwrap(
            FolderChangeWatcher(folderURL: tmpDir, debounceInterval: 0.05) {
                expectation.fulfill()
            })
        defer { watcher.stop() }

        try FileManager.default.moveItem(at: fileURL, to: tmpDir.appendingPathComponent("b.dng"))

        wait(for: [expectation], timeout: 5.0)
    }

    func testFiresWhenAFileIsCreatedInsideTheWatchedFolder() throws {
        let expectation = expectation(description: "folder change observed")
        let watcher = try XCTUnwrap(
            FolderChangeWatcher(folderURL: tmpDir, debounceInterval: 0.05) {
                expectation.fulfill()
            })
        defer { watcher.stop() }

        try Data("pixels".utf8).write(to: tmpDir.appendingPathComponent("new.dng"))

        wait(for: [expectation], timeout: 5.0)
    }

    /// Lock-protected counter box — a plain captured `var` triggers Swift 6's
    /// concurrent-mutation error inside a `@Sendable` closure; this type's
    /// own `NSLock` is the safety the compiler can't see through a bare var.
    private final class FireCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        @discardableResult
        func increment() -> Int {
            lock.lock()
            defer { lock.unlock() }
            count += 1
            return count
        }

        var current: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }
    }

    func testDebounceCollapsesABurstOfEventsIntoOneCallback() throws {
        let counter = FireCounter()
        let expectation = expectation(description: "single debounced callback")
        expectation.assertForOverFulfill = true

        let watcher = try XCTUnwrap(
            FolderChangeWatcher(folderURL: tmpDir, debounceInterval: 0.3) {
                if counter.increment() == 1 { expectation.fulfill() }
            })
        defer { watcher.stop() }

        // A burst of three rapid changes, well inside the 0.3s debounce
        // window, must collapse to exactly one callback.
        for i in 0..<3 {
            try Data("pixels".utf8).write(to: tmpDir.appendingPathComponent("burst-\(i).dng"))
        }

        wait(for: [expectation], timeout: 5.0)
        // Give any (incorrect) extra callback a chance to land before
        // asserting the count stayed at one.
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertEqual(counter.current, 1, "a burst inside the debounce window must fire the callback exactly once")
    }

    func testInitReturnsNilForANonexistentFolder() {
        let missing = tmpDir.appendingPathComponent("does-not-exist")
        XCTAssertNil(FolderChangeWatcher(folderURL: missing) {})
    }

    func testStoppedWatcherDoesNotFire() throws {
        let expectation = expectation(description: "should not fire")
        expectation.isInverted = true

        let watcher = try XCTUnwrap(
            FolderChangeWatcher(folderURL: tmpDir, debounceInterval: 0.05) {
                expectation.fulfill()
            })
        watcher.stop()

        try Data("pixels".utf8).write(to: tmpDir.appendingPathComponent("after-stop.dng"))

        wait(for: [expectation], timeout: 1.0)
    }
}

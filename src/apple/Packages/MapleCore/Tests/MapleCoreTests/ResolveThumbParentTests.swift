// ResolveThumbParentTests.swift
//
// PR #105 review fix #1.
//
// Covers `FileProviderExtensionCore.resolveThumbParent(meta:rootCache:)`:
// the helper that derives the `.maple/thumbs/` parent identifier for a
// thumb item from its underlying asset's metadata.
//
// The earlier shape inside `item(for: .thumb)` did
// `try? await rootCache.roots() ?? []`, which silently degraded a
// network failure (or any roots() throw) into "no matching root" and
// attached the thumb to a thumbs container at the library root —
// displacing it from its real parent folder. The helper now throws on
// every failure mode so the OS retries instead of getting a
// wrongly-parented item.

import XCTest
import FileProvider
@testable import MapleCore

final class ResolveThumbParentTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "test-\(UUID().uuidString)")!
    }

    private func makeMeta(folderID: String = "f1",
                          absPath: String = "/srv/photos/Library/2026/Adam/IMG.dng",
                          filename: String = "IMG.dng") -> AssetMetadata {
        AssetMetadata(id: "asset-1",
                      folderID: folderID,
                      filename: filename,
                      absPath: absPath,
                      size: 1,
                      mtimeMS: 0,
                      rating: 0)
    }

    /// Fetcher throws → helper must propagate, NOT silently fall back to
    /// a bad parent. This is the heart of fix #1: the earlier
    /// `try? rootCache.roots() ?? []` shape ate the error here. The
    /// asset's real folder lives several directories deep
    /// (`2026/Adam`), so the silent-swallow regression would have
    /// attached the thumb to the library-root thumbs container
    /// (`parentRelativePath: ""`) — the wrong parent.
    func testFetcherThrowsPropagates() async {
        struct StubError: Error {}
        let cache = LibraryRootCache(domainID: "d",
                                     defaults: freshDefaults(),
                                     fetcher: { throw StubError() })
        do {
            let parent = try await FileProviderExtensionCore.resolveThumbParent(
                meta: makeMeta(folderID: "f1",
                                absPath: "/srv/photos/Library/2026/Adam/IMG.dng"),
                rootCache: cache
            )
            // If we reach here, the OLD silent-swallow shape ran:
            // attach `XCTFail` evidence so the failure message names
            // the bug, not just "no throw".
            let parsed = try? FileProviderIdentifier(rawValue: parent.rawValue)
            XCTFail("expected throw — got \(String(describing: parsed)); the OLD `try? roots() ?? []` shape would surface .mapleThumbsDir(\"f1\", \"\") here")
        } catch is StubError {
            // expected — fetcher error propagated to caller.
        } catch {
            XCTFail("expected StubError, got \(error)")
        }
    }

    /// roots() succeeds but folderID isn't present — legitimate
    /// "no matching root": throw noSuchItem so the OS knows the thumb
    /// can't be resolved.
    func testNoMatchingRootThrowsNoSuchItem() async {
        let roots = [LibraryRoot(id: "other", path: "/srv/photos/Other",
                                  label: "Other", fileCount: 0)]
        let cache = LibraryRootCache(domainID: "d",
                                     defaults: freshDefaults(),
                                     fetcher: { roots })
        do {
            _ = try await FileProviderExtensionCore.resolveThumbParent(
                meta: makeMeta(folderID: "f1"),
                rootCache: cache
            )
            XCTFail("expected throw")
        } catch let error as NSError {
            XCTAssertEqual(error.domain, NSFileProviderErrorDomain)
            XCTAssertEqual(error.code, NSFileProviderError.noSuchItem.rawValue)
        }
    }

    /// `absPath` doesn't fall under the resolved root — server bug or
    /// out-of-tree asset. There's no valid parent identifier we can
    /// build, so noSuchItem is the right surface.
    func testAbsPathOffTreeThrowsNoSuchItem() async {
        let roots = [LibraryRoot(id: "f1", path: "/srv/photos/Library",
                                  label: "Lib", fileCount: 0)]
        let cache = LibraryRootCache(domainID: "d",
                                     defaults: freshDefaults(),
                                     fetcher: { roots })
        do {
            _ = try await FileProviderExtensionCore.resolveThumbParent(
                meta: makeMeta(folderID: "f1",
                                absPath: "/somewhere/else/IMG.dng"),
                rootCache: cache
            )
            XCTFail("expected throw")
        } catch let error as NSError {
            XCTAssertEqual(error.domain, NSFileProviderErrorDomain)
            XCTAssertEqual(error.code, NSFileProviderError.noSuchItem.rawValue)
        }
    }

    /// nil rootCache (dormant extension) → noSuchItem rather than crash.
    func testNilRootCacheThrowsNoSuchItem() async {
        do {
            _ = try await FileProviderExtensionCore.resolveThumbParent(
                meta: makeMeta(),
                rootCache: nil
            )
            XCTFail("expected throw")
        } catch let error as NSError {
            XCTAssertEqual(error.domain, NSFileProviderErrorDomain)
            XCTAssertEqual(error.code, NSFileProviderError.noSuchItem.rawValue)
        }
    }

    /// Happy path: roots resolves, absPath falls under the root, the
    /// returned identifier round-trips to
    /// `.mapleThumbsDir(folderID:, parentRelativePath:)` with the
    /// asset's parent directory stripped of the filename. Crucially,
    /// the parent is NOT `.workingSet` — that's the bug we're guarding
    /// against.
    func testHappyPathReturnsMapleThumbsDir() async throws {
        let roots = [LibraryRoot(id: "f1", path: "/srv/photos/Library",
                                  label: "Lib", fileCount: 0)]
        let cache = LibraryRootCache(domainID: "d",
                                     defaults: freshDefaults(),
                                     fetcher: { roots })
        let parent = try await FileProviderExtensionCore.resolveThumbParent(
            meta: makeMeta(folderID: "f1",
                            absPath: "/srv/photos/Library/2026/Adam/IMG.dng"),
            rootCache: cache
        )
        XCTAssertNotEqual(parent, .workingSet)
        let parsed = try FileProviderIdentifier(rawValue: parent.rawValue)
        XCTAssertEqual(parsed,
                       .mapleThumbsDir(folderID: "f1",
                                        parentRelativePath: "2026/Adam"))
    }

    /// Asset at the library root (no intermediate folders): parent
    /// relative path is the empty string. Still a non-`.workingSet`
    /// `.mapleThumbsDir`, not a synthesised default.
    func testHappyPathAtLibraryRootEmptyRelative() async throws {
        let roots = [LibraryRoot(id: "f1", path: "/srv/photos/Library",
                                  label: "Lib", fileCount: 0)]
        let cache = LibraryRootCache(domainID: "d",
                                     defaults: freshDefaults(),
                                     fetcher: { roots })
        let parent = try await FileProviderExtensionCore.resolveThumbParent(
            meta: makeMeta(folderID: "f1",
                            absPath: "/srv/photos/Library/IMG.dng"),
            rootCache: cache
        )
        XCTAssertNotEqual(parent, .workingSet)
        let parsed = try FileProviderIdentifier(rawValue: parent.rawValue)
        XCTAssertEqual(parsed,
                       .mapleThumbsDir(folderID: "f1",
                                        parentRelativePath: ""))
    }
}

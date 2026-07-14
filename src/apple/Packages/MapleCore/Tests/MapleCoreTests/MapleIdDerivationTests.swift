// MapleIdDerivationTests.swift — orchestration tests for
// MapleIdDerivation.derive (#1995): primary-vs-fallback dispatch and the
// chunked-reader contract shared by FilesystemSource and SMBSource.

import XCTest
@testable import MapleCore

final class MapleIdDerivationTests: XCTestCase {

    private func pseudoRandomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        for i in 0..<count {
            let x = UInt64(i) &* 2_654_435_761 &+ 0x9E37_79B9
            bytes[i] = UInt8((x >> 24) & 0xff)
        }
        return Data(bytes)
    }

    // MARK: - Primary form

    func testPrefersDateTimeOriginalWhenBothPresent() async {
        let head = pseudoRandomBytes(1024)
        let id = await MapleIdDerivation.derive(
            headBytes: head,
            exifDateTimeOriginal: "2024:06:01 12:34:56",
            exifCreateDate: "1999:01:01 00:00:00",
            filesize: UInt64(head.count),
            nextChunk: { Data() }
        )
        let expected = MapleId.primary(headBytes: head, capturedAtISO8601: "2024-06-01T12:34:56.000Z")
        XCTAssertEqual(id, expected)
        XCTAssertEqual(id?.prefix(2), "01")
    }

    func testFallsBackToCreateDateWhenDateTimeOriginalAbsent() async {
        let head = pseudoRandomBytes(1024)
        let id = await MapleIdDerivation.derive(
            headBytes: head,
            exifDateTimeOriginal: nil,
            exifCreateDate: "2024:06:01 12:34:56",
            filesize: UInt64(head.count),
            nextChunk: { Data() }
        )
        let expected = MapleId.primary(headBytes: head, capturedAtISO8601: "2024-06-01T12:34:56.000Z")
        XCTAssertEqual(id, expected)
    }

    func testFallsBackToCreateDateWhenDateTimeOriginalUnparseable() async {
        let head = pseudoRandomBytes(1024)
        let id = await MapleIdDerivation.derive(
            headBytes: head,
            exifDateTimeOriginal: "not a date",
            exifCreateDate: "2024:06:01 12:34:56",
            filesize: UInt64(head.count),
            nextChunk: { Data() }
        )
        let expected = MapleId.primary(headBytes: head, capturedAtISO8601: "2024-06-01T12:34:56.000Z")
        XCTAssertEqual(id, expected)
    }

    // MARK: - Fallback form

    /// Documents the exact contract `FilesystemSource`/`SMBSource` rely on:
    /// `nextChunk` must yield the file's bytes FROM BYTE 0 (head bytes
    /// included), not just "everything after the head" — `derive` does not
    /// re-inject `headBytes` into the fallback path itself. Both real
    /// callers rewind (`FileHandle.seek(toOffset: 0)`) or open a fresh
    /// full-range stream before starting `nextChunk`, precisely so this
    /// holds.
    func testFallbackStreamMustIncludeHeadBytes() async {
        let head = pseudoRandomBytes(1024)
        let rest = pseudoRandomBytes(4096)
        let whole = head + rest
        var chunks = [whole]

        let id = await MapleIdDerivation.derive(
            headBytes: head,
            exifDateTimeOriginal: nil,
            exifCreateDate: nil,
            filesize: UInt64(whole.count),
            nextChunk: {
                guard !chunks.isEmpty else { return Data() }
                return chunks.removeFirst()
            }
        )

        let expected = MapleId.fallback(bytes: whole)
        XCTAssertEqual(id, expected)
        XCTAssertEqual(id?.prefix(2), "02")
    }

    func testFallbackFormWithManySmallChunks() async {
        let whole = pseudoRandomBytes(10_000)
        var offset = 0
        let chunkSize = 777

        let id = await MapleIdDerivation.derive(
            headBytes: whole.prefix(64 * 1024),
            exifDateTimeOriginal: nil,
            exifCreateDate: nil,
            filesize: UInt64(whole.count),
            nextChunk: {
                guard offset < whole.count else { return Data() }
                let end = min(offset + chunkSize, whole.count)
                let chunk = whole.subdata(in: offset..<end)
                offset = end
                return chunk
            }
        )

        XCTAssertEqual(id, MapleId.fallback(bytes: whole))
    }

    func testFallbackFormWhenPrimaryFormFailsDespiteTimestamp() async {
        // Empty head bytes -> MapleId.primary returns nil even with a valid
        // timestamp (its own empty-head guard) -> derive must fall through
        // to fallback form rather than returning nil outright.
        let whole = pseudoRandomBytes(2048)
        var chunks = [whole]

        let id = await MapleIdDerivation.derive(
            headBytes: Data(),
            exifDateTimeOriginal: "2024:06:01 12:34:56",
            exifCreateDate: nil,
            filesize: UInt64(whole.count),
            nextChunk: {
                guard !chunks.isEmpty else { return Data() }
                return chunks.removeFirst()
            }
        )
        XCTAssertEqual(id, MapleId.fallback(bytes: whole))
    }

    /// [Caught in review on #2003] `derive`'s fallback loop terminates on
    /// `chunk.isEmpty`, which is indistinguishable from a genuinely thrown
    /// error unless `nextChunk` itself propagates the throw rather than
    /// swallowing it into an empty `Data()`. This is the exact contract
    /// `FilesystemSource.deriveMapleId`'s `nextChunk` closure was fixed to
    /// honor (it previously used `try?` internally, converting a transient
    /// `FileHandle.read` error into "EOF", silently hashing only a prefix
    /// of the file into a wrong id) — `SMBSource.deriveMapleId` already did
    /// this correctly. `derive` itself is `async rethrows` specifically to
    /// support this; this test locks in that the mechanism actually works.
    struct TestReadError: Error {}

    func testNextChunkErrorPropagatesRatherThanBeingTreatedAsEOF() async {
        let head = pseudoRandomBytes(64)
        var callCount = 0
        do {
            _ = try await MapleIdDerivation.derive(
                headBytes: head,
                exifDateTimeOriginal: nil,
                exifCreateDate: nil,
                filesize: 4096,
                nextChunk: {
                    callCount += 1
                    if callCount == 1 { return head }
                    throw TestReadError()
                }
            )
            XCTFail("expected derive to rethrow the nextChunk error, not swallow it as EOF")
        } catch is TestReadError {
            // Expected — the error reached the caller instead of being
            // silently treated as end-of-stream.
        } catch {
            XCTFail("expected TestReadError, got \(error)")
        }
    }

    /// Locks in `derive`'s documented contract (corrected in review on
    /// #2003): a genuinely empty file — no EXIF, empty head bytes, zero
    /// fallback chunks — still produces a REAL fallback-form id, not `nil`.
    /// `FallbackFormHasher.finalize` only returns `nil` on an FFI/
    /// allocation failure, so hashing zero content bytes is a legitimate,
    /// deterministic outcome, not a derivation failure. Compared against
    /// `FallbackFormHasher` directly (`HashingTests.
    /// testFallbackFormHasherHandlesEmptyInput`'s own reference), NOT
    /// `MapleId.fallback(bytes:)` — that one-shot API deliberately guards
    /// empty input to `nil` by its own contract (a defensive check against
    /// a zero-length raw pointer at the FFI boundary), which is a different
    /// property from the streaming hasher `derive` actually calls.
    func testEmptyFileProducesValidFallbackIdNotNil() async {
        let id = await MapleIdDerivation.derive(
            headBytes: Data(),
            exifDateTimeOriginal: nil,
            exifCreateDate: nil,
            filesize: 0,
            nextChunk: { Data() }
        )
        XCTAssertNotNil(id)
        XCTAssertEqual(id, FallbackFormHasher().finalize(filesize: 0))
    }

    // MARK: - Determinism

    func testDeterministicAcrossRepeatedCalls() async {
        let head = pseudoRandomBytes(512)
        let a = await MapleIdDerivation.derive(
            headBytes: head, exifDateTimeOriginal: "2024:06:01 12:34:56",
            exifCreateDate: nil, filesize: UInt64(head.count), nextChunk: { Data() })
        let b = await MapleIdDerivation.derive(
            headBytes: head, exifDateTimeOriginal: "2024:06:01 12:34:56",
            exifCreateDate: nil, filesize: UInt64(head.count), nextChunk: { Data() })
        XCTAssertEqual(a, b)
    }
}

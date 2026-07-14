// src/apple/Packages/MapleCore/Tests/MapleCoreTests/HashingTests.swift
//
// Unit tests for the BLAKE3 Swift wrapper in Hashing.swift.
//
// BLAKE3 test vectors sourced from the upstream reference implementation
// (https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json).
// The "abc" vector hex was verified with `echo -n abc | b3sum`.

import XCTest
@testable import MapleCore

final class HashingTests: XCTestCase {

    func testBLAKE3HexOfKnownInput() {
        // BLAKE3 hex of the ASCII string "abc" — well-known test vector.
        let abc = Data("abc".utf8)
        let hex = BLAKE3.hex(abc)
        XCTAssertEqual(
            hex,
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        )
    }

    func testBLAKE3HexOfEmptyDataReturnsNil() {
        XCTAssertNil(BLAKE3.hex(Data()))
    }

    func testBLAKE3HexLengthIs64() {
        let data = Data("hello world".utf8)
        let hex = BLAKE3.hex(data)
        XCTAssertEqual(hex?.count, 64)
    }

    func testBLAKE3HexIsLowercase() {
        let data = Data("hello".utf8)
        let hex = BLAKE3.hex(data)!
        XCTAssertEqual(hex, hex.lowercased())
    }

    func testBLAKE3HexDeterministic() {
        let data = Data("determinism check".utf8)
        let hex1 = BLAKE3.hex(data)
        let hex2 = BLAKE3.hex(data)
        XCTAssertEqual(hex1, hex2)
    }

    func testBLAKE3HexDifferentInputsDifferentHashes() {
        let h1 = BLAKE3.hex(Data("aaaa".utf8))
        let h2 = BLAKE3.hex(Data("aaab".utf8))
        XCTAssertNotEqual(h1, h2)
    }

    // MARK: - MapleId (spec-form, 32 chars)
    //
    // These mirror the server-side test cases at
    // `src/api/tests/indexer-id.test.ts` byte-for-byte. The expected hex
    // values were computed by the Rust raw-core reference (verified to
    // match the TS implementation by that test); the device must produce
    // the exact same bytes for backup dedup to fire on the server's
    // `findOne({ maple_id })` lookup.

    /// Production parity vector for the spec-form primary id. The string
    /// is the ISO 8601 form the server indexer actually hashes: exifr
    /// reads EXIF DateTimeOriginal as a Date and the exif stage at
    /// `src/api/src/workers/stages/exif.ts:60` calls `toISOString()` on
    /// it, producing `YYYY-MM-DDTHH:mm:ss.sssZ`. The device's
    /// `PhotoKitAssetReader.readExifCaptureDateISO8601UTC` reformats the
    /// EXIF "YYYY:MM:DD HH:MM:SS" string to that exact ISO form before
    /// calling `MapleId.primary`, so this hex is what the server will
    /// look up for a backed-up frame whose EXIF says `2024:06:01 12:34:56`
    /// captured at UTC. Mirrored in `indexer-id.test.ts`.
    func testMapleIdPrimaryMatchesServerVector() {
        var bytes = [UInt8](repeating: 0, count: 1024)
        for i in 0..<bytes.count { bytes[i] = UInt8(i & 0xff) }
        let data = Data(bytes)
        let hex = MapleId.primary(
            headBytes: data,
            capturedAtISO8601: "2024-06-01T12:34:56.000Z",
            cameraSerial: "SN-1234",
            shutterCount: 4242
        )
        XCTAssertEqual(hex, "014b1f8777da6de0db3c9eca066269ee")
    }

    /// Production parity vector for the indexer-realistic case (no serial,
    /// no shutter). The exif stage currently passes `null` for both, so
    /// this is the hex shape every backed-up file with a parseable
    /// capture date will resolve to. Locks dedup.
    func testMapleIdPrimaryParityNoSerialNoShutter() {
        var bytes = [UInt8](repeating: 0, count: 1024)
        for i in 0..<bytes.count { bytes[i] = UInt8(i & 0xff) }
        let hex = MapleId.primary(
            headBytes: Data(bytes),
            capturedAtISO8601: "2024-06-01T12:34:56.000Z"
        )
        XCTAssertEqual(hex, "011d498eb40e67dd93b123d07a8dce82")
    }

    /// Same as `testMapleIdPrimaryMatchesServerVector` but with absent
    /// serial + zero shutter — covers the FFI's null-pointer path for
    /// serial and the spec's `None ≡ Some(0)` shutter behaviour.
    func testMapleIdPrimaryAbsentSerialAndShutter() {
        let data = Data([1, 2, 3, 4, 5])
        let hex = MapleId.primary(
            headBytes: data,
            capturedAtISO8601: "2024:06:01 12:34:56"
        )
        // Sanity: 32 hex chars, primary tag.
        XCTAssertEqual(hex?.count, 32)
        XCTAssertEqual(hex?.prefix(2), "01")
        // Determinism — same inputs hash to the same output.
        let again = MapleId.primary(
            headBytes: data,
            capturedAtISO8601: "2024:06:01 12:34:56",
            cameraSerial: nil,
            shutterCount: 0
        )
        XCTAssertEqual(hex, again)
    }

    /// `None` serial and `Some(0)` shutter must hash identically to the
    /// "absent" forms — the FFI's `serial_ptr == null` path and
    /// `shutter_count == 0` value must reproduce raw-core's `None` branch.
    func testMapleIdPrimaryEmptyStringSerialEqualsNil() {
        let data = Data([9, 9, 9, 9, 9, 9, 9, 9])
        let a = MapleId.primary(headBytes: data, capturedAtISO8601: "2024:06:01 00:00:00")
        let b = MapleId.primary(
            headBytes: data,
            capturedAtISO8601: "2024:06:01 00:00:00",
            cameraSerial: "",
            shutterCount: 0
        )
        XCTAssertEqual(a, b)
    }

    /// Fallback-form id for a 512-byte ramp — pinned to the same vector as
    /// the server test, so the device's FFI output and the indexer's
    /// `deriveId` branch agree on a single canonical hex. Computed from
    /// `raw_core::MapleId::fallback` on the inputs in
    /// `src/api/tests/indexer-id.test.ts` ("512 step-7").
    func testMapleIdFallbackMatchesServerVector() {
        var bytes = [UInt8](repeating: 0, count: 512)
        for i in 0..<bytes.count { bytes[i] = UInt8((i * 7) & 0xff) }
        let hex = MapleId.fallback(bytes: Data(bytes))
        XCTAssertEqual(hex, "021ee2b82d3019e91bf272ccb95bb8bb")
    }

    func testMapleIdFallbackEmptyReturnsNil() {
        XCTAssertNil(MapleId.fallback(bytes: Data()))
    }

    func testMapleIdPrimaryEmptyHeadOrTsReturnsNil() {
        XCTAssertNil(MapleId.primary(headBytes: Data(), capturedAtISO8601: "x"))
        XCTAssertNil(MapleId.primary(headBytes: Data([0]), capturedAtISO8601: ""))
    }

    /// Primary and fallback ids over the same bytes must NEVER collide —
    /// the leading tag byte (0x01 vs 0x02) is the spec's collision guard
    /// between the two derivations.
    func testMapleIdPrimaryFallbackNeverCollide() {
        let data = Data(repeating: 0xab, count: 256)
        let p = MapleId.primary(headBytes: data, capturedAtISO8601: "2024:06:01 12:34:56")
        let f = MapleId.fallback(bytes: data)
        XCTAssertNotNil(p)
        XCTAssertNotNil(f)
        XCTAssertNotEqual(p, f)
        XCTAssertEqual(p?.prefix(2), "01")
        XCTAssertEqual(f?.prefix(2), "02")
    }

    // MARK: - FallbackFormHasher (streaming fallback-form id hasher, #1995)
    //
    // The load-bearing property: any chunking of the SAME bytes in the SAME
    // order must reproduce exactly what `MapleId.fallback(bytes:)` computes
    // for the whole buffer in one call — proving the Swift wrapper is
    // correct independent of any particular chunking, mirroring the Rust
    // reference's own `fallback_id_hasher_matches_one_shot_*` test suite
    // (`raw-core/src/id.rs`).

    /// Deterministic, non-trivial byte content — a chunking bug that
    /// scrambled byte order would change the hash rather than being masked
    /// by degenerate (all-zero/all-same) input.
    private func pseudoRandomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        for i in 0..<count {
            let x = UInt64(i) &* 2_654_435_761 &+ 0x9E37_79B9
            bytes[i] = UInt8((x >> 24) & 0xff)
        }
        return Data(bytes)
    }

    /// Feed `bytes` through a fresh `FallbackFormHasher` in the chunks
    /// implied by `splits` (an ascending sequence starting at 0 and ending
    /// at `bytes.count`; consecutive equal values produce a zero-length
    /// chunk), then finalize with `bytes.count` as the filesize, and assert
    /// the result matches `MapleId.fallback(bytes:)` for the same buffer.
    private func assertChunkedMatchesOneShot(_ bytes: Data, splits: [Int], line: UInt = #line) {
        precondition(splits.first == 0 && splits.last == bytes.count)
        let hasher = FallbackFormHasher()
        for window in zip(splits, splits.dropFirst()) {
            hasher.update(bytes.subdata(in: window.0..<window.1))
        }
        let chunked = hasher.finalize(filesize: UInt64(bytes.count))
        let oneShot = MapleId.fallback(bytes: bytes)
        XCTAssertEqual(chunked, oneShot, "chunked hash diverged for splits \(splits)", line: line)
    }

    func testFallbackFormHasherMatchesOneShotForSmallBuffer() {
        // Proves the wrapper is correct independent of chunking, over a
        // buffer small enough to eyeball: one `update` call covering
        // everything.
        let bytes = pseudoRandomBytes(1024)
        assertChunkedMatchesOneShot(bytes, splits: [0, bytes.count])
    }

    func testFallbackFormHasherMatchesOneShotAcrossManySplits() {
        let bytes = pseudoRandomBytes(130_000)
        assertChunkedMatchesOneShot(bytes, splits: [
            0, 17, 500, 4096, 4096, 12_345, 65_536, 65_537, 100_000, bytes.count,
        ])
    }

    func testFallbackFormHasherMatchesOneShotWithEmptyLeadingChunk() {
        let bytes = pseudoRandomBytes(2048)
        assertChunkedMatchesOneShot(bytes, splits: [0, 0, bytes.count])
    }

    func testFallbackFormHasherMatchesOneShotAllSingleByteChunks() {
        let bytes = pseudoRandomBytes(200)
        assertChunkedMatchesOneShot(bytes, splits: Array(0...bytes.count))
    }

    func testFallbackFormHasherHandlesEmptyInput() {
        // `MapleId.fallback(bytes:)` rejects empty input by contract (its
        // own `guard !bytes.isEmpty`, mirroring the FFI's `bytes_len == 0`
        // -> -2 rejection — a defensive check against a zero-length raw
        // pointer, not a property of the hashing algorithm). The STREAMING
        // hasher has no equivalent guard at either the Rust or FFI layer
        // (`raw_core::FallbackIdHasher::finalize` and
        // `maple_fallback_id_hasher_finalize` both finalize unconditionally
        // regardless of how many bytes were fed) — a real file could validly
        // be zero bytes mid-stream, and the hasher must still produce a
        // real, well-formed id in that case rather than nil.
        let hasher = FallbackFormHasher()
        let hex = hasher.finalize(filesize: 0)
        XCTAssertNotNil(hex)
        XCTAssertEqual(hex?.count, 32)
        XCTAssertEqual(hex?.prefix(2), "02")

        // Deterministic: a second hasher fed nothing, finalized with the
        // same filesize, produces the identical id.
        let hasher2 = FallbackFormHasher()
        XCTAssertEqual(hasher2.finalize(filesize: 0), hex)
    }

    func testFallbackFormHasherFilesizeIsExplicitNotBytesFed() {
        // Mirrors MapleId.fallback's existing filesize-independent-of-
        // bytes-len contract: the hasher mixes in whatever `filesize`
        // `finalize` is called with, not the accumulated byte count. Same
        // fed bytes, two different claimed filesizes -> two different ids.
        let bytes = pseudoRandomBytes(100)

        let hasherA = FallbackFormHasher()
        hasherA.update(bytes)
        let hexA = hasherA.finalize(filesize: 100)

        let hasherB = FallbackFormHasher()
        hasherB.update(bytes)
        let hexB = hasherB.finalize(filesize: 999)

        XCTAssertNotNil(hexA)
        XCTAssertNotNil(hexB)
        XCTAssertNotEqual(hexA, hexB)
        // The "true byte count" filesize must still match the one-shot
        // reference — this is the case that matters in practice (filesize
        // == bytes fed).
        XCTAssertEqual(hexA, MapleId.fallback(bytes: bytes))
    }

    func testFallbackFormHasherOutputIsTaggedFallback() {
        let bytes = pseudoRandomBytes(512)
        let hasher = FallbackFormHasher()
        hasher.update(bytes)
        let hex = hasher.finalize(filesize: UInt64(bytes.count))
        XCTAssertEqual(hex?.prefix(2), "02")
    }

    func testFallbackFormHasherSecondFinalizeIsNilNotCrash() {
        let hasher = FallbackFormHasher()
        hasher.update(Data([1, 2, 3]))
        _ = hasher.finalize(filesize: 3)
        // Consumed — a second finalize call must not crash (defensive
        // no-op, not a documented supported path).
        XCTAssertNil(hasher.finalize(filesize: 3))
    }

    func testFallbackFormHasherAbandonedWithoutFinalizeDoesNotCrash() {
        // Early-abort path: let a hasher deinit without ever calling
        // finalize. Nothing to assert beyond "this doesn't crash" — the
        // `deinit` -> `maple_fallback_id_hasher_free` path is exercised
        // implicitly when `hasher` goes out of scope.
        let hasher = FallbackFormHasher()
        hasher.update(Data([9, 9, 9]))
        _ = hasher // silence "never used" — the point is letting it deinit
    }
}

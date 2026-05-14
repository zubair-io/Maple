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
}

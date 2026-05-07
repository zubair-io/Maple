// SMBCredentialStoreTests.swift — Keychain round-trip for SMB credentials.
//
// These tests write to the real login Keychain. They clean up after themselves
// via `delete(_:)`, and skip on CI environments that don't have a default
// keychain (detected via an OSStatus back from `SecItemAdd` that isn't
// `errSecSuccess`).

import XCTest
@testable import MapleCore

final class SMBCredentialStoreTests: XCTestCase {

    /// Unique per-test host so parallel runs don't stomp each other.
    private func makeCreds(suffix: String = UUID().uuidString) -> SMBSource.Credentials {
        SMBSource.Credentials(
            host: "unit-test-\(suffix).local",
            share: "photos",
            username: "tester",
            password: "s3cr3t"
        )
    }

    // MARK: Round trip

    func testSaveAndFetch() async throws {
        let store = SMBCredentialStore.shared
        let creds = makeCreds()
        let share = SMBCredentialStore.SavedShare(
            host: creds.host, share: creds.share, username: creds.username
        )

        do {
            try await store.save(creds)
        } catch {
            // Keychain unavailable in this sandbox — skip, not fail.
            throw XCTSkip("Keychain not writeable: \(error)")
        }

        let fetched = await store.credentials(for: share)
        XCTAssertEqual(fetched?.password, "s3cr3t")
        XCTAssertEqual(fetched?.username, "tester")
        XCTAssertEqual(fetched?.host, creds.host)

        // Clean up.
        await store.delete(share)
        let afterDelete = await store.credentials(for: share)
        XCTAssertNil(afterDelete)
    }

    // MARK: Saved-shares list

    func testSavedSharesListTracksSaveDelete() async throws {
        let store = SMBCredentialStore.shared
        let creds = makeCreds()
        let share = SMBCredentialStore.SavedShare(
            host: creds.host, share: creds.share, username: creds.username
        )

        do {
            try await store.save(creds)
        } catch {
            throw XCTSkip("Keychain not writeable: \(error)")
        }
        let list = await store.savedShares()
        XCTAssertTrue(list.contains(share), "savedShares should include the new entry")

        await store.delete(share)
        let listAfter = await store.savedShares()
        XCTAssertFalse(listAfter.contains(share), "savedShares should drop the deleted entry")
    }

    // MARK: Codable round trip (pure, no Keychain)

    func testSavedShareCodable() throws {
        let share = SMBCredentialStore.SavedShare(
            host: "h", share: "s", username: "u"
        )
        let encoded = try JSONEncoder().encode(share)
        let decoded = try JSONDecoder().decode(
            SMBCredentialStore.SavedShare.self, from: encoded
        )
        XCTAssertEqual(decoded, share)
    }
}

final class SourceSelectionTests: XCTestCase {

    /// Codable round trip for each SourceSelection variant.
    func testSourceSelectionRoundTrip() throws {
        let cases: [SourceSelection] = [
            .filesystem(bookmark: Data([1,2,3])),
            .photoKit,
            .smb(SMBCredentialStore.SavedShare(host: "h", share: "s", username: "u")),
            .cloudLibrary(serverID: URL(string: "https://maple.example")!,
                          folderID: "folder-abc"),
        ]
        for selection in cases {
            let data = try JSONEncoder().encode(selection)
            let back = try JSONDecoder().decode(SourceSelection.self, from: data)
            XCTAssertEqual(back, selection)
        }
    }

    /// UserDefaults store write-then-read on a custom suite so we don't stomp
    /// the real app defaults.
    func testSourceSelectionStoreRoundTrip() {
        // Wipe before + after so this test is idempotent in a shared defaults.
        SourceSelectionStore.clear()
        XCTAssertNil(SourceSelectionStore.load())

        let sel: SourceSelection = .cloudLibrary(
            serverID: URL(string: "https://unit-test.example")!,
            folderID: "folder-xyz"
        )
        SourceSelectionStore.save(sel)
        let loaded = SourceSelectionStore.load()
        XCTAssertEqual(loaded, sel)

        SourceSelectionStore.clear()
    }
}

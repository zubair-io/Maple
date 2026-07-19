// CloudServerRegistryTests.swift
import XCTest
@testable import MapleCore

@MainActor
final class CloudServerRegistryTests: XCTestCase {
  private var defaults: UserDefaults!
  private let suiteName = "CloudServerRegistryTests"

  override func setUp() async throws {
    defaults = UserDefaults(suiteName: suiteName)!
    defaults.removePersistentDomain(forName: suiteName)
  }

  override func tearDown() async throws {
    defaults.removePersistentDomain(forName: suiteName)
  }

  func test_addServer_persists() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    XCTAssertEqual(reg.servers, [url])
    let reg2 = CloudServerRegistry(defaults: defaults)
    XCTAssertEqual(reg2.servers, [url])
  }

  func test_addSameServer_isIdempotent() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.register(url)
    XCTAssertEqual(reg.servers.count, 1)
  }

  func test_removeServer_persists() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.remove(url)
    XCTAssertTrue(reg.servers.isEmpty)
    let reg2 = CloudServerRegistry(defaults: defaults)
    XCTAssertTrue(reg2.servers.isEmpty)
  }

  func test_setViewMode_persistsPerServer() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.setViewMode(.timeline, for: url)
    XCTAssertEqual(reg.viewMode(for: url), .timeline)
    let reg2 = CloudServerRegistry(defaults: defaults)
    XCTAssertEqual(reg2.viewMode(for: url), .timeline)
  }

  func test_viewMode_defaultIsFolder() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://newserver.com")!
    XCTAssertEqual(reg.viewMode(for: url), .folder)
  }

  func test_setSelectedLibraryID_persistsPerServer() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.setSelectedLibraryID("lib-1", for: url)
    XCTAssertEqual(reg.selectedLibraryID(for: url), "lib-1")
    let reg2 = CloudServerRegistry(defaults: defaults)
    XCTAssertEqual(reg2.selectedLibraryID(for: url), "lib-1")
  }

  func test_selectedLibraryID_defaultIsNil() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://newserver.com")!
    XCTAssertNil(reg.selectedLibraryID(for: url))
  }

  func test_setSelectedLibraryID_nilClearsSelection() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.setSelectedLibraryID("lib-1", for: url)
    reg.setSelectedLibraryID(nil, for: url)
    XCTAssertNil(reg.selectedLibraryID(for: url))
    let reg2 = CloudServerRegistry(defaults: defaults)
    XCTAssertNil(reg2.selectedLibraryID(for: url))
  }

  func test_removeServer_clearsSelectedLibraryID() {
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.setSelectedLibraryID("lib-1", for: url)
    reg.remove(url)
    XCTAssertNil(reg.selectedLibraryID(for: url))
  }

  func test_setViewMode_triggersObservation() {
    // Regression: a previous impl assigned `servers = servers` to "fire"
    // Observation. @Observable correctly treats no-change writes as a
    // no-op, so observers never woke up. Verify mutation of a real
    // observable property by tracking with `withObservationTracking`.
    let reg = CloudServerRegistry(defaults: defaults)
    let url = URL(string: "https://myserver.com")!
    reg.register(url)
    reg.setViewMode(.folder, for: url)

    var fired = 0
    let exp = expectation(description: "observer fires on setViewMode")
    func track() {
      _ = withObservationTracking {
        reg.viewMode(for: url)
      } onChange: {
        fired += 1
        exp.fulfill()
      }
    }
    track()
    reg.setViewMode(.timeline, for: url)
    wait(for: [exp], timeout: 1.0)
    XCTAssertEqual(fired, 1)
  }
}

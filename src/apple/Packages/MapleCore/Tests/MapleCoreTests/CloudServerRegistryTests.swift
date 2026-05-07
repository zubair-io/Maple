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
}

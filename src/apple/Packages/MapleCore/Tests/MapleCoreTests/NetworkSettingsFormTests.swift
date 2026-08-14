// NetworkSettingsFormTests.swift
//
// The two rules that make the Network page correct rather than merely
// functional (#2766):
//
//   1. Seed the override fields ONLY from `db_override` provenance. If an
//      auto-detected address were seeded into the override box, the next
//      Save would freeze today's DHCP lease as a permanent manual
//      override — the page would silently break itself.
//   2. Blank means "clear the override", which serializes as null, not as
//      an omitted key and not as 0.

import XCTest
@testable import MapleCore

final class NetworkSettingsFormTests: XCTestCase {

  private func config(
    enabled: Bool = true,
    ip: String? = "192.168.1.42",
    port: Int = 3000,
    ipSource: NetworkValueSource,
    portSource: NetworkValueSource
  ) -> NetworkConfig {
    NetworkConfig(
      enabled: enabled, localIP: ip, localPort: port,
      source: NetworkConfigSource(localIP: ipSource, localPort: portSource))
  }

  // MARK: - Seeding

  func test_seed_fromDBOverridePopulatesFields() {
    let form = NetworkSettingsForm.seeded(
      from: config(ipSource: .dbOverride, portSource: .dbOverride))
    XCTAssertEqual(form.ipOverride, "192.168.1.42")
    XCTAssertEqual(form.portOverride, "3000")
    XCTAssertTrue(form.enabled)
  }

  func test_seed_autoDetectedIPLeavesOverrideBlank() {
    let form = NetworkSettingsForm.seeded(
      from: config(ipSource: .autoDetected, portSource: .defaultValue))
    XCTAssertEqual(form.ipOverride, "")
    XCTAssertEqual(form.portOverride, "")
  }

  func test_seed_unavailableIPLeavesOverrideBlank() {
    let form = NetworkSettingsForm.seeded(
      from: config(ip: nil, ipSource: .unavailable, portSource: .defaultValue))
    XCTAssertEqual(form.ipOverride, "")
  }

  func test_seed_mixedProvenanceSeedsOnlyTheOverriddenField() {
    let form = NetworkSettingsForm.seeded(
      from: config(ipSource: .dbOverride, portSource: .defaultValue))
    XCTAssertEqual(form.ipOverride, "192.168.1.42")
    XCTAssertEqual(form.portOverride, "")
  }

  // MARK: - Validation

  func test_validate_blankFieldsClearBothOverrides() {
    let form = NetworkSettingsForm(ipOverride: "", portOverride: "", enabled: false)
    guard case .valid(let patch) = form.validated() else {
      return XCTFail("expected valid")
    }
    XCTAssertNil(patch.localIPOverride)
    XCTAssertNil(patch.localPortOverride)
    XCTAssertFalse(patch.enabled)
  }

  func test_validate_trimsWhitespaceAndTreatsBlankAsCleared() {
    let form = NetworkSettingsForm(ipOverride: "   ", portOverride: "  ", enabled: true)
    guard case .valid(let patch) = form.validated() else {
      return XCTFail("expected valid")
    }
    XCTAssertNil(patch.localIPOverride)
    XCTAssertNil(patch.localPortOverride)
  }

  func test_validate_acceptsBoundaryPorts() {
    for port in ["1", "65535"] {
      let form = NetworkSettingsForm(ipOverride: "", portOverride: port, enabled: true)
      guard case .valid(let patch) = form.validated() else {
        return XCTFail("expected \(port) to validate")
      }
      XCTAssertEqual(patch.localPortOverride, Int(port))
    }
  }

  func test_validate_rejectsOutOfRangeAndNonNumericPorts() {
    for port in ["0", "65536", "-1", "80.5", "abc"] {
      let form = NetworkSettingsForm(ipOverride: "", portOverride: port, enabled: true)
      guard case .invalid(let message) = form.validated() else {
        return XCTFail("expected \(port) to be rejected")
      }
      XCTAssertEqual(message, "Port must be an integer between 1 and 65535.")
    }
  }

  func test_validate_passesTrimmedIPThrough() {
    let form = NetworkSettingsForm(
      ipOverride: "  100.64.0.1  ", portOverride: "", enabled: true)
    guard case .valid(let patch) = form.validated() else {
      return XCTFail("expected valid")
    }
    // Tailscale/CGNAT addresses are legitimate here — the server
    // deliberately does not require RFC1918.
    XCTAssertEqual(patch.localIPOverride, "100.64.0.1")
  }
}

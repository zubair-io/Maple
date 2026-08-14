// NetworkSettingsVMTests.swift
//
// Covers the pure derivations behind the Network settings page (#2766).
// These live in a `+VM` sibling per issue #192 precisely so they're
// reachable from a test — the view itself isn't, because XCUITest is
// unavailable on the primary dev machine (#2525).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class NetworkSettingsVMTests: XCTestCase {

    private func config(
        enabled: Bool = true,
        ip: String? = "192.168.1.42",
        port: Int = 3000,
        ipSource: NetworkValueSource = .autoDetected,
        portSource: NetworkValueSource = .defaultValue
    ) -> NetworkConfig {
        NetworkConfig(
            enabled: enabled, localIP: ip, localPort: port,
            source: NetworkConfigSource(localIP: ipSource, localPort: portSource))
    }

    // MARK: - provenanceLabel

    func test_provenanceLabel_coversEveryKnownSource() {
        XCTAssertEqual(NetworkSettingsVM.provenanceLabel(.dbOverride), "(operator override)")
        XCTAssertEqual(NetworkSettingsVM.provenanceLabel(.autoDetected), "(auto-detected)")
        XCTAssertEqual(NetworkSettingsVM.provenanceLabel(.unavailable), "(unavailable)")
        XCTAssertEqual(NetworkSettingsVM.provenanceLabel(.defaultValue), "(default)")
    }

    func test_provenanceLabel_unknownRendersEmptyNotAPlaceholder() {
        // A newer server reporting an unrecognised source must not produce
        // invented copy — the value still shows, the suffix just goes away.
        XCTAssertEqual(NetworkSettingsVM.provenanceLabel(.unknown), "")
    }

    // MARK: - addressDisplay

    func test_addressDisplay_usesResolvedAddress() {
        XCTAssertEqual(NetworkSettingsVM.addressDisplay(config(ip: "10.0.0.5")), "10.0.0.5")
    }

    func test_addressDisplay_fallsBackToNone() {
        XCTAssertEqual(NetworkSettingsVM.addressDisplay(config(ip: nil)), "none")
    }

    // MARK: - shouldWarnNoLANAddress

    func test_warn_whenUnavailableAndEnabled() {
        XCTAssertTrue(
            NetworkSettingsVM.shouldWarnNoLANAddress(
                config(enabled: true, ip: nil, ipSource: .unavailable)))
    }

    func test_noWarn_whenUnavailableButAdvertisingIsOff() {
        // Not an actionable problem while the feature is off; warning anyway
        // trains the operator to ignore the banner.
        XCTAssertFalse(
            NetworkSettingsVM.shouldWarnNoLANAddress(
                config(enabled: false, ip: nil, ipSource: .unavailable)))
    }

    func test_noWarn_whenAddressResolved() {
        XCTAssertFalse(
            NetworkSettingsVM.shouldWarnNoLANAddress(
                config(enabled: true, ipSource: .autoDetected)))
        XCTAssertFalse(
            NetworkSettingsVM.shouldWarnNoLANAddress(
                config(enabled: true, ipSource: .dbOverride)))
    }
}

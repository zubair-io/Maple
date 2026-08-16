// EnrichmentSettingsVMTests.swift
//
// Covers the pure derivations behind the four enrichment settings rows
// (#2771). These live in a `+VM` sibling per issue #192 precisely so
// they're reachable from a test — the views themselves aren't, because
// XCUITest is unavailable on the primary dev machine (#2525). The
// heavier merge-hazard / range-reset rules live one layer down in
// EnrichmentSettingsForms.swift (MapleCore) and are covered by
// EnrichmentSettingsTests.swift in the package test target.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class EnrichmentSettingsVMTests: XCTestCase {

    // MARK: - geocodeTestDisabledReason

    func test_geocodeTestDisabledReason_nilWhenURLPresent() {
        let form = GeocodeSettingsForm(nominatimURL: "https://nominatim.example")
        XCTAssertNil(EnrichmentSettingsVM.geocodeTestDisabledReason(form))
    }

    func test_geocodeTestDisabledReason_explainsBlankURL() {
        let form = GeocodeSettingsForm(nominatimURL: "   ")
        XCTAssertEqual(
            EnrichmentSettingsVM.geocodeTestDisabledReason(form), "Enter a URL to test.")
    }

    // MARK: - meilisearchTestDisabledReason

    func test_meilisearchTestDisabledReason_nilWhenURLPresent() {
        let form = MeilisearchSettingsForm(url: "http://meili.example")
        XCTAssertNil(EnrichmentSettingsVM.meilisearchTestDisabledReason(form))
    }

    func test_meilisearchTestDisabledReason_explainsBlankURLEvenWithAKeyTyped() {
        // The distinguishing case: a freshly-typed key alone isn't enough —
        // the guard is on the URL, matching workers.component.ts.
        let form = MeilisearchSettingsForm(url: "", apiKey: "s3cret")
        XCTAssertEqual(
            EnrichmentSettingsVM.meilisearchTestDisabledReason(form), "Enter a URL to test.")
    }

    // MARK: - meilisearchAPIKeyPlaceholder

    func test_apiKeyPlaceholder_signalsStoredKeyWithoutRevealingIt() {
        let placeholder = EnrichmentSettingsVM.meilisearchAPIKeyPlaceholder(apiKeyIsSet: true)
        XCTAssertTrue(placeholder.contains("unchanged"))
        XCTAssertTrue(placeholder.contains("•"))
    }

    func test_apiKeyPlaceholder_emptyWhenNoKeyStored() {
        XCTAssertEqual(EnrichmentSettingsVM.meilisearchAPIKeyPlaceholder(apiKeyIsSet: false), "")
    }
}

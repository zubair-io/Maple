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

    // MARK: - faceModelStatusHeadline (T5b, #2772)

    func test_faceModelStatusHeadline_nilStatus() {
        XCTAssertEqual(
            EnrichmentSettingsVM.faceModelStatusHeadline(nil), "Model status unknown.")
    }

    func test_faceModelStatusHeadline_loaded() {
        let status = FaceModelsStatus(
            status: .loaded, errorDetail: nil,
            detector: .init(path: "/x/scrfd_10g.onnx", present: true, bytes: 1),
            recognizer: .init(path: "/x/arcface.onnx", present: true, bytes: 1))
        XCTAssertEqual(EnrichmentSettingsVM.faceModelStatusHeadline(status), "Models loaded.")
    }

    func test_faceModelStatusHeadline_errorIncludesDetail() {
        let status = FaceModelsStatus(
            status: .error, errorDetail: "sha256 mismatch",
            detector: .init(path: "/x/scrfd_10g.onnx", present: false, bytes: 0),
            recognizer: .init(path: "/x/arcface.onnx", present: false, bytes: 0))
        XCTAssertEqual(
            EnrichmentSettingsVM.faceModelStatusHeadline(status),
            "Model load failed: sha256 mismatch.")
    }

    func test_faceModelStatusHeadline_idle() {
        let status = FaceModelsStatus(
            status: .idle, errorDetail: nil,
            detector: .init(path: "/x/scrfd_10g.onnx", present: false, bytes: 0),
            recognizer: .init(path: "/x/arcface.onnx", present: false, bytes: 0))
        XCTAssertEqual(
            EnrichmentSettingsVM.faceModelStatusHeadline(status), "Models not yet loaded.")
    }

    // MARK: - formatModelBytes

    func test_formatModelBytes_humanReadable() {
        // ByteCountFormatter is locale/OS-version sensitive on the exact
        // separator, so assert on content rather than an exact string.
        let formatted = EnrichmentSettingsVM.formatModelBytes(16_700_000)
        XCTAssertTrue(formatted.contains("MB"), "expected an MB-scale string, got \(formatted)")
    }

    // MARK: - faceModelDetailSuffix

    func test_faceModelDetailSuffix_nilProbeIsEmpty() {
        // A missing probe must not suppress the banner entirely (Copilot
        // review on #3215) — the caller always shows the headline; this only
        // covers whether the trailing file detail is appended.
        XCTAssertEqual(EnrichmentSettingsVM.faceModelDetailSuffix(fileLabel: "x.onnx", probe: nil), "")
    }

    func test_faceModelDetailSuffix_includesFilenameSizeAndPath() {
        let probe = FaceModelsStatus.FileProbe(path: "/x/scrfd_10g.onnx", present: true, bytes: 1_000_000)
        let suffix = EnrichmentSettingsVM.faceModelDetailSuffix(fileLabel: "scrfd_10g.onnx", probe: probe)
        XCTAssertTrue(suffix.contains("scrfd_10g.onnx"))
        XCTAssertTrue(suffix.contains("/x/scrfd_10g.onnx"))
    }
}

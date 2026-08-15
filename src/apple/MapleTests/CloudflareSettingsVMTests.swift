// CloudflareSettingsVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/ServerAdmin/CloudflareSettingsView+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because
// `CloudflareSettingsVM` is declared in the app target, per the `+VM.swift`
// co-location pattern — same as NetworkSettingsVMTests / InfoPanelVMTests.
//
// Focus: the copy that explains *why* Test is unavailable. With a secret
// saved and every other field filled, a disabled Test button looks like a
// bug unless the UI says the saved key can't be probed.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class CloudflareSettingsVMTests: XCTestCase {

    private func filledForm(secret: String = "") -> CloudflareSettingsForm {
        CloudflareSettingsForm(
            enabled: true, accountID: "a1b2", bucket: "maple-thumbs",
            accessKeyID: "AKIA1", secretAccessKey: secret)
    }

    // MARK: - secretPlaceholder

    func test_secretPlaceholder_signalsStoredKeyWithoutRevealingIt() {
        let placeholder = CloudflareSettingsVM.secretPlaceholder(secretIsSet: true)
        XCTAssertTrue(placeholder.contains("unchanged"))
        XCTAssertTrue(placeholder.contains("•"))
    }

    func test_secretPlaceholder_emptyWhenNoKeyStored() {
        XCTAssertEqual(CloudflareSettingsVM.secretPlaceholder(secretIsSet: false), "")
    }

    // MARK: - canTest

    func test_canTest_requiresFreshlyTypedSecret() {
        XCTAssertFalse(CloudflareSettingsVM.canTest(filledForm()))
        XCTAssertTrue(CloudflareSettingsVM.canTest(filledForm(secret: "s3cret")))
    }

    func test_canTest_falseWhenAnIdentityFieldIsBlank() {
        var form = filledForm(secret: "s3cret")
        form.bucket = "  "
        XCTAssertFalse(CloudflareSettingsVM.canTest(form))
    }

    // MARK: - testDisabledReason

    func test_disabledReason_nilWhenTestable() {
        XCTAssertNil(
            CloudflareSettingsVM.testDisabledReason(filledForm(secret: "s3cret"), secretIsSet: true))
    }

    func test_disabledReason_explainsTheWriteOnlyKeyWhenOneIsStored() {
        // The distinguishing case: nothing is missing from the operator's
        // point of view, so the message has to name the actual reason.
        let reason = CloudflareSettingsVM.testDisabledReason(filledForm(), secretIsSet: true)
        XCTAssertEqual(
            reason, "Re-enter the secret access key to test — the saved key is never sent back.")
    }

    func test_disabledReason_asksForMissingFieldsWhenNothingIsStored() {
        let reason = CloudflareSettingsVM.testDisabledReason(
            CloudflareSettingsForm(), secretIsSet: false)
        XCTAssertEqual(
            reason, "Fill in account ID, bucket, access key ID, and secret access key to test.")
    }

    // MARK: - statusSummary

    func test_statusSummary_reassuresWhenDisabled() {
        let config = CloudflareConfig(
            enabled: false, accountID: nil, bucket: nil, accessKeyID: nil, secretAccessKeySet: false)
        XCTAssertTrue(CloudflareSettingsVM.statusSummary(config).contains("No data leaves"))
    }

    func test_statusSummary_namesTheBucketWhenEnabled() {
        let config = CloudflareConfig(
            enabled: true, accountID: "a1b2", bucket: "maple-thumbs", accessKeyID: "AKIA1",
            secretAccessKeySet: true)
        XCTAssertTrue(CloudflareSettingsVM.statusSummary(config).contains("maple-thumbs"))
    }
}

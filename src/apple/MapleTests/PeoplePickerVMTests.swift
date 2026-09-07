// PeoplePickerVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/Masks/PeoplePickerSheet+VM.swift` (#3275, #192 pattern).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class PeoplePickerVMTests: XCTestCase {
    private let two = [
        PersonCandidate(id: 0, boundingBox: CGRect(x: 0, y: 0, width: 0.5, height: 1)),
        PersonCandidate(id: 1, boundingBox: CGRect(x: 0.5, y: 0, width: 0.5, height: 1)),
    ]

    func testDetectionSuccessPreselectsTheFirstPerson() {
        let loaded = PeoplePickerVM.loaded(.success(two))
        XCTAssertEqual(loaded.people, two)
        XCTAssertEqual(loaded.selected, 0)
        XCTAssertNil(loaded.errorMessage)
    }

    func testNobodyDetectedIsTheWholeImageFallbackNotAnError() {
        let loaded = PeoplePickerVM.loaded(.failure(PersonSkinMaskError.noPersonDetected))
        XCTAssertTrue(loaded.people.isEmpty)
        XCTAssertNil(loaded.selected)
        XCTAssertNil(loaded.errorMessage)
    }

    func testOtherFailuresSurfaceAMessage() {
        let loaded = PeoplePickerVM.loaded(.failure(PersonSkinMaskError.visionFailed("boom")))
        XCTAssertTrue(loaded.people.isEmpty)
        XCTAssertTrue(loaded.errorMessage?.hasPrefix("Couldn't detect people: ") == true, loaded.errorMessage ?? "nil")
    }

    func testCanCreateRequiresASelectionOnlyWhenPeopleWereFound() {
        XCTAssertFalse(PeoplePickerVM.canCreate(isLoading: true, isCreating: false, people: [], selected: nil))
        XCTAssertFalse(PeoplePickerVM.canCreate(isLoading: false, isCreating: true, people: [], selected: nil))
        XCTAssertTrue(PeoplePickerVM.canCreate(isLoading: false, isCreating: false, people: [], selected: nil))
        XCTAssertFalse(PeoplePickerVM.canCreate(isLoading: false, isCreating: false, people: two, selected: nil))
        XCTAssertTrue(PeoplePickerVM.canCreate(isLoading: false, isCreating: false, people: two, selected: 1))
    }

    func testCreationTargetResolvesTheSelectedPersonOrFallsBackToWholeImage() {
        XCTAssertEqual(PeoplePickerVM.creationTarget(people: two, selected: 1), two[1])
        XCTAssertNil(PeoplePickerVM.creationTarget(people: two, selected: nil))
        XCTAssertNil(PeoplePickerVM.creationTarget(people: [], selected: 3))
    }
}

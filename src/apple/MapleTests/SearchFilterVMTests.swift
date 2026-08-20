// SearchFilterVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/SearchFilterPanel+VM.swift` and
// `Maple/Views/SearchActiveFilterChips+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because the VM
// enums are declared in the app target, per the `+VM.swift` co-location
// pattern (issue #192) — same as BrowseGridVMTests / InfoPanelVMTests.

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class SearchFilterVMTests: XCTestCase {

    /// Fixed "now" so preset ranges are deterministic: 2026-06-15 in the
    /// local calendar (the same calendar `range()` formats with).
    private let now = SearchDateFormat.date(from: "2026-06-15")!

    // MARK: - SearchDatePreset ranges

    func testPresetRangesFromFixedNow() {
        XCTAssertEqual(SearchDatePreset.today.range(now: now).from, "2026-06-15")
        XCTAssertEqual(SearchDatePreset.today.range(now: now).to, "2026-06-15")
        XCTAssertEqual(SearchDatePreset.last7.range(now: now).from, "2026-06-09")
        XCTAssertEqual(SearchDatePreset.last30.range(now: now).from, "2026-05-17")
        XCTAssertEqual(SearchDatePreset.thisYear.range(now: now).from, "2026-01-01")
        XCTAssertEqual(SearchDatePreset.thisYear.range(now: now).to, "2026-06-15")
    }

    // MARK: - SearchDatePreset.matching

    func testMatchingFindsExactPresetRange() {
        XCTAssertEqual(
            SearchDatePreset.matching(from: "2026-06-09", to: "2026-06-15", now: now),
            .last7)
        XCTAssertEqual(
            SearchDatePreset.matching(from: "2026-01-01", to: "2026-06-15", now: now),
            .thisYear)
    }

    func testMatchingRejectsCustomOrPartialRanges() {
        // A custom range lights no preset chip.
        XCTAssertNil(SearchDatePreset.matching(from: "2026-06-01", to: "2026-06-15", now: now))
        // A one-sided bound can't match any preset (all presets set both).
        XCTAssertNil(SearchDatePreset.matching(from: "2026-06-09", to: nil, now: now))
        XCTAssertNil(SearchDatePreset.matching(from: nil, to: nil, now: now))
    }

    // MARK: - SearchDateFormat

    func testDateFormatRoundTripsWireShape() {
        let date = SearchDateFormat.date(from: "2026-02-01")
        XCTAssertNotNil(date)
        XCTAssertEqual(SearchDateFormat.string(from: date!), "2026-02-01")
    }

    func testDisplayFallsBackToRawStringWhenUnparseable() {
        XCTAssertEqual(SearchDateFormat.display("not-a-date"), "not-a-date")
    }

    // MARK: - SearchFilterPanelVM.rowModels

    func testRowModelsMapFacetsAndDropEmptyValues() {
        let rows = SearchFilterPanelVM.rowModels(
            facets: [
                ValueFacet(value: "Priya Patel", count: 812),
                ValueFacet(value: nil, count: 3),
                ValueFacet(value: "", count: 2),
            ],
            selected: [])
        XCTAssertEqual(rows, [.init(value: "Priya Patel", count: 812)])
    }

    func testRowModelsKeepOrphanedSelectionsVisible() {
        // A selected value the filter-aware facet list no longer carries
        // must stay visible (count-less) so it remains removable.
        let rows = SearchFilterPanelVM.rowModels(
            facets: [ValueFacet(value: "Kyoto", count: 74)],
            selected: ["Portland, OR", "Kyoto"])
        XCTAssertEqual(rows, [
            .init(value: "Portland, OR", count: nil),
            .init(value: "Kyoto", count: 74),
        ])
    }

    // MARK: - SearchFilterPanelVM.toggled

    func testToggledAddsAndRemoves() {
        XCTAssertEqual(SearchFilterPanelVM.toggled([], "a"), ["a"])
        XCTAssertEqual(SearchFilterPanelVM.toggled(["a", "b"], "a"), ["b"])
    }

    // MARK: - SearchActiveFilterChipsVM.chips

    func testChipsOrderDateThenPeopleThenPlaces() {
        var params = SearchParams()
        params.from = "2026-06-09"
        params.to = "2026-06-15"
        params.people = ["Priya Patel"]
        params.place = ["Portland, OR"]
        let chips = SearchActiveFilterChipsVM.chips(params: params, now: now)
        XCTAssertEqual(chips, [
            .date(label: "Last 7 days"),
            .person("Priya Patel"),
            .place("Portland, OR"),
        ])
        XCTAssertEqual(chips.map(\.id), ["date", "person:Priya Patel", "place:Portland, OR"])
    }

    func testChipsEmptyWhenNoUnifiedFilters() {
        XCTAssertEqual(SearchActiveFilterChipsVM.chips(params: SearchParams(), now: now), [])
    }

    // MARK: - Inferred date window (#2956)
    //
    // A window the SERVER read out of the query text applied to the results
    // but appeared nowhere: chips came from `SearchParams` alone, so the
    // panel could show no date while the search was clamped to one. That is
    // the "I did not have a date selected" report from #2928.

    func testInferredChipAppearsAfterTheUsersOwnFilters() {
        var params = SearchParams()
        params.people = ["Priya Patel"]
        let applied = AppliedDateFilter(
            from: "2024-01-01T00:00:00.000Z",
            to: "2024-12-31T23:59:59.999Z",
            inferredFrom: "2024"
        )
        let chips = SearchActiveFilterChipsVM.chips(params: params, applied: applied, now: now)
        XCTAssertEqual(chips.count, 2)
        XCTAssertEqual(chips.first, .person("Priya Patel"))
        XCTAssertEqual(chips.last?.id, "inferred-date")
    }

    /// The wire form is a full ISO instant. `SearchDateFormat` parses
    /// `yyyy-MM-dd` and echoes anything else back untouched, so without
    /// trimming the chip would read "2024-01-01T00:00:00.000Z".
    func testInferredChipLabelIsFormattedNotRawIsoInstant() {
        let applied = AppliedDateFilter(
            from: "2024-01-01T00:00:00.000Z",
            to: "2024-12-31T23:59:59.999Z",
            inferredFrom: "2024"
        )
        let label = SearchActiveFilterChipsVM.inferredChip(applied, now: now).first?.label
        XCTAssertNotNil(label)
        XCTAssertFalse(label!.contains("T00:00"), "raw ISO instant leaked into the chip label")
    }

    /// An explicit window is already represented by the ordinary date chip;
    /// showing a second one for it would be a duplicate, not an explanation.
    func testNoInferredChipWhenTheWindowWasExplicit() {
        let applied = AppliedDateFilter(from: "2024-01-01T00:00:00.000Z", to: nil, inferredFrom: nil)
        XCTAssertEqual(SearchActiveFilterChipsVM.inferredChip(applied, now: now), [])
    }

    func testNoInferredChipWhenNoWindowApplied() {
        XCTAssertEqual(SearchActiveFilterChipsVM.inferredChip(nil, now: now), [])
    }

    /// The chip has to say WHY it is there — it is the only thing on screen
    /// attributing the filter to the user's own words.
    func testExplanationNamesTheSearchTextItCameFrom() {
        let applied = AppliedDateFilter(
            from: "2024-01-01T00:00:00.000Z",
            to: "2024-12-31T23:59:59.999Z",
            inferredFrom: "2024"
        )
        let chip = SearchActiveFilterChipsVM.inferredChip(applied, now: now).first
        XCTAssertNotNil(chip)
        XCTAssertTrue(SearchActiveFilterChipsVM.explanation(for: chip!)?.contains("2024") == true)
    }

    /// Only the derived chip is explained; the rest are the user's own
    /// choices and need no justification. This is also what the view keys
    /// off to decide whether to draw a clear button.
    func testUserSetChipsHaveNoExplanation() {
        XCTAssertNil(SearchActiveFilterChipsVM.explanation(for: .person("Priya Patel")))
        XCTAssertNil(SearchActiveFilterChipsVM.explanation(for: .date(label: "Last 7 days")))
    }

    // MARK: - SearchActiveFilterChipsVM.dateLabel

    func testDateLabelPrefersPresetName() {
        XCTAssertEqual(
            SearchActiveFilterChipsVM.dateLabel(from: "2026-06-15", to: "2026-06-15", now: now),
            "Today")
    }

    func testDateLabelFormatsCustomAndOneSidedRanges() {
        let custom = SearchActiveFilterChipsVM.dateLabel(
            from: "2026-06-01", to: "2026-06-15", now: now)
        XCTAssertEqual(custom,
            "\(SearchDateFormat.display("2026-06-01")) – \(SearchDateFormat.display("2026-06-15"))")
        XCTAssertEqual(
            SearchActiveFilterChipsVM.dateLabel(from: "2026-06-01", to: nil, now: now),
            "From \(SearchDateFormat.display("2026-06-01"))")
        XCTAssertEqual(
            SearchActiveFilterChipsVM.dateLabel(from: nil, to: "2026-06-15", now: now),
            "Until \(SearchDateFormat.display("2026-06-15"))")
        XCTAssertNil(SearchActiveFilterChipsVM.dateLabel(from: nil, to: nil, now: now))
    }
}

// AdjustmentGroupMergeTests.swift — unit tests for AdjustmentGroupMerge (#944).

import XCTest
@testable import MapleCore

final class AdjustmentGroupMergeTests: XCTestCase {

    // MARK: - A group's fields move; other groups' fields do not

    func testToneGroupMovesToneFieldsButNotColorFields() {
        var source = AdjustmentModel.default
        source.exposure = 1.5
        source.contrast = 20
        source.vibrance = 40 // .color, not .tone — must NOT move

        var target = AdjustmentModel.default
        target.exposure = -2.0
        target.contrast = -10
        target.vibrance = -10

        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.tone])

        XCTAssertEqual(merged.exposure, 1.5)
        XCTAssertEqual(merged.contrast, 20)
        XCTAssertEqual(merged.vibrance, -10, "Color group field must stay at the target's value")
    }

    func testColorGroupMovesColorFieldsButNotToneFields() {
        var source = AdjustmentModel.default
        source.vibrance = 40
        source.saturation = 30
        source.exposure = 3.0 // .tone, not .color — must NOT move

        var target = AdjustmentModel.default
        target.vibrance = -5
        target.exposure = -1.0

        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.color])

        XCTAssertEqual(merged.vibrance, 40)
        XCTAssertEqual(merged.saturation, 30)
        XCTAssertEqual(merged.exposure, -1.0, "Tone group field must stay at the target's value")
    }

    // MARK: - Full-group semantics (not sparse): source's default overwrites too

    func testPastingToneOverwritesEvenWhenSourceIsAtSchemaDefault() {
        let source = AdjustmentModel.default // exposure == 0, the schema default
        var target = AdjustmentModel.default
        target.exposure = 3.0

        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.tone])

        XCTAssertEqual(merged.exposure, 0, "Full-group paste must set the default, not skip it")
    }

    // MARK: - Unknown field names are skipped silently

    func testEmptyGroupSetLeavesTargetEntirelyUnchanged() {
        var source = AdjustmentModel.default
        source.exposure = 2
        source.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5)
        let target = AdjustmentModel.default

        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [])

        XCTAssertEqual(merged, target)
    }

    func testAllGroupsRoundTripsEquivalentToFullModelReplacement() {
        // Every named field across all six groups should move — this is a
        // sanity check that the fieldNames tables aren't missing scalars
        // that would silently leave stale target values behind.
        var source = AdjustmentModel.default
        source.exposure = 1.2
        source.vibrance = 22
        source.clarity = -8
        source.vignetteAmount = 15
        source.temperature = 5200
        source.crop = Crop(top: 0.05, left: 0.05, bottom: 0.95, right: 0.95, angle: 1.5)

        let target = AdjustmentModel.default
        let merged = AdjustmentGroupMerge.merged(
            target, applying: source, groups: Set(AdjustmentGroup.allCases)
        )

        XCTAssertEqual(merged.exposure, source.exposure)
        XCTAssertEqual(merged.vibrance, source.vibrance)
        XCTAssertEqual(merged.clarity, source.clarity)
        XCTAssertEqual(merged.vignetteAmount, source.vignetteAmount)
        XCTAssertEqual(merged.temperature, source.temperature)
        XCTAssertEqual(merged.crop, source.crop)
    }

    // MARK: - Crop moves only with .geometry

    func testCropOnlyMovesWithGeometryGroup() {
        var source = AdjustmentModel.default
        source.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5)
        let target = AdjustmentModel.default

        let withoutGeometry = AdjustmentGroupMerge.merged(
            target, applying: source,
            groups: [.whiteBalance, .tone, .color, .detail, .effects]
        )
        XCTAssertEqual(withoutGeometry.crop, Crop(), "Crop must not move without .geometry")

        let withGeometry = AdjustmentGroupMerge.merged(target, applying: source, groups: [.geometry])
        XCTAssertEqual(withGeometry.crop, source.crop)
    }

    // MARK: - White balance group (scalars + wb_scale_version)

    func testWhiteBalanceGroupMovesTemperatureTintAndScaleVersion() {
        var source = AdjustmentModel.default
        source.temperature = 5600
        source.tint = 12
        source.wbScaleVersion = 1

        var target = AdjustmentModel.default
        target.wbScaleVersion = 5

        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.whiteBalance])

        XCTAssertEqual(merged.temperature, 5600)
        XCTAssertEqual(merged.tint, 12)
        XCTAssertEqual(merged.wbScaleVersion, 1)
    }

    // MARK: - Enum-valued fields move with their owning group

    func testEnumValuedColorFieldsMoveWithColorGroup() {
        var source = AdjustmentModel.default
        source.highlightRecovery = .off       // default is .chromaticAdaptation
        source.profile = .neutral             // default is .auto
        source.look = .neutral                // default is .default

        let target = AdjustmentModel.default
        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.color])

        XCTAssertEqual(merged.highlightRecovery, .off)
        XCTAssertEqual(merged.profile, .neutral)
        XCTAssertEqual(merged.look, .neutral)
    }

    /// #276. `black_white` is the one Color-group field that is an enum with
    /// no numeric key path, so it reaches `applyFieldName`'s enum switch
    /// rather than the keypath fast path. Without an explicit case it fell
    /// through to `default` and was dropped, pasting the eight gray-mixer
    /// weights onto a target that still rendered in colour — the mode and
    /// its weights have to travel together or neither is meaningful.
    func testBlackWhiteModeMovesWithColorGroupAlongsideItsWeights() {
        var source = AdjustmentModel.default
        source.blackWhite = .on // default is .off
        source.grayMixerRed = 40
        source.grayMixerBlue = -25

        let target = AdjustmentModel.default
        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.color])

        XCTAssertEqual(merged.blackWhite, .on)
        XCTAssertEqual(merged.grayMixerRed, 40)
        XCTAssertEqual(merged.grayMixerBlue, -25)
    }

    /// The mirror direction: pasting Color from a colour source must clear a
    /// monochrome target, since the group patch is dense (a paste overwrites
    /// at the source's value even when that value is the schema default).
    func testColorGroupClearsBlackWhiteOnTheTarget() {
        let source = AdjustmentModel.default // blackWhite == .off
        var target = AdjustmentModel.default
        target.blackWhite = .on

        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.color])

        XCTAssertEqual(merged.blackWhite, .off)
    }

    func testEnumValuedToneFieldMovesWithToneGroup() {
        var source = AdjustmentModel.default
        source.autoExposure = .off // default is .on

        let target = AdjustmentModel.default
        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.tone])

        XCTAssertEqual(merged.autoExposure, .off)
    }

    func testEnumValuedDetailFieldMovesWithDetailGroup() {
        var source = AdjustmentModel.default
        source.hotPixelSuppression = .on // default is .off

        let target = AdjustmentModel.default
        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.detail])

        XCTAssertEqual(merged.hotPixelSuppression, .on)
    }

    // MARK: - Effects group

    func testEffectsGroupMovesVignetteAndGrainFields() {
        var source = AdjustmentModel.default
        source.vignetteAmount = -30
        source.vignetteFeather = 60
        source.grainAmount = 25
        source.grainSize = 40
        source.grainRoughness = 10

        let target = AdjustmentModel.default
        let merged = AdjustmentGroupMerge.merged(target, applying: source, groups: [.effects])

        XCTAssertEqual(merged.vignetteAmount, -30)
        XCTAssertEqual(merged.vignetteFeather, 60)
        XCTAssertEqual(merged.grainAmount, 25)
        XCTAssertEqual(merged.grainSize, 40)
        XCTAssertEqual(merged.grainRoughness, 10)
    }
}

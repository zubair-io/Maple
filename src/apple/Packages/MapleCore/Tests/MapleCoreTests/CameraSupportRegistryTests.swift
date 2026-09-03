// CameraSupportRegistryTests — the Apple consumer of the generated camera /
// lens support registry (#2440). The tiers themselves are computed in Rust
// (raw-core/src/support_tiers/) and emitted by tools/codegen.sh; these tests
// pin what the Apple shell relies on: a stable tier vocabulary, an
// explanation for every state the UI can show, the resolver mapping, and —
// the load-bearing one — that a tier is never hand-promoted.

import XCTest

@testable import MapleCore

final class CameraSupportRegistryTests: XCTestCase {
    func testTierVocabularyIsStableAndOrderedWorstToBest() {
        XCTAssertEqual(
            CameraTier.allCases.map(\.rawValue),
            ["unsupported", "decode_only", "matrix_only", "profiled", "qualified"]
        )
        XCTAssertLessThan(CameraTier.decodeOnly, CameraTier.matrixOnly)
        XCTAssertLessThan(CameraTier.matrixOnly, CameraTier.profiled)
        XCTAssertLessThan(CameraTier.profiled, CameraTier.qualified)
    }

    func testEveryTierAndLensStateExplainsItselfDistinctly() {
        // The explanation is the product surface: "why does this look off"
        // has to be answerable without the UI writing its own copy.
        let tierTexts = CameraTier.allCases.map(\.explanation)
        XCTAssertEqual(Set(tierTexts).count, tierTexts.count)
        XCTAssertFalse(tierTexts.contains(where: \.isEmpty))
        let lensTexts = LensSupport.allCases.map(\.explanation)
        XCTAssertEqual(Set(lensTexts).count, lensTexts.count)
        XCTAssertFalse(lensTexts.contains(where: \.isEmpty))
        XCTAssertFalse(CameraTier.allCases.map(\.label).contains(where: \.isEmpty))
    }

    func testResolverMappingCoversEveryBranch() {
        XCTAssertEqual(CameraSupportRegistry.tier(for: .embeddedFull), .profiled)
        XCTAssertEqual(CameraSupportRegistry.tier(for: .bundleConfident), .profiled)
        XCTAssertEqual(CameraSupportRegistry.tier(for: .embeddedCmOnly), .matrixOnly)
        XCTAssertEqual(CameraSupportRegistry.tier(for: .rawlerFallback), .decodeOnly)
        XCTAssertEqual(CameraSupportRegistry.tier(for: .decodeFailed), .unsupported)
    }

    func testFixturedBodiesAreUniqueAndConsistentWithTheirResolution() {
        let keys = CameraSupportRegistry.fixturedBodies.map(\.key)
        XCTAssertEqual(Set(keys).count, keys.count, "duplicate camera key")
        XCTAssertFalse(CameraSupportRegistry.fixturedBodies.isEmpty)
        for body in CameraSupportRegistry.fixturedBodies {
            XCTAssertFalse(body.displayName.isEmpty)
            XCTAssertFalse(body.fixture.isEmpty)
            // A body may be promoted above its resolution tier by evidence,
            // but never demoted below it, and never promoted past qualified.
            XCTAssertGreaterThanOrEqual(body.tier, CameraSupportRegistry.tier(for: body.resolution))
        }
    }

    func testQualifiedNeverAppearsWithoutTheResolverBackingIt() {
        // The generated table is the whole Qualified candidate set. A body
        // that resolves to a synthetic matrix or does not decode cannot be
        // qualified no matter what evidence exists.
        for body in CameraSupportRegistry.fixturedBodies where body.tier == .qualified {
            XCTAssertTrue(
                [.embeddedFull, .bundleConfident].contains(body.resolution),
                "`\(body.key)` claims qualified on \(body.resolution.rawValue)"
            )
        }
    }

    func testAnUnknownBodyAnswersFromTheResolverAlone() {
        // The ~1,400 bundled bodies and the long tail behind them are not in
        // the table; they still get a tier.
        XCTAssertEqual(
            CameraSupportRegistry.tier(forKey: "A Body We Have Never Heard Of", resolution: .bundleConfident),
            .profiled
        )
        XCTAssertGreaterThan(CameraSupportRegistry.bundledModelCount, 1_000)
    }

    func testAMeasuredBodyLosesItsPromotionWhenTheFileResolvesWorse() {
        guard let body = CameraSupportRegistry.fixturedBodies.first(where: { $0.tier == .qualified })
        else {
            // No body is qualified on this build (the honest state until a
            // colour-harness record is committed) — nothing to check.
            return
        }
        XCTAssertEqual(CameraSupportRegistry.tier(forKey: body.key, resolution: body.resolution), .qualified)
        XCTAssertEqual(
            CameraSupportRegistry.tier(forKey: body.key, resolution: .rawlerFallback),
            .decodeOnly
        )
    }
}

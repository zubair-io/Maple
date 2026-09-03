// CapabilityRegistryTests — the Apple consumer of the generated capability
// registry (#2430). The registry itself is reviewed Rust
// (raw-core/src/capability_registry/) emitted by tools/codegen.sh; these
// tests pin what the Apple shell relies on: stable ids, every Apple-shipped
// develop capability present, and a release state that is never asserted
// by hand — a capability with no Apple-covering evidence must not read
// `released`.

import XCTest

@testable import MapleCore

final class CapabilityRegistryTests: XCTestCase {
    func testIdsAreUniqueAndStable() {
        let ids = CapabilityRegistry.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "duplicate capability id")
        for expected in [
            "white_balance", "tone", "color", "detail", "effects", "geometry",
            "sidecar_persistence", "export",
        ] {
            XCTAssertTrue(ids.contains(expected), "registry lost `\(expected)`")
        }
    }

    func testEveryAppleShippedDevelopCapabilityDeclaresApple() {
        let apple = CapabilityRegistry.all.filter { $0.surfaces.contains(.apple) }.map(\.id)
        for id in ["white_balance", "tone", "color", "detail", "effects", "geometry", "inpaint_repair"] {
            XCTAssertTrue(apple.contains(id), "`\(id)` ships on Apple but is not declared for it")
        }
    }

    func testEveryAppleModelFieldHasACapabilityOwner() {
        // The reverse of raw-core's own coverage test: every scalar field the
        // Apple model exposes (the generated `FieldName` enum) is owned by
        // exactly one capability, so a new slider cannot ship on Apple
        // without a capability — and therefore an owner and an evidence
        // declaration — behind it.
        var owners: [String: [String]] = [:]
        for capability in CapabilityRegistry.all {
            for field in capability.fields {
                owners[field, default: []].append(capability.id)
            }
        }
        for field in AdjustmentModel.FieldName.allCases {
            XCTAssertEqual(owners[field.rawValue]?.count, 1, "`\(field.rawValue)` owners: \(owners[field.rawValue] ?? [])")
        }
    }

    func testReleasedRequiresAppleCoveringEvidence() {
        // Apple-covering sources are the only ones that can prove an Apple
        // surface; a record that reads `released` while shipping on Apple
        // must declare at least one of them in its qualification tier.
        let appleCovering: Set<CapabilityEvidenceSource> = [
            .sidecarContractApple, .gpuChainParityMetal, .appleCanvasGolden,
        ]
        for capability in CapabilityRegistry.all
        where capability.releaseState == .released && capability.surfaces.contains(.apple) {
            XCTAssertFalse(
                appleCovering.isDisjoint(with: capability.qualification),
                "`\(capability.id)` is released on Apple without Apple-covering evidence"
            )
        }
    }

    func testBuildIdentityIsPositive() {
        XCTAssertGreaterThan(CapabilityRegistry.pipelineOutputVersion, 0)
        XCTAssertGreaterThan(CapabilityRegistry.schemaVersion, 0)
    }
}

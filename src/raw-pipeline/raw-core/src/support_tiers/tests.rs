//! Registry invariants that need no fixtures (#2440).

use std::collections::BTreeSet;

use super::compute::collapse_indistinguishable_for_test;
use super::*;
use crate::capability_registry::{
    BuildIdentity, Evidence, EvidenceRecord, EvidenceSource, RecordStatus,
};

/// An evidence set in which `sources` are satisfied and nothing else is.
fn evidence_satisfying(sources: &[EvidenceSource]) -> Evidence {
    let build = BuildIdentity::current();
    let mut evidence = Evidence {
        build: Some(build),
        ..Evidence::default()
    };
    for source in sources {
        let expected = source.expected_cases();
        let backend = source.accepted_backends()[0].to_owned();
        let corpus_hash = format!("blake3:synthetic-{}", source.id());
        evidence.corpus_hashes.insert(*source, corpus_hash.clone());
        evidence.records.insert(
            *source,
            EvidenceRecord {
                source: *source,
                backend,
                pipeline_version: build.pipeline_version,
                schema_version: build.schema_version,
                corpus_hash,
                expected_cases: expected,
                executed_cases: expected,
                failed_cases: 0,
                skipped_cases: 0,
                git_sha: String::new(),
                recorded_at: String::new(),
                command: String::new(),
            },
        );
    }
    evidence
}

#[test]
fn every_fixtured_body_declares_a_distinct_fixture() {
    let fixtures: BTreeSet<&str> = FIXTURED_BODIES.iter().map(|b| b.fixture).collect();
    assert_eq!(
        fixtures.len(),
        FIXTURED_BODIES.len(),
        "two entries claim the same fixture file"
    );
    for body in FIXTURED_BODIES {
        assert!(!body.key.is_empty(), "{} has an empty key", body.fixture);
        assert!(
            !body.display_name.is_empty(),
            "{} has an empty display name",
            body.fixture
        );
    }
}

/// The resolver's fallback order, as documented, is exactly the order
/// `dcp::profile_for_with_source` tries its branches — and the tier ladder
/// is monotonic in it: an earlier branch never earns a worse tier.
#[test]
fn fallback_order_matches_resolver() {
    assert_eq!(
        PROFILE_FALLBACK_ORDER,
        &[
            ProfileResolution::EmbeddedFull,
            ProfileResolution::BundleConfident,
            ProfileResolution::EmbeddedCmOnly,
            ProfileResolution::RawlerFallback,
        ]
    );
    let tiers: Vec<CameraTier> = PROFILE_FALLBACK_ORDER
        .iter()
        .map(|r| tier_for_profile_source(*r))
        .collect();
    assert!(
        tiers.windows(2).all(|w| w[0] >= w[1]),
        "fallback order is not monotonic in tier: {tiers:?}"
    );
    assert_eq!(
        tier_for_profile_source(ProfileResolution::DecodeFailed),
        CameraTier::Unsupported
    );
}

/// Every tier and every lens state carries an explanation, and no two say
/// the same thing — the "deterministic user-facing explanation" acceptance
/// criterion is a property of the data, not of a UI file.
#[test]
fn every_tier_and_lens_state_has_a_distinct_explanation() {
    let tier_texts: BTreeSet<&str> = CameraTier::ALL.iter().map(|t| t.explanation()).collect();
    assert_eq!(tier_texts.len(), CameraTier::ALL.len());
    let tier_ids: BTreeSet<&str> = CameraTier::ALL.iter().map(|t| t.id()).collect();
    assert_eq!(tier_ids.len(), CameraTier::ALL.len());
    let lens_texts: BTreeSet<&str> = LensSupport::ALL.iter().map(|l| l.explanation()).collect();
    assert_eq!(lens_texts.len(), LensSupport::ALL.len());
    for tier in CameraTier::ALL {
        assert!(!tier.explanation().is_empty());
        assert!(!tier.label().is_empty());
    }
}

/// Nothing reaches `Qualified` without a satisfied record. This is the
/// "a release cannot promote a tier without passing its fixed
/// requirements" criterion, stated as a test over the real registry.
#[test]
fn no_body_is_qualified_without_evidence() {
    let registry = SupportRegistry::compute(&Evidence::default());
    assert!(
        registry.at_tier(CameraTier::Qualified).is_empty(),
        "a body reached Qualified with no evidence at all"
    );
    for body in &registry.bodies {
        assert_eq!(body.tier, tier_for_profile_source(body.resolution));
    }
}

/// …and every fixtured body that declares the colour harness *does* reach
/// `Qualified` once that harness is satisfied. Without this the test above
/// would pass on a registry that can never promote anything.
#[test]
fn colour_harness_evidence_promotes_the_profiled_bodies() {
    let evidence = evidence_satisfying(&[EvidenceSource::ColorHarness]);
    let registry = SupportRegistry::compute(&evidence);
    for body in &registry.bodies {
        let expected = if body.resolution == ProfileResolution::BundleConfident
            || body.resolution == ProfileResolution::EmbeddedFull
        {
            CameraTier::Qualified
        } else {
            tier_for_profile_source(body.resolution)
        };
        assert_eq!(
            body.tier, expected,
            "{} ({}) landed on {:?}",
            body.display_name, body.fixture, body.tier
        );
    }
    assert!(!registry.at_tier(CameraTier::Qualified).is_empty());
}

/// A failing case in an otherwise-current record demotes rather than
/// promotes, and the classification says which source held the body back.
#[test]
fn a_failed_case_holds_a_body_back_and_says_so() {
    let mut evidence = evidence_satisfying(&[EvidenceSource::ColorHarness]);
    if let Some(record) = evidence.records.get_mut(&EvidenceSource::ColorHarness) {
        record.failed_cases = 14;
    }
    let registry = SupportRegistry::compute(&evidence);
    assert!(registry.at_tier(CameraTier::Qualified).is_empty());
    let held = registry
        .bodies
        .iter()
        .find(|b| b.resolution == ProfileResolution::BundleConfident)
        .expect("a bundle-confident body");
    assert_eq!(held.tier, CameraTier::Profiled);
    assert!(held
        .findings
        .iter()
        .any(|f| f.status == RecordStatus::Failed(14)));
    assert!(held
        .reasons
        .iter()
        .any(|r| matches!(r, TierReason::HeldBack(_))));
}

/// Not being promoted has three distinct causes, and the classification
/// says which one applies rather than collapsing them into "not qualified".
#[test]
fn each_way_of_not_being_promoted_is_reported_separately() {
    let evidence = evidence_satisfying(&[EvidenceSource::ColorHarness]);
    let registry = SupportRegistry::compute(&evidence);
    for body in &registry.bodies {
        let declares = !body.findings.is_empty();
        let promotable = tier_for_profile_source(body.resolution) == CameraTier::Profiled;
        let expected_reason = match (declares, promotable) {
            (false, _) => TierReason::NoQualificationDeclared,
            (true, false) => TierReason::NotPromotableFromResolution(body.resolution),
            (true, true) => TierReason::QualifiedBy(&[EvidenceSource::ColorHarness]),
        };
        assert!(
            body.reasons.contains(&expected_reason),
            "{} ({}) reported {:?}",
            body.display_name,
            body.fixture,
            body.reasons
        );
    }
    // The H5D-40 is the case Copilot caught on #3314: it DOES declare the
    // colour harness, so "no qualification declared" would have been a lie.
    let fallback = registry
        .bodies
        .iter()
        .find(|b| b.resolution == ProfileResolution::RawlerFallback)
        .expect("a rawler-fallback body");
    assert!(!fallback.findings.is_empty());
    assert!(!fallback
        .reasons
        .contains(&TierReason::NoQualificationDeclared));
}

/// The Foveon fixture declares no qualification source, so it can never be
/// promoted — and it is `Unsupported`, not `DecodeOnly`.
#[test]
fn an_undecodable_body_stays_unsupported_under_any_evidence() {
    let evidence = evidence_satisfying(EvidenceSource::ALL);
    let registry = SupportRegistry::compute(&evidence);
    let foveon = registry
        .bodies
        .iter()
        .find(|b| b.fixture == "test_0016.X3F")
        .expect("the Foveon fixture");
    assert_eq!(foveon.tier, CameraTier::Unsupported);
    assert!(!foveon.tier.is_renderable());
    assert!(foveon.findings.is_empty());
}

/// Two entries that share a lookup key are indistinguishable to the
/// resolver, so the registry reports the worse of their tiers for both.
#[test]
fn indistinguishable_bodies_collapse_to_the_worst() {
    let evidence = evidence_satisfying(&[EvidenceSource::ColorHarness]);
    let good = FixturedBody {
        key: "Acme Shared Body",
        display_name: "Acme, firmware 1.0",
        fixture: "synthetic_a.dng",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: &[EvidenceSource::ColorHarness],
    };
    let bad = FixturedBody {
        key: "Acme Shared Body",
        display_name: "Acme, firmware 2.0",
        fixture: "synthetic_b.dng",
        resolution: ProfileResolution::RawlerFallback,
        ..good
    };
    let alone = classify_body(&good, &evidence);
    assert_eq!(alone.tier, CameraTier::Qualified);

    let collapsed = collapse_indistinguishable_for_test(vec![
        classify_body(&good, &evidence),
        classify_body(&bad, &evidence),
    ]);
    assert_eq!(collapsed.len(), 1, "the shared key did not collapse");
    assert_eq!(collapsed[0].tier, CameraTier::DecodeOnly);
    assert!(collapsed[0].reasons.iter().any(|r| matches!(
        r,
        TierReason::IndistinguishableWith(siblings)
            if siblings.contains(&"synthetic_a.dng") && siblings.contains(&"synthetic_b.dng")
    )));
}

/// The bundled table is what makes the ~1,400 unmeasured bodies
/// `Profiled` rather than nothing, so the registry must actually read it.
#[test]
fn the_bundled_model_list_is_populated_and_sorted() {
    let registry = SupportRegistry::compute(&Evidence::default());
    assert!(
        registry.bundled_models.len() > 1_000,
        "only {} bundled models",
        registry.bundled_models.len()
    );
    assert!(registry.bundled_models.windows(2).all(|w| w[0] <= w[1]));
    let unique: BTreeSet<&str> = registry.bundled_models.iter().copied().collect();
    assert_eq!(unique.len(), registry.bundled_models.len());
}

/// `tier_for` never reports better than what the resolver actually found
/// for the file in hand: a `Qualified` body whose specific file falls back
/// to a synthetic matrix is reported at the file's tier, not the body's.
#[test]
fn tier_for_never_over_claims_against_the_resolved_file() {
    let evidence = evidence_satisfying(&[EvidenceSource::ColorHarness]);
    let registry = SupportRegistry::compute(&evidence);
    let qualified = registry
        .at_tier(CameraTier::Qualified)
        .first()
        .map(|b| (b.key, b.resolution))
        .expect("a qualified body");
    assert_eq!(
        registry.tier_for(qualified.0, qualified.1),
        CameraTier::Qualified
    );
    assert_eq!(
        registry.tier_for(qualified.0, ProfileResolution::RawlerFallback),
        CameraTier::DecodeOnly
    );
    assert_eq!(
        registry.tier_for(
            "A Body We Have Never Heard Of",
            ProfileResolution::EmbeddedCmOnly
        ),
        CameraTier::MatrixOnly
    );
}

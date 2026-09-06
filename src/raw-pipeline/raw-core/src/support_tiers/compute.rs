//! Turning declarations plus evidence into tiers (#2440).
//!
//! Two entry points, one rule between them:
//!
//! - [`tier_for_profile_source`] is the render-time answer for *any* camera,
//!   fixtured or not: the resolver already picked a branch, and the branch
//!   is the tier. Total, allocation-free, no I/O.
//! - [`SupportRegistry::compute`] is the build-time answer for the fixture
//!   corpus: the same mapping, plus promotion to
//!   [`Qualified`](CameraTier::Qualified) when every suite covering the body
//!   has a satisfied record.
//!
//! Nothing in either path can promote a body without a record, and both
//! collapse metadata-indistinguishable bodies to the most conservative
//! tier.

use std::collections::BTreeMap;

use crate::capability_registry::{judge, Evidence, EvidenceSource, Finding};
use crate::color::dcp::ProfileSource;

use super::{
    CameraTier, FixturedBody, LensSupport, ProfileResolution, FIXTURED_BODIES,
    SUPPORT_TIER_SCHEMA_VERSION,
};

/// The tier a resolver outcome earns before any measured evidence.
///
/// This is the entire lower half of the tier ladder, and it is a total
/// function of [`ProfileResolution`] — which is why a body cannot be
/// hand-promoted into `Profiled` any more than into `Qualified`.
pub const fn tier_for_profile_source(resolution: ProfileResolution) -> CameraTier {
    match resolution {
        ProfileResolution::EmbeddedFull | ProfileResolution::BundleConfident => {
            CameraTier::Profiled
        }
        ProfileResolution::EmbeddedCmOnly => CameraTier::MatrixOnly,
        ProfileResolution::RawlerFallback => CameraTier::DecodeOnly,
        ProfileResolution::DecodeFailed => CameraTier::Unsupported,
    }
}

/// The payload-free view of a resolver outcome.
impl From<&ProfileSource> for ProfileResolution {
    fn from(source: &ProfileSource) -> Self {
        match source {
            ProfileSource::EmbeddedFull { .. } => ProfileResolution::EmbeddedFull,
            ProfileSource::BundleConfident => ProfileResolution::BundleConfident,
            ProfileSource::EmbeddedCmOnly { .. } => ProfileResolution::EmbeddedCmOnly,
            ProfileSource::RawlerFallback => ProfileResolution::RawlerFallback,
        }
    }
}

/// Why a body landed on the tier it did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TierReason {
    /// The format does not decode.
    DecodeUnsupported,
    /// The resolver's branch, with no measured evidence in play.
    Resolution(ProfileResolution),
    /// Promoted: every declared suite is satisfied on this build.
    QualifiedBy(&'static [EvidenceSource]),
    /// Held back at the resolver tier because a declared suite is not
    /// satisfied. Carries the same [`Finding`] set the capability registry
    /// prints, so the summary can say exactly which record is missing or
    /// stale rather than "not qualified".
    HeldBack(Vec<Finding>),
    /// No suite declares this body, so there is nothing that could promote
    /// it. Silence is not evidence.
    NoQualificationDeclared,
    /// The body declares qualification sources, but its resolver branch
    /// cannot reach [`Qualified`](CameraTier::Qualified) however good the
    /// evidence is: measuring a render that has no real calibration behind
    /// it would qualify the measurement, not the camera.
    NotPromotableFromResolution(ProfileResolution),
    /// Collapsed to the worst tier of several bodies that share a lookup
    /// key and cannot be told apart from metadata.
    IndistinguishableWith(Vec<&'static str>),
}

/// One body's computed state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodyClassification {
    pub key: &'static str,
    pub display_name: &'static str,
    pub fixture: &'static str,
    pub tier: CameraTier,
    pub lens: LensSupport,
    pub resolution: ProfileResolution,
    /// Every reason, in the order they applied. Never empty.
    pub reasons: Vec<TierReason>,
    /// The per-source verdicts for the suites this body declares — the
    /// immutable evidence link the ticket asks each entry to carry.
    pub findings: Vec<Finding>,
}

/// Compute one body's tier from its declaration and the evidence on disk.
pub fn classify_body(body: &FixturedBody, evidence: &Evidence) -> BodyClassification {
    let base = tier_for_profile_source(body.resolution);
    let findings: Vec<Finding> = body
        .qualification
        .iter()
        .map(|source| Finding {
            source: *source,
            status: judge(*source, evidence),
        })
        .collect();
    // Three distinct ways not to be promoted, and they are not
    // interchangeable: a body nobody measures, a body that cannot benefit
    // from being measured, and a body whose measurement did not pass. Only
    // the last one is a call to action.
    let promotable = base == CameraTier::Profiled;
    let all_satisfied = !findings.is_empty() && findings.iter().all(|f| f.status.is_satisfied());
    let (tier, promotion_reason) = match (promotable, findings.is_empty(), all_satisfied) {
        (_, true, _) => (base, TierReason::NoQualificationDeclared),
        (false, _, _) => (
            base,
            TierReason::NotPromotableFromResolution(body.resolution),
        ),
        (true, false, true) => (
            CameraTier::Qualified,
            TierReason::QualifiedBy(body.qualification),
        ),
        (true, false, false) => (base, TierReason::HeldBack(findings.clone())),
    };
    let base_reason = if body.resolution == ProfileResolution::DecodeFailed {
        TierReason::DecodeUnsupported
    } else {
        TierReason::Resolution(body.resolution)
    };
    BodyClassification {
        key: body.key,
        display_name: body.display_name,
        fixture: body.fixture,
        tier,
        lens: body.lens,
        resolution: body.resolution,
        reasons: vec![base_reason, promotion_reason],
        findings,
    }
}

/// The whole registry for one build.
#[derive(Clone, Debug)]
pub struct SupportRegistry {
    /// Version of the tier vocabulary these entries were computed under.
    pub schema_version: u32,
    /// One entry per fixtured body, sorted by lookup key.
    pub bodies: Vec<BodyClassification>,
    /// Every `UniqueCameraModel` the bundled profile table covers, sorted.
    /// Each is at least [`Profiled`](CameraTier::Profiled) by construction:
    /// the bundle entry *is* the calibration.
    pub bundled_models: Vec<&'static str>,
    /// The profile bundle's binary format version.
    pub profile_bundle_format: u16,
    /// `blake3:<hex>` over the profile bundle's bytes — the profile version
    /// every entry in this registry was computed against.
    pub profile_bundle_digest: String,
}

impl SupportRegistry {
    /// Compute the registry for the current build.
    ///
    /// `evidence` is the same record set the capability registry reads
    /// (`test-fixtures/qualification/`), so a build whose colour harness
    /// has not been re-recorded demotes both registries together rather
    /// than one of them silently disagreeing with the other.
    pub fn compute(evidence: &Evidence) -> Self {
        let bundle_version = crate::color::profile_loader::bundled_profile_version();
        let classified: Vec<BodyClassification> = FIXTURED_BODIES
            .iter()
            .map(|body| classify_body(body, evidence))
            .collect();
        Self {
            schema_version: SUPPORT_TIER_SCHEMA_VERSION,
            bodies: collapse_indistinguishable(classified),
            bundled_models: crate::color::profile_loader::bundled_camera_models(),
            profile_bundle_format: bundle_version.0,
            profile_bundle_digest: bundle_version.1,
        }
    }

    /// Bodies at exactly `tier`.
    pub fn at_tier(&self, tier: CameraTier) -> Vec<&BodyClassification> {
        self.bodies.iter().filter(|b| b.tier == tier).collect()
    }

    /// The tier for the file in hand: the body's lookup key plus whatever
    /// branch the resolver actually took for *this* file.
    ///
    /// A body Maple has measured answers from the registry, so the
    /// `Qualified` promotion is visible. But the promotion is only good
    /// for a file that resolves as well as the measured one did: a file
    /// from a qualified body that falls back to a synthetic matrix (a
    /// corrupt profile tag, `MAPLE_DISABLE_BUNDLED_PROFILES`) is reported
    /// at the file's own tier. An unknown body answers from the resolver
    /// alone, which is the ~1,400-bundled-body case and the long tail
    /// behind it.
    ///
    /// This is what a surface calls once per opened asset to decide
    /// whether to show a support explanation.
    pub fn tier_for(&self, key: &str, resolution: ProfileResolution) -> CameraTier {
        let resolved = tier_for_profile_source(resolution);
        self.bodies
            .iter()
            .find(|b| b.key == key)
            .filter(|b| resolved >= tier_for_profile_source(b.resolution))
            .map(|b| b.tier.max(resolved))
            .unwrap_or(resolved)
    }
}

/// Test hook for [`collapse_indistinguishable`], which is only reachable
/// through [`SupportRegistry::compute`] otherwise — and the real corpus has
/// no key collision to exercise it with.
#[cfg(test)]
pub(super) fn collapse_indistinguishable_for_test(
    classified: Vec<BodyClassification>,
) -> Vec<BodyClassification> {
    collapse_indistinguishable(classified)
}

/// Most-conservative-tier-wins, the policy for bodies that report the same
/// `UniqueCameraModel` but are not the same thing — two firmware revisions
/// with different real-world calibration, or two bodies a vendor ships
/// under one metadata string.
///
/// The resolver keys on that string and has no version dimension, so it
/// would hand both bodies the same profile. The registry therefore refuses
/// to claim the better of the two states for either: entries sharing a key
/// collapse into one at the minimum tier, each naming the fixtures that
/// forced it. No such collision exists in today's corpus — the policy is
/// implemented and tested rather than left implicit, so the first one that
/// appears is handled instead of silently over-claiming.
fn collapse_indistinguishable(classified: Vec<BodyClassification>) -> Vec<BodyClassification> {
    let mut by_key: BTreeMap<&'static str, Vec<BodyClassification>> = BTreeMap::new();
    for entry in classified {
        by_key.entry(entry.key).or_default().push(entry);
    }
    by_key
        .into_values()
        .map(|group| {
            let Some((first, rest)) = group.split_first() else {
                unreachable!("a key group is never empty");
            };
            if rest.is_empty() {
                return first.clone();
            }
            let worst = group
                .iter()
                .map(|e| e.tier)
                .fold(CameraTier::Qualified, CameraTier::min);
            let siblings: Vec<&'static str> = group.iter().map(|e| e.fixture).collect();
            let winner = group
                .iter()
                .find(|e| e.tier == worst)
                .unwrap_or(first)
                .clone();
            BodyClassification {
                tier: worst,
                reasons: winner
                    .reasons
                    .iter()
                    .cloned()
                    .chain(std::iter::once(TierReason::IndistinguishableWith(siblings)))
                    .collect(),
                ..winner
            }
        })
        .collect()
}

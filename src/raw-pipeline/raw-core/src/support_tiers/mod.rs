//! Camera and lens support tiers, computed from qualification evidence
//! (#2440, `docs/strategy/milestones/m4-color-output.md` § 3.2).
//!
//! Before this module, "Maple supports your camera" meant exactly one
//! thing: rawler could decode the file. Whether Maple had any calibration
//! for that sensor, and whether anyone had ever measured the result, were
//! invisible — [`ProfileSource`] resolved one of four outcomes silently at
//! render time and logged a line to stderr on the worst of them.
//!
//! The registry here makes that state a product fact:
//!
//! | Tier | What it means |
//! | --- | --- |
//! | [`Qualified`](CameraTier::Qualified) | Maple holds a physical fixture for this body and every qualification suite covering it passes on the current build |
//! | [`Profiled`](CameraTier::Profiled) | Real calibration data resolves — the vendor's own complete profile, or a bundled externally-calibrated one — but nothing has been measured |
//! | [`MatrixOnly`](CameraTier::MatrixOnly) | Only the file's own colour matrix; no hue/sat calibration, no bundle entry |
//! | [`DecodeOnly`](CameraTier::DecodeOnly) | Decodes, but no calibration at all — a synthetic D65 matrix, "wrong but bounded" |
//! | [`Unsupported`](CameraTier::Unsupported) | The format cannot be decoded |
//!
//! Lens support is a **separate axis** ([`LensSupport`]) and never inherits
//! from the camera tier. This registry reports embedded `OpcodeList3`
//! data only; external profile availability is resolved separately by
//! [`crate::lens_profile`], including the bundled Lensfun database.
//!
//! ## Nothing here is asserted
//!
//! The four lower tiers are a total function of the profile resolver's own
//! fallback order ([`PROFILE_FALLBACK_ORDER`]) — [`tier_for_profile_source`]
//! is the whole mapping, and `tests::fallback_order_matches_resolver`
//! pins it against `dcp::profile_for_with_source`. Promotion to
//! `Qualified` is a total function of the committed evidence records under
//! `test-fixtures/qualification/`, judged by the same
//! [`judge`](crate::capability_registry::judge) the capability registry
//! uses (#2430): a pipeline-version bump, a corpus edit, a missing record
//! or a single failed case demotes the body on the next `tools/codegen.sh`
//! run, and `codegen-drift` then blocks until the demotion is committed.
//!
//! There is no hand-written tier anywhere in this file. What *is* reviewed
//! data is the fixture corpus in [`FIXTURED_BODIES`] — which physical file
//! is which body, what the resolver finds in it, and which suites cover it
//! — and every one of those declarations is verified against a real decode
//! by the fixture-gated `fixture_tests`.

mod compute;
mod render_support;
pub use render_support::RenderSupport;
#[cfg(test)]
mod fixture_tests;
#[cfg(test)]
mod tests;

pub use compute::{
    classify_body, tier_for_profile_source, BodyClassification, SupportRegistry, TierReason,
};

use crate::capability_registry::EvidenceSource;

/// Version of the tier vocabulary and the promotion rule. Bumped when a
/// tier is added, removed, or redefined, or when [`PROFILE_FALLBACK_ORDER`]
/// changes — a consumer that pins a different version is reading a
/// registry whose words mean something else.
pub const SUPPORT_TIER_SCHEMA_VERSION: u32 = 1;

/// A camera body's support state. Ordered worst to best so
/// [`CameraTier::min`] can implement the most-conservative-wins policy for
/// bodies that are indistinguishable from their metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CameraTier {
    /// The format cannot be decoded at all. Not a colour-pipeline state:
    /// the file never reaches the develop chain.
    Unsupported,
    /// Decodes, but neither the file nor the bundle carries usable
    /// calibration, so the pipeline substitutes a synthetic
    /// XYZ-D65 → Rec.2020 matrix.
    DecodeOnly,
    /// The file's own `ColorMatrix` (optionally with a `ForwardMatrix`)
    /// is used — internally consistent with the sensor, but no hue/sat
    /// calibration and no bundle entry.
    MatrixOnly,
    /// Real calibration resolves: either the vendor's own complete
    /// embedded profile, or a byte-exact hit in the bundled
    /// externally-calibrated profile table.
    Profiled,
    /// `Profiled`, plus Maple holds a physical fixture for this body and
    /// every qualification suite that covers it is satisfied on the
    /// current build.
    Qualified,
}

impl CameraTier {
    /// Every tier, worst to best.
    pub const ALL: &'static [CameraTier] = &[
        CameraTier::Unsupported,
        CameraTier::DecodeOnly,
        CameraTier::MatrixOnly,
        CameraTier::Profiled,
        CameraTier::Qualified,
    ];

    /// Stable snake_case identifier for the generated surfaces.
    pub const fn id(self) -> &'static str {
        match self {
            CameraTier::Unsupported => "unsupported",
            CameraTier::DecodeOnly => "decode_only",
            CameraTier::MatrixOnly => "matrix_only",
            CameraTier::Profiled => "profiled",
            CameraTier::Qualified => "qualified",
        }
    }

    /// Short label for a badge or a list row.
    pub const fn label(self) -> &'static str {
        match self {
            CameraTier::Unsupported => "Unsupported",
            CameraTier::DecodeOnly => "Decode only",
            CameraTier::MatrixOnly => "Matrix only",
            CameraTier::Profiled => "Profiled",
            CameraTier::Qualified => "Qualified",
        }
    }

    /// The deterministic user-facing explanation. One fixed sentence per
    /// tier — the answer to "why does this look off", available on every
    /// surface without any of them writing their own copy.
    pub const fn explanation(self) -> &'static str {
        match self {
            CameraTier::Unsupported => {
                "Maple cannot decode this file format, so it cannot be edited or exported."
            }
            CameraTier::DecodeOnly => {
                "Maple can read this camera's files but has no colour calibration for its sensor, \
                 so colours are approximate. Editing and export work; expect a cast, and expect \
                 it to change if calibration is added later."
            }
            CameraTier::MatrixOnly => {
                "Maple is using the colour matrix embedded in the file itself. Neutrals and \
                 overall colour are calibrated; saturated colours are not, because this camera \
                 has no hue and saturation calibration in Maple's profile set."
            }
            CameraTier::Profiled => {
                "Maple has full colour calibration for this camera, but its required colour \
                 qualification evidence is incomplete or does not pass for the current build."
            }
            CameraTier::Qualified => {
                "Maple has full colour calibration for this camera and measures every release \
                 against a reference render of a physical sample of this body."
            }
        }
    }

    /// Whether this tier renders pixels at all.
    pub const fn is_renderable(self) -> bool {
        !matches!(self, CameraTier::Unsupported)
    }

    /// The more conservative of two tiers. This is the whole policy for
    /// bodies whose metadata cannot tell them apart — see the module
    /// docs and `tests::indistinguishable_bodies_collapse_to_the_worst`.
    pub fn min(self, other: CameraTier) -> CameraTier {
        if self <= other {
            self
        } else {
            other
        }
    }
}

/// Whether a body's files carry embedded lens-correction data. An axis of
/// its own: camera qualification does not imply embedded `OpcodeList3`
/// data. External profiles, including bundled Lensfun matches, are resolved
/// separately and are not represented by this field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LensSupport {
    /// The file carries an `OpcodeList3` Maple parses — distortion,
    /// vignette and chromatic-aberration correction come from the vendor.
    EmbeddedCorrection,
    /// The file carries no lens-correction opcodes. An explicit profile
    /// or automatic bundled Lensfun match may still supply corrections.
    NoCorrectionData,
}

impl LensSupport {
    pub const ALL: &'static [LensSupport] = &[
        LensSupport::EmbeddedCorrection,
        LensSupport::NoCorrectionData,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            LensSupport::EmbeddedCorrection => "embedded_correction",
            LensSupport::NoCorrectionData => "no_correction_data",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            LensSupport::EmbeddedCorrection => "Embedded correction",
            LensSupport::NoCorrectionData => "No embedded correction data",
        }
    }

    /// The deterministic user-facing explanation for the lens axis.
    pub const fn explanation(self) -> &'static str {
        match self {
            LensSupport::EmbeddedCorrection => {
                "This camera writes the lens's own distortion, vignette and chromatic-aberration \
                 correction into the file, and Maple applies it."
            }
            LensSupport::NoCorrectionData => {
                "No embedded lens corrections are recorded for this file. Maple may still \
                 apply an explicitly selected profile or an automatic match from its bundled \
                 Lensfun database; this status does not describe external profile availability."
            }
        }
    }
}

/// Which branch of the profile resolver won. A `Copy`, data-only mirror of
/// [`crate::color::dcp::ProfileSource`] without its illuminant payload —
/// the tier depends on the branch, never on which illuminant it landed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProfileResolution {
    /// The file ships `ColorMatrix` + `ForwardMatrix` + `ProfileHueSatMap`.
    EmbeddedFull,
    /// Byte-exact `UniqueCameraModel` (or alias) hit in the bundled
    /// externally-calibrated profile table.
    BundleConfident,
    /// The file ships a `ColorMatrix` but no hue/sat map, and the bundle
    /// has no entry.
    EmbeddedCmOnly,
    /// Neither. The pipeline substitutes a synthetic XYZ-D65 → Rec.2020
    /// matrix.
    RawlerFallback,
    /// The file could not be decoded.
    DecodeFailed,
}

impl ProfileResolution {
    pub const fn id(self) -> &'static str {
        match self {
            ProfileResolution::EmbeddedFull => "embedded_full",
            ProfileResolution::BundleConfident => "bundle_confident",
            ProfileResolution::EmbeddedCmOnly => "embedded_cm_only",
            ProfileResolution::RawlerFallback => "rawler_fallback",
            ProfileResolution::DecodeFailed => "decode_failed",
        }
    }
}

/// The resolver's fallback order, best evidence first. Versioned by
/// [`SUPPORT_TIER_SCHEMA_VERSION`] and pinned against the real resolver by
/// `tests::fallback_order_matches_resolver`, so the registry cannot drift
/// from what `dcp::profile_for_with_source` actually does.
pub const PROFILE_FALLBACK_ORDER: &[ProfileResolution] = &[
    ProfileResolution::EmbeddedFull,
    ProfileResolution::BundleConfident,
    ProfileResolution::EmbeddedCmOnly,
    ProfileResolution::RawlerFallback,
];

/// One camera body Maple holds a physical fixture for.
///
/// Everything here except `qualification` is a statement about the file on
/// disk, verified against a real decode by `fixture_tests`. `qualification`
/// is the reviewed declaration of which suites' corpora contain this body —
/// the only lever a human pulls, and pulling it does not promote anything
/// on its own: the record still has to be satisfied.
#[derive(Clone, Copy, Debug)]
pub struct FixturedBody {
    /// The `UniqueCameraModel` the profile resolver keys on.
    pub key: &'static str,
    /// Marketing name, for the human-readable summary.
    pub display_name: &'static str,
    /// Filename under `test-fixtures/raws/`.
    pub fixture: &'static str,
    /// Immutable BLAKE3 content identity of the declared physical sample (#4080).
    pub fixture_digest: &'static str,
    /// Which resolver branch this fixture takes.
    pub resolution: ProfileResolution,
    /// Lens axis for this fixture's file.
    pub lens: LensSupport,
    /// Suites whose corpus contains this body. Empty means "no suite
    /// measures this body", and the body can never reach `Qualified` —
    /// silence is not evidence.
    pub qualification: &'static [EvidenceSource],
}

/// The suites that measure a body's rendered colour against a reference.
/// Declared once here rather than repeated on every entry: every fixture in
/// `test-fixtures/raws/` is a case in the ACR harness's manifest, so they
/// all carry the same requirement, and a body reaches `Qualified` only when
/// that harness has a satisfied record on the current build.
const COLOUR_QUALIFICATION: &[EvidenceSource] = &[EvidenceSource::ColorHarness];

/// A body that is decodable but has no reference render — the Foveon
/// fixture. Declaring no source is what keeps it out of `Qualified`.
const NO_QUALIFICATION: &[EvidenceSource] = &[];

/// Every camera body Maple holds a physical fixture for.
///
/// This is the whole `Qualified` candidate set: no other body can ever
/// reach that tier, because no other body has a file to measure. The
/// remaining ~1,400 bundled bodies classify as `Profiled` from the bundle
/// index alone, and everything else classifies at render time through
/// [`tier_for_profile_source`].
pub const FIXTURED_BODIES: &[FixturedBody] = &[
    FixturedBody {
        key: "Hasselblad L3D-100c",
        display_name: "DJI Mavic 3 Pro (Hasselblad L3D-100c, 100 MP)",
        fixture: "test_0000.DNG",
        fixture_digest: "blake3:fed0379afc16033a471279c7391b572b19572ab03d058feebbd16bf3a21f7107",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::EmbeddedCorrection,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Panasonic DMC-LX2",
        display_name: "Panasonic Lumix DMC-LX2",
        fixture: "test_0001.RAW",
        fixture_digest: "blake3:5adffbb3b5be7db37e5ae87a11d0f9918d7d0ca93b61fff89d1e63572ff04031",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Hasselblad H2D-39",
        display_name: "Hasselblad H2D-39",
        fixture: "test_0002.dng",
        fixture_digest: "blake3:220c6f28339dd600e1f7eea7ee9ee85be4ebee3e3ade7d74275c08d85f53b61c",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Canon EOS 5DS R",
        display_name: "Canon EOS 5DS R",
        fixture: "test_0003.CR2",
        fixture_digest: "blake3:6d0c97a5fc810dc89d8ced77b4abf9edcd1aa422b7f7ba9a471f9ce055df6703",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Hasselblad H5D-40",
        display_name: "Hasselblad H5D-40",
        fixture: "test_0004.fff",
        fixture_digest: "blake3:890012a018f8ae950d449cd7828e6de999ac786e7d8ccc3cf56ac82c5c566ded",
        resolution: ProfileResolution::RawlerFallback,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Fujifilm GFX 50S",
        display_name: "Fujifilm GFX 50S",
        fixture: "test_0005.RAF",
        fixture_digest: "blake3:b79a13398f1442e3fb2e56ce2d3c803a0fc811906c9dbe519c98116d75d61857",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Canon EOS 5D Mark III",
        display_name: "Canon EOS 5D Mark III",
        fixture: "test_0006.DNG",
        fixture_digest: "blake3:3bb09ec615751cebb9d5a12ff343bdf742c4ad10b58c3da675f55a8bd0f26978",
        resolution: ProfileResolution::EmbeddedFull,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Fujifilm X-T3",
        display_name: "Fujifilm X-T3 (X-Trans)",
        fixture: "test_0008.RAF",
        fixture_digest: "blake3:318b17b8aa59e87fb56dbcce49b26315cc4ba59cd7b8e21868b854bb6ead5fff",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Canon EOS 5D Mark IV",
        display_name: "Canon EOS 5D Mark IV",
        fixture: "test_0009.CR2",
        fixture_digest: "blake3:6dfa394ef79f8e4ccbc18ba44623534785a8e173dc13bbffe78d1c667004add8",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Sony ILCE-7RM4",
        display_name: "Sony α7R IV",
        fixture: "test_0011.ARW",
        fixture_digest: "blake3:3aef6986a8f81a0bed55c134c5e1758ecf3f7ccaf072bb7439191b7ddbda4663",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Fujifilm GFX 50R",
        display_name: "Fujifilm GFX 50R",
        fixture: "test_0012.raf",
        fixture_digest: "blake3:1d10d338c8536257f01defa7a7595cc122def250fffb6d8de76a32e153b27229",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "iPhone13,3 back camera",
        display_name: "Apple iPhone 12 Pro (back camera)",
        fixture: "test_0013.DNG",
        fixture_digest: "blake3:823db2fb2d3d9c8e01c501e20f399a2aab62342da2ee5c39b125e2e2e1bba61b",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Nikon D850",
        display_name: "Nikon D850",
        fixture: "test_0014.NEF",
        fixture_digest: "blake3:bd88324bf65124db228f187018ef59ed7684ea79c9bfcf3c5d2c0eabe157bb8c",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Google Pixel 6 Pro",
        display_name: "Google Pixel 6 Pro (rear main camera)",
        fixture: "test_0015.dng",
        fixture_digest: "blake3:7a1b8b7cb6d181339d68e80aaded7e3c84675cfe90b644955725cc95df38c152",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::EmbeddedCorrection,
        qualification: COLOUR_QUALIFICATION,
    },
    FixturedBody {
        key: "Sigma Foveon X3F",
        display_name: "Sigma Foveon (X3F)",
        fixture: "test_0016.X3F",
        fixture_digest: "blake3:125210865382458bef10a5d312e7eefbbb801c4d2567a3780eae0d2c826f46f4",
        resolution: ProfileResolution::DecodeFailed,
        lens: LensSupport::NoCorrectionData,
        qualification: NO_QUALIFICATION,
    },
    FixturedBody {
        key: "LEICA M10",
        display_name: "Leica M10",
        fixture: "test_0017.dng",
        fixture_digest: "blake3:030ce28a7ba895d7f816b4eac19eec2febb9b1b52f4ee151395ee08a0c0cb714",
        resolution: ProfileResolution::BundleConfident,
        lens: LensSupport::NoCorrectionData,
        qualification: COLOUR_QUALIFICATION,
    },
];

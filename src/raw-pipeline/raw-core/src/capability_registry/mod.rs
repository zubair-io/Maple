//! Capability registry — the single source of truth for what Maple's editor
//! can do, where each capability ships, and what evidence backs its release
//! state (ticket #2430, milestone 13 · Release Contract & Qualification;
//! design spec `docs/strategy/milestones/m1-release-contract.md`).
//!
//! The registry is plain Rust data ([`CAPABILITY_REGISTRY`] in
//! `registry.rs`) so the thing a human edits is source under normal PR
//! review, never a status document. `tools/codegen.sh` emits it to Swift,
//! TypeScript, and C# consumers plus a human-readable
//! (`docs/capability-registry.md`) and machine-readable
//! (`docs/capability-registry.json`) release summary, all gated by the
//! `codegen-drift` CI job so no hand edit can diverge from this table.
//!
//! ## Release state is computed, never asserted
//!
//! Each capability declares which [`EvidenceSource`]s must be satisfied for
//! it to count as *integrated* (the capability is wired through a surface's
//! persistence / render path) and *qualified* (its output is numerically
//! proven). A source is satisfied only by an [`EvidenceRecord`] that a
//! harness wrote — `test-fixtures/qualification/<source>.json`, produced by
//! `tools/qualification/record.sh` — whose pipeline version, schema
//! version, corpus hash, backend, and executed case count all still match
//! what the registry declares today. Anything else (no record, a record
//! from an older pipeline, a re-touched corpus, a skipped or failing case,
//! or an executed count that does not equal the declared expected count)
//! leaves the capability at the state below. See `evidence.rs` for the
//! exact rule and `docs/testing.md` § "Capability registry" for the
//! operator workflow.

mod evidence;
mod registry;
#[cfg(test)]
mod tests;

pub use evidence::{
    classify, hash_corpus, judge, BuildIdentity, Classification, Evidence, EvidenceRecord, Finding,
    RecordStatus,
};
pub use registry::CAPABILITY_REGISTRY;

use crate::types::{AdjustmentGroup, WbScaleVersion};

/// A user-facing app surface that ships the editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Surface {
    /// macOS / iOS / iPadOS via the Swift shell (`src/apple`).
    Apple,
    /// Angular shell, both Maple Hosted and Self Hosted (`src/web`).
    Web,
    /// WinUI 3 shell (`src/windows`).
    Windows,
}

impl Surface {
    /// Every surface, in registry order.
    pub const ALL: &'static [Surface] = &[Surface::Apple, Surface::Web, Surface::Windows];

    /// Stable snake_case identifier — the wire value in every generated
    /// consumer.
    pub const fn id(self) -> &'static str {
        match self {
            Surface::Apple => "apple",
            Surface::Web => "web",
            Surface::Windows => "windows",
        }
    }
}

/// Where a capability's sidecar is persisted. Mirrors the adapter table in
/// `docs/architecture.md` (the four Apple adapters the #2431 contract suite
/// drives) plus the two Web storage paths and the API's own filesystem
/// layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StorageAdapter {
    /// Apple `FilesystemSource` — `.xmp` beside the original.
    Filesystem,
    /// Apple `SMBSource` — `.xmp` on the share via AMSMB2.
    Smb,
    /// Apple `PhotoKitSource` — app-support store keyed by asset id.
    PhotoKit,
    /// Apple `CloudSource` — the Self Hosted server over HTTP.
    Cloud,
    /// Self Hosted API storage (`src/api/src/fs`), serving the web shell.
    ApiFilesystem,
    /// Maple Hosted writable folder via the File System Access API.
    FileSystemAccess,
    /// Maple Hosted single-file / read-only fallback (download + IndexedDB).
    IndexedDb,
}

impl StorageAdapter {
    /// Every adapter, in registry order.
    pub const ALL: &'static [StorageAdapter] = &[
        StorageAdapter::Filesystem,
        StorageAdapter::Smb,
        StorageAdapter::PhotoKit,
        StorageAdapter::Cloud,
        StorageAdapter::ApiFilesystem,
        StorageAdapter::FileSystemAccess,
        StorageAdapter::IndexedDb,
    ];

    /// Stable snake_case identifier.
    pub const fn id(self) -> &'static str {
        match self {
            StorageAdapter::Filesystem => "filesystem",
            StorageAdapter::Smb => "smb",
            StorageAdapter::PhotoKit => "photokit",
            StorageAdapter::Cloud => "cloud",
            StorageAdapter::ApiFilesystem => "api_filesystem",
            StorageAdapter::FileSystemAccess => "file_system_access",
            StorageAdapter::IndexedDb => "indexed_db",
        }
    }
}

/// The class of asset a capability applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AssetClass {
    /// Camera RAW (DNG, ARW, CR3, …) decoded by `raw-core`.
    Raw,
    /// Already-rendered stills (JPEG / PNG / HEIC) ingested through the
    /// non-RAW develop path.
    NonRaw,
}

impl AssetClass {
    /// Every asset class, in registry order.
    pub const ALL: &'static [AssetClass] = &[AssetClass::Raw, AssetClass::NonRaw];

    /// Stable snake_case identifier.
    pub const fn id(self) -> &'static str {
        match self {
            AssetClass::Raw => "raw",
            AssetClass::NonRaw => "non_raw",
        }
    }
}

/// The render path that produces a capability's live preview.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PreviewPath {
    /// The Rust CPU reference chain (`raw_core::pipeline`) via the Apple
    /// C-FFI and `maple-cli`.
    CpuReference,
    /// The wgpu/WGSL develop chain on Metal (`raw-gpu` via `raw-ffi`).
    GpuLive,
    /// `render_bytes` in `raw-wasm` — the WASM-CPU browser path.
    WasmCpu,
    /// `render_bytes_gpu` in `raw-wasm` — the WebGPU browser path.
    WasmGpu,
}

impl PreviewPath {
    /// Every preview path, in registry order.
    pub const ALL: &'static [PreviewPath] = &[
        PreviewPath::CpuReference,
        PreviewPath::GpuLive,
        PreviewPath::WasmCpu,
        PreviewPath::WasmGpu,
    ];

    /// Stable snake_case identifier.
    pub const fn id(self) -> &'static str {
        match self {
            PreviewPath::CpuReference => "cpu_reference",
            PreviewPath::GpuLive => "gpu_live",
            PreviewPath::WasmCpu => "wasm_cpu",
            PreviewPath::WasmGpu => "wasm_gpu",
        }
    }
}

/// The binding through which a capability reaches an exported file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ExportPath {
    /// `maple-cli render` / `batch` — the deterministic headless reference.
    MapleCli,
    /// The Apple C-FFI static library (xcframework).
    AppleFfi,
    /// `raw-wasm` in the browser.
    Wasm,
    /// The Self Hosted API's `bun:ffi` dylib.
    ApiFfi,
    /// The Windows shell's directly linked `raw_ffi.dll`.
    WindowsDll,
}

impl ExportPath {
    /// Every export path, in registry order.
    pub const ALL: &'static [ExportPath] = &[
        ExportPath::MapleCli,
        ExportPath::AppleFfi,
        ExportPath::Wasm,
        ExportPath::ApiFfi,
        ExportPath::WindowsDll,
    ];

    /// Stable snake_case identifier.
    pub const fn id(self) -> &'static str {
        match self {
            ExportPath::MapleCli => "maple_cli",
            ExportPath::AppleFfi => "apple_ffi",
            ExportPath::Wasm => "wasm",
            ExportPath::ApiFfi => "api_ffi",
            ExportPath::WindowsDll => "windows_dll",
        }
    }
}

/// The computed release state of a capability. Ordered: `Core <
/// Integrated < Released`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReleaseState {
    /// The capability exists in `raw-core` (its fields are in
    /// `ADJUSTMENT_SCHEMA`, its math is unit-tested) but no surface has
    /// satisfied integration evidence for it.
    Core,
    /// Every declared surface has a satisfied integration-tier evidence
    /// source (persistence contract, CPU↔GPU parity), but at least one
    /// declared qualification source is missing, stale, vacuous, or red.
    Integrated,
    /// Every declared integration *and* qualification source is satisfied
    /// on every declared surface, against the current pipeline version,
    /// schema version, and corpus.
    Released,
}

impl ReleaseState {
    /// Stable snake_case identifier.
    pub const fn id(self) -> &'static str {
        match self {
            ReleaseState::Core => "core",
            ReleaseState::Integrated => "integrated",
            ReleaseState::Released => "released",
        }
    }
}

/// One editor capability: a stable identifier, an owner, its declared
/// surfaces / adapters / asset classes / render paths, the
/// `AdjustmentModel` fields it owns, and the evidence that gates its state.
#[derive(Clone, Copy, Debug)]
pub struct Capability {
    /// Stable snake_case identifier. Never renamed — generated consumers,
    /// the release summary, and tickets cite it.
    pub id: &'static str,
    /// Human title for the summary and any surface that lists capabilities.
    pub title: &'static str,
    /// GitHub login of the person accountable for the capability's
    /// evidence staying green.
    pub owner: &'static str,
    /// Surfaces that ship the capability today (per `docs/features.md` § 8).
    /// Empty means "core only, not surfaced anywhere" — such a capability
    /// can never leave [`ReleaseState::Core`].
    pub surfaces: &'static [Surface],
    /// Sidecar adapters the capability persists through.
    pub storage_adapters: &'static [StorageAdapter],
    /// Asset classes the capability applies to.
    pub asset_classes: &'static [AssetClass],
    /// Render paths that produce its live preview.
    pub preview_paths: &'static [PreviewPath],
    /// Bindings through which it reaches an exported file.
    pub export_paths: &'static [ExportPath],
    /// Copy/paste groups whose fields this capability owns.
    pub groups: &'static [AdjustmentGroup],
    /// `AdjustmentModel` fields owned directly (the `NON_COPYABLE_FIELDS`
    /// that belong to no group). Together with `groups`, every schema field
    /// must be owned by exactly one capability — `tests.rs` enforces it.
    pub fields: &'static [&'static str],
    /// Evidence that must be satisfied for [`ReleaseState::Integrated`].
    pub integration: &'static [EvidenceSource],
    /// Evidence that must additionally be satisfied for
    /// [`ReleaseState::Released`]. A capability that declares none can
    /// never be `Released`.
    pub qualification: &'static [EvidenceSource],
}

impl Capability {
    /// Every `AdjustmentModel` field this capability owns, by canonical
    /// snake_case name: the union of its groups' fields and `fields`.
    pub fn owned_fields(&self) -> Vec<&'static str> {
        self.groups
            .iter()
            .flat_map(|g| g.fields().iter().copied())
            .chain(self.fields.iter().copied())
            .collect()
    }
}

/// A harness whose recorded run is evidence. Each source pins the corpus it
/// runs over, the backends it accepts, and the exact number of cases a
/// complete run executes — the three facts that make "the job was green"
/// checkable rather than asserted (#2433).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EvidenceSource {
    /// `src/scripts/test_grey_adjustments.sh` — closed-form predictors for
    /// every scene-linear slider plus the display-domain gates, on the
    /// synthetic grey DNG. Never skips.
    GreyAdjustments,
    /// `src/scripts/test_synthetic_grey.sh` — neutral-pipeline flatness
    /// invariants on the synthetic grey DNG.
    SyntheticGrey,
    /// `src/scripts/test_grey_dcp.sh` — DCP code-path coverage.
    GreyDcp,
    /// `src/scripts/test_synthetic_color_chart.sh` — 24-patch chart
    /// invariants.
    ColorChart,
    /// `src/scripts/test_color_pipeline.sh` — CIEDE2000 vs the ACR-rendered
    /// references, one case per `test-fixtures/budgets.json` cell.
    ColorHarness,
    /// The #2431 Apple sidecar transaction contract suite
    /// (`SidecarTransactionContract*Tests` in `MapleCoreTests`).
    SidecarContractApple,
    /// The #2431 API slice (`src/api/src/routes/xmp.sidecar-contract.test.ts`).
    SidecarContractApi,
    /// `cargo test -p raw-wasm --features gpu gpu_render` — the whole
    /// `render_bytes_gpu` chain against `render_bytes`, on the Mesa
    /// lavapipe adapter CI provisions (#1973).
    GpuChainParityLavapipe,
    /// The same chain on a real Metal adapter (naga MSL output), the path
    /// every Apple build ships (#2315).
    GpuChainParityMetal,
    /// `MapleUITests.testCanvasMatchesGolden` — the live SwiftUI canvas vs
    /// the committed golden (#2366).
    AppleCanvasGolden,
}

impl EvidenceSource {
    /// Every source, in registry order.
    pub const ALL: &'static [EvidenceSource] = &[
        EvidenceSource::GreyAdjustments,
        EvidenceSource::SyntheticGrey,
        EvidenceSource::GreyDcp,
        EvidenceSource::ColorChart,
        EvidenceSource::ColorHarness,
        EvidenceSource::SidecarContractApple,
        EvidenceSource::SidecarContractApi,
        EvidenceSource::GpuChainParityLavapipe,
        EvidenceSource::GpuChainParityMetal,
        EvidenceSource::AppleCanvasGolden,
    ];

    /// Stable snake_case identifier — doubles as the record filename stem
    /// under `test-fixtures/qualification/`.
    pub const fn id(self) -> &'static str {
        match self {
            EvidenceSource::GreyAdjustments => "grey_adjustments",
            EvidenceSource::SyntheticGrey => "synthetic_grey",
            EvidenceSource::GreyDcp => "grey_dcp",
            EvidenceSource::ColorChart => "color_chart",
            EvidenceSource::ColorHarness => "color_harness",
            EvidenceSource::SidecarContractApple => "sidecar_contract_apple",
            EvidenceSource::SidecarContractApi => "sidecar_contract_api",
            EvidenceSource::GpuChainParityLavapipe => "gpu_chain_parity_lavapipe",
            EvidenceSource::GpuChainParityMetal => "gpu_chain_parity_metal",
            EvidenceSource::AppleCanvasGolden => "apple_canvas_golden",
        }
    }

    /// Look a source up by its [`id`](Self::id).
    pub fn from_id(id: &str) -> Option<EvidenceSource> {
        Self::ALL.iter().copied().find(|s| s.id() == id)
    }

    /// One-line description for the human-readable summary.
    pub const fn description(self) -> &'static str {
        match self {
            EvidenceSource::GreyAdjustments => {
                "closed-form slider predictors + display gates on the synthetic grey DNG"
            }
            EvidenceSource::SyntheticGrey => "neutral-pipeline flatness invariants",
            EvidenceSource::GreyDcp => "DCP code-path coverage (ColorMatrix / ForwardMatrix / PTC)",
            EvidenceSource::ColorChart => "synthetic 24-patch colour-chart invariants",
            EvidenceSource::ColorHarness => "CIEDE2000 vs ACR references, per budgets.json cell",
            EvidenceSource::SidecarContractApple => {
                "Apple cross-adapter sidecar transaction contract suite (#2431)"
            }
            EvidenceSource::SidecarContractApi => "API sidecar transaction contract (#2431)",
            EvidenceSource::GpuChainParityLavapipe => {
                "render_bytes_gpu vs render_bytes on Mesa lavapipe (#1973)"
            }
            EvidenceSource::GpuChainParityMetal => {
                "render_bytes_gpu vs render_bytes on Metal (#2315)"
            }
            EvidenceSource::AppleCanvasGolden => "live SwiftUI canvas vs committed golden (#2366)",
        }
    }

    /// The surfaces whose own code path this source exercises. A source
    /// with no surface (the CPU-reference gates) proves the shared core and
    /// counts toward every capability that declares it, but covers no
    /// surface on its own.
    pub const fn covers(self) -> &'static [Surface] {
        match self {
            EvidenceSource::GreyAdjustments
            | EvidenceSource::SyntheticGrey
            | EvidenceSource::GreyDcp
            | EvidenceSource::ColorChart
            | EvidenceSource::ColorHarness => &[],
            EvidenceSource::SidecarContractApple
            | EvidenceSource::GpuChainParityMetal
            | EvidenceSource::AppleCanvasGolden => &[Surface::Apple],
            EvidenceSource::SidecarContractApi | EvidenceSource::GpuChainParityLavapipe => {
                &[Surface::Web]
            }
        }
    }

    /// Backends a record may claim. A record on any other backend is not
    /// evidence — a Metal parity run recorded as `vulkan-lavapipe` proves
    /// nothing about Metal.
    pub const fn accepted_backends(self) -> &'static [&'static str] {
        match self {
            EvidenceSource::GreyAdjustments
            | EvidenceSource::SyntheticGrey
            | EvidenceSource::GreyDcp
            | EvidenceSource::ColorChart
            | EvidenceSource::ColorHarness => &["cpu-reference"],
            EvidenceSource::SidecarContractApple => &["xctest-macos"],
            EvidenceSource::SidecarContractApi => &["bun"],
            EvidenceSource::GpuChainParityLavapipe => &["vulkan-lavapipe"],
            EvidenceSource::GpuChainParityMetal => &["metal"],
            EvidenceSource::AppleCanvasGolden => &["xcuitest-macos"],
        }
    }

    /// The number of cases one complete run executes. Pinned here, under
    /// review, so a run that silently dropped cases cannot satisfy the
    /// source; adding a test to a corpus means bumping this in the same PR
    /// and re-recording.
    pub const fn expected_cases(self) -> u32 {
        match self {
            EvidenceSource::GreyAdjustments => 40,
            EvidenceSource::SyntheticGrey => 6,
            EvidenceSource::GreyDcp => 4,
            EvidenceSource::ColorChart => 7,
            EvidenceSource::ColorHarness => 796,
            EvidenceSource::SidecarContractApple => 12,
            EvidenceSource::SidecarContractApi => 3,
            EvidenceSource::GpuChainParityLavapipe => 16,
            EvidenceSource::GpuChainParityMetal => 16,
            EvidenceSource::AppleCanvasGolden => 1,
        }
    }

    /// Repo-relative files (or directories, walked recursively) whose
    /// contents define the source's corpus. A record is stale the moment
    /// any of them changes — see [`hash_corpus`].
    pub const fn corpus(self) -> &'static [&'static str] {
        match self {
            EvidenceSource::GreyAdjustments => &[
                "src/raw-pipeline/raw-core/tests/grey_adjustments.rs",
                "src/raw-pipeline/raw-core/tests/grey_adjustments_display.rs",
            ],
            EvidenceSource::SyntheticGrey => &["src/raw-pipeline/raw-core/tests/grey_invariants.rs"],
            EvidenceSource::GreyDcp => &["src/raw-pipeline/raw-core/tests/grey_dcp_phase1.rs"],
            EvidenceSource::ColorChart => {
                &["src/raw-pipeline/raw-core/tests/color_chart_invariants.rs"]
            }
            EvidenceSource::ColorHarness => &["test-fixtures/budgets.json"],
            EvidenceSource::SidecarContractApple => &[
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarContractSupport.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractCloudTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractFilesystemTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractPhotoKitTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractSMBTests.swift",
            ],
            EvidenceSource::SidecarContractApi => {
                &["src/api/src/routes/xmp.sidecar-contract.test.ts"]
            }
            EvidenceSource::GpuChainParityLavapipe | EvidenceSource::GpuChainParityMetal => &[
                "src/raw-pipeline/raw-wasm/src/gpu_render.rs",
                "src/raw-pipeline/raw-wasm/src/gpu_render",
                "src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng",
            ],
            EvidenceSource::AppleCanvasGolden => &[
                "src/apple/MapleUITests/MapleUITests.swift",
                "src/apple/MapleUITests/Goldens/test_0017-default.png",
            ],
        }
    }
}

/// The sidecar schema version the registry evaluates evidence against —
/// the only semantics version the XMP schema carries
/// (`papp:WbScaleVersion`, see `docs/xmp-canonical-format.md` § "Schema
/// versioning"). A record written before a bump is stale.
pub fn current_schema_version() -> u32 {
    match WbScaleVersion::default() {
        WbScaleVersion::V1 => 1,
        WbScaleVersion::V2 => 2,
        WbScaleVersion::V3 => 3,
        WbScaleVersion::V4 => 4,
        WbScaleVersion::V5 => 5,
    }
}

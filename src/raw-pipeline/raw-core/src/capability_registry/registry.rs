//! The capability table — the data half of the registry (#2430). Every
//! entry is reviewed Rust; there is no other place a capability's
//! surfaces, owner, or evidence requirements can be declared.
//!
//! Surfaces follow `docs/features.md` § 8 ("Per-platform matrix"). Evidence
//! declarations follow the sequencing in
//! `docs/strategy/milestones/m1-release-contract.md`: the Apple canvas
//! golden (#2366) and Metal parity (#2315) are declared as qualification
//! sources now, so the capabilities that depend on them cannot read
//! `Released` until those harnesses record a satisfied run.

use super::{
    AssetClass, Capability, EvidenceSource, ExportPath, PreviewPath, StorageAdapter, Surface,
};
use crate::types::AdjustmentGroup;

const OWNER: &str = "zubair-io";

const ALL_SURFACES: &[Surface] = &[Surface::Apple, Surface::Web, Surface::Windows];
const APPLE_WEB: &[Surface] = &[Surface::Apple, Surface::Web];
const ALL_ADAPTERS: &[StorageAdapter] = StorageAdapter::ALL;
const ALL_ASSETS: &[AssetClass] = AssetClass::ALL;
const ALL_PREVIEWS: &[PreviewPath] = PreviewPath::ALL;
const ALL_EXPORTS: &[ExportPath] = ExportPath::ALL;

/// Integration evidence for a develop slider capability: the sidecar
/// contract on each surface that persists it, plus CPU↔GPU chain parity
/// for the GPU preview path.
const DEVELOP_INTEGRATION: &[EvidenceSource] = &[
    EvidenceSource::SidecarContractApple,
    EvidenceSource::SidecarContractApi,
    EvidenceSource::GpuChainParityLavapipe,
];

/// Qualification evidence for a colour-bearing develop capability: the
/// synthetic closed-form gates, the ACR harness, Metal chain parity, and
/// the Apple canvas golden.
const COLOR_QUALIFICATION: &[EvidenceSource] = &[
    EvidenceSource::GreyAdjustments,
    EvidenceSource::SyntheticGrey,
    EvidenceSource::GreyDcp,
    EvidenceSource::ColorChart,
    EvidenceSource::ColorHarness,
    EvidenceSource::GpuChainParityMetal,
    EvidenceSource::AppleCanvasGolden,
];

const SIDECAR_CONTRACTS: &[EvidenceSource] = &[
    EvidenceSource::SidecarContractApple,
    EvidenceSource::SidecarContractApi,
];

/// Every editor capability, in presentation order. Ids are permanent.
pub const CAPABILITY_REGISTRY: &[Capability] = &[
    Capability {
        id: "white_balance",
        title: "White balance",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[AdjustmentGroup::WhiteBalance],
        fields: &[],
        integration: DEVELOP_INTEGRATION,
        qualification: COLOR_QUALIFICATION,
    },
    Capability {
        id: "tone",
        title: "Tone (exposure, contrast, parametric and point curves)",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[AdjustmentGroup::Tone],
        fields: &[],
        integration: DEVELOP_INTEGRATION,
        qualification: COLOR_QUALIFICATION,
    },
    Capability {
        id: "color",
        title: "Color (HSL, B&W mixer, color grading, profile and look)",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[AdjustmentGroup::Color],
        fields: &[],
        integration: DEVELOP_INTEGRATION,
        qualification: COLOR_QUALIFICATION,
    },
    Capability {
        id: "detail",
        title: "Detail (sharpening, noise reduction, presence, dehaze, lens)",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[AdjustmentGroup::Detail],
        // Deprecated read-only alias for `capture_sharpening_sigma` (#456):
        // owned here so the field stays accounted for without joining a
        // copy/paste group.
        fields: &["capture_sharpening_radius"],
        integration: DEVELOP_INTEGRATION,
        qualification: COLOR_QUALIFICATION,
    },
    Capability {
        id: "effects",
        title: "Effects (vignette, grain, film looks)",
        owner: OWNER,
        // Film looks and the effects panel do not ship on Windows
        // (`docs/features.md` § 8).
        surfaces: APPLE_WEB,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: &[
            ExportPath::MapleCli,
            ExportPath::AppleFfi,
            ExportPath::Wasm,
            ExportPath::ApiFfi,
        ],
        groups: &[AdjustmentGroup::Effects],
        fields: &[],
        integration: DEVELOP_INTEGRATION,
        qualification: &[
            EvidenceSource::GreyAdjustments,
            EvidenceSource::GpuChainParityMetal,
            EvidenceSource::AppleCanvasGolden,
        ],
    },
    Capability {
        id: "geometry",
        title: "Crop and straighten",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[AdjustmentGroup::Geometry],
        fields: &[],
        integration: SIDECAR_CONTRACTS,
        qualification: &[EvidenceSource::AppleCanvasGolden],
    },
    Capability {
        id: "auto_adjustments",
        title: "AUTO (exposure + calibrated tone sliders)",
        owner: OWNER,
        // Apple has the engine but no UI entry point (`docs/features.md` § 8).
        surfaces: &[Surface::Web, Surface::Windows],
        storage_adapters: &[
            StorageAdapter::ApiFilesystem,
            StorageAdapter::FileSystemAccess,
            StorageAdapter::IndexedDb,
        ],
        asset_classes: &[AssetClass::Raw],
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[],
        fields: &[],
        integration: &[EvidenceSource::SidecarContractApi],
        // No harness measures AUTO's recommendation against a reference
        // today (`test_auto_profile_match.sh` is not a gate) — declaring
        // none keeps `Released` unreachable until one exists.
        qualification: &[],
    },
    Capability {
        id: "copy_paste_sync",
        title: "Copy / paste / sync settings",
        owner: OWNER,
        surfaces: APPLE_WEB,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[],
        fields: &[],
        integration: &[],
        qualification: &[],
    },
    Capability {
        id: "presets",
        title: "Presets",
        owner: OWNER,
        surfaces: APPLE_WEB,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[],
        fields: &[],
        integration: &[],
        qualification: &[],
    },
    Capability {
        id: "local_adjustments",
        title: "Masks / local adjustments",
        owner: OWNER,
        // Model-only: neither front-end `AdjustmentModel` carries the
        // field (`docs/features.md` § "Local adjustments and masks — not
        // surfaced").
        surfaces: &[],
        storage_adapters: &[],
        asset_classes: &[AssetClass::Raw],
        preview_paths: &[PreviewPath::CpuReference],
        export_paths: &[ExportPath::MapleCli],
        groups: &[],
        fields: &["local_adjustments"],
        integration: &[],
        qualification: &[],
    },
    Capability {
        id: "inpaint_repair",
        title: "Repair (local AI inpainting)",
        owner: OWNER,
        surfaces: &[Surface::Apple],
        storage_adapters: &[StorageAdapter::Filesystem],
        asset_classes: &[AssetClass::Raw],
        preview_paths: &[PreviewPath::CpuReference, PreviewPath::GpuLive],
        export_paths: &[ExportPath::AppleFfi],
        groups: &[],
        fields: &["inpaint_removals"],
        integration: &[],
        qualification: &[],
    },
    Capability {
        id: "sidecar_persistence",
        title: "Non-destructive sidecar persistence",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: ALL_PREVIEWS,
        export_paths: ALL_EXPORTS,
        groups: &[],
        fields: &[],
        integration: SIDECAR_CONTRACTS,
        qualification: SIDECAR_CONTRACTS,
    },
    Capability {
        id: "export",
        title: "Export (JPEG / PNG / TIFF / HEIC)",
        owner: OWNER,
        surfaces: ALL_SURFACES,
        storage_adapters: ALL_ADAPTERS,
        asset_classes: ALL_ASSETS,
        preview_paths: &[],
        export_paths: ALL_EXPORTS,
        groups: &[],
        fields: &[],
        integration: &[],
        qualification: &[],
    },
];

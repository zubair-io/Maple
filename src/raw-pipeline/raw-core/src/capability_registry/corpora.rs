//! Qualification corpora — the repo-relative files (or directories,
//! walked recursively) whose contents define each evidence source's
//! corpus. A record is stale the moment any of them changes — see
//! [`hash_corpus`](super::hash_corpus).
//!
//! Split out of `mod.rs` in #5016: the path lists grow with every suite,
//! and the file-budget gate (`budget-headroom`, 570 LOC soft ceiling)
//! refuses to let a source-of-truth module absorb that growth.

use super::EvidenceSource;

/// Repo-relative corpus paths for `source`.
pub const fn corpus_paths(source: EvidenceSource) -> &'static [&'static str] {
    match source {

            EvidenceSource::GreyAdjustments => &[
                "src/raw-pipeline/raw-core/tests/grey_adjustments.rs",
                "src/raw-pipeline/raw-core/tests/grey_adjustments_display.rs",
                "src/raw-pipeline/raw-core/tests/grey_adjustments_wb.rs",
                "src/raw-pipeline/raw-core/tests/whites_anchor_develop.rs",
            ],
            EvidenceSource::SyntheticGrey => &["src/raw-pipeline/raw-core/tests/grey_invariants.rs"],
            EvidenceSource::GreyDcp => &["src/raw-pipeline/raw-core/tests/grey_dcp_phase1.rs"],
            EvidenceSource::ColorChart => {
                &["src/raw-pipeline/raw-core/tests/color_chart_invariants.rs"]
            }
            EvidenceSource::ColorHarness => &[
                "test-fixtures/budgets.json",
                "src/raw-pipeline/raw-core/src/color/profiles/profiles.bin",
                "src/scripts/test_color_pipeline.sh",
                "src/scripts/compare_images.py",
                "src/scripts/compare_images_chunks.py",
                "src/scripts/compare_images_metadata.py",
                "src/scripts/acr-reference/verify_settings.py",
                "src/scripts/acr-reference/write_xmp.py",
            ],
            // The contract tests plus the sidecar/XMP implementation they
            // exercise (#5016 review): a semantics change in the reader or
            // writer must stale the record even when no test file moved.
            EvidenceSource::SidecarContractApple => &[
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarContractSupport.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractCloudTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractFilesystemTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractPhotoKitTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarTransactionContractSMBTests.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/PhotoKitSidecarStore.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/SMBSidecarStore.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/SidecarPath.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/SidecarStoreProtocol.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/WorkflowSidecarCore.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPLocalAdjustmentOrder.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPMaskGroupNamespaces.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPMaskGroupSources.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPPassthrough.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPPassthroughScanner.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Attrs.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+BlackWhite.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Canonical.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+HSL.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Helpers.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+LocalAdjustments.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+LocalAdjustmentsBrush.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+MaskGroups.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Metadata.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+MetadataWrite.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+ParseAttrs.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Passthrough.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+Retouch.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+ToneCurves.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+VideoWrite.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+WhiteBalance.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarStore.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarFilePublication.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarFilePublication.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/Sources/FilesystemSource.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSidecarStore.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/Cloud/CloudSidecarStore+Variants.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SMBSource.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SMBSource+Sidecar.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPCanonicalFormatTests.swift",
                "src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPPassthroughTests.swift",
                "src/apple/Packages/MapleCore/Sources/MapleCore/XmpMetadata+Empty.swift",
            ],
            EvidenceSource::SidecarContractApi => {
                &[
                    "src/api/src/routes/xmp.sidecar-contract.test.ts",
                    "src/api/src/routes/xmp.ts",
                    "src/api/src/routes/xmp-change.ts",
                    "src/api/src/routes/xmp-path-auth.ts",
                    "src/api/src/routes/folders.upload.ts",
                    "src/api/src/routes/folders.upload-sidecar-admission.ts",
                    "src/api/src/fs/primary-replacement-admission.ts",
                    "src/api/src/fs/errno-code.ts",
                    "src/api/src/fs/root.ts",
                    "src/api/src/fs/relocate-replace-fence.ts",
                    "src/api/src/xmp",
                    "src/api/src/fs/sidecar-io.ts",
                    "src/api/src/fs/sidecar-write-order.ts",
                    "src/api/src/fs/xmp-conditional.ts",
                    "src/api/src/fs/xmp.ts",
                    "src/api/src/fs/xmp-sidecar-path.ts",
                ]
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

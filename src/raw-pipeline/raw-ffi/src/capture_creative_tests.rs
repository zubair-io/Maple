//! `MapleCaptureCreative` carries raw-core's creative header exactly, refuses
//! inputs that are not a capture decode's, and the capture decode entries
//! write one (#5377).

use super::*;
use crate::buffers::MapleSceneLinearBufferF32;
use raw_core::test_support::creative::{creative_stage, fallback_stage, Tables};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::HighlightRecoveryMode;
use std::ffi::CString;

#[test]
fn the_struct_round_trips_every_header() {
    for tables in [
        Tables::None,
        Tables::SingleHueSatMap,
        Tables::DualHueSatMap { srgb: true },
        Tables::DualHueSatMapAndLook,
    ] {
        for stage in [creative_stage(tables, 1.4), fallback_stage(tables, 0.7)] {
            for recovery in [
                HighlightRecoveryMode::Off,
                HighlightRecoveryMode::OklabChromaReduction,
            ] {
                let (header, wire) = stage.transport(recovery).unwrap();
                let interned = crate::wb_frame_flat::intern_table_wire(wire.floats());
                let flat = MapleCaptureCreative::new(&header, interned);
                let (back, tables) = unsafe { flat.header() }.unwrap();
                assert_eq!(back, header);
                assert_eq!(tables, wire.floats());
            }
        }
    }
}

#[test]
fn an_absent_or_damaged_struct_is_refused() {
    assert!(unsafe { MapleCaptureCreative::ABSENT.header() }.is_err());
    assert!(unsafe { creative_from_ptr(std::ptr::null()) }
        .unwrap()
        .is_none());
    let stage = creative_stage(Tables::DualHueSatMap { srgb: false }, 1.0);
    let (header, wire) = stage.transport(HighlightRecoveryMode::Off).unwrap();
    let interned = crate::wb_frame_flat::intern_table_wire(wire.floats());
    let good = MapleCaptureCreative::new(&header, interned);
    let damaged = [
        MapleCaptureCreative {
            tables: std::ptr::null(),
            ..good
        },
        MapleCaptureCreative {
            warm: MapleCreativeTable::default(),
            ..good
        },
        MapleCaptureCreative {
            illuminant: 9,
            ..good
        },
        MapleCaptureCreative {
            as_shot_table: 7,
            ..good
        },
    ];
    for flat in damaged {
        assert!(unsafe { flat.header() }.is_err());
    }
}

fn synthetic_dng(dir: &tempfile::TempDir) -> CString {
    let path = dir.path().join("capture.dng");
    SyntheticGreyDng {
        width: 64,
        height: 48,
        ..Default::default()
    }
    .write_to(&path)
    .unwrap();
    CString::new(path.to_str().unwrap()).unwrap()
}

fn empty_capture() -> MapleCaptureBufferF32 {
    MapleCaptureBufferF32 {
        scene: MapleSceneLinearBufferF32::empty(),
        creative: MapleCaptureCreative::ABSENT,
    }
}

#[test]
fn the_capture_entries_write_the_capture_and_its_creative_stage() {
    let dir = tempfile::tempdir().unwrap();
    let path = synthetic_dng(&dir);
    let bytes = std::fs::read(path.to_str().unwrap()).unwrap();
    let ext = CString::new("dng").unwrap();
    let (mut file, mut sized, mut from_bytes) = (empty_capture(), empty_capture(), empty_capture());
    unsafe {
        let (none, never) = (std::ptr::null(), std::ptr::null());
        assert_eq!(
            crate::capture_f32::maple_render_file_capture_f32(
                path.as_ptr(),
                none,
                1,
                never,
                &mut file
            ),
            0
        );
        assert_eq!(
            crate::capture_f32::maple_render_file_capture_sized_f32(
                path.as_ptr(),
                none,
                16,
                1,
                never,
                &mut sized
            ),
            0
        );
        assert_eq!(
            crate::capture_f32::maple_render_bytes_capture_f32(
                bytes.as_ptr(),
                bytes.len(),
                ext.as_ptr(),
                none,
                1,
                never,
                &mut from_bytes
            ),
            0
        );
        for buffer in [&file, &sized, &from_bytes] {
            assert_eq!(buffer.creative.present, 1);
            assert!(buffer.scene.whites_anchor_ev.is_finite());
            let (header, _) = buffer.creative.header().unwrap();
            assert_eq!(header.ae_gain, buffer.scene.ae_gain);
        }
        assert_eq!(sized.scene.width.max(sized.scene.height), 16);
        let pixels = |b: &MapleCaptureBufferF32| {
            std::slice::from_raw_parts(b.scene.f32_rgba, b.scene.len_bytes / 4).to_vec()
        };
        assert_eq!(pixels(&file), pixels(&from_bytes));
        assert_eq!(file.creative.tables, from_bytes.creative.tables);
        for buffer in [&mut file, &mut sized, &mut from_bytes] {
            maple_free_capture_buffer_f32(buffer);
            assert!(buffer.scene.f32_rgba.is_null());
            assert_eq!(buffer.creative.present, 0);
        }
        assert_eq!(
            crate::capture_f32::maple_render_file_capture_sized_f32(
                path.as_ptr(),
                none,
                0,
                1,
                never,
                &mut sized
            ),
            9
        );
    }
}

#[test]
fn the_layout_keeps_the_table_pointer_aligned_after_the_numbers() {
    let text = crate::abi_layout::describe("MapleCaptureCreative").unwrap();
    let offset = |name: &str| -> usize {
        text.split(';')
            .find_map(|f| f.strip_prefix(&format!("{name}=")))
            .unwrap()
            .parse()
            .unwrap()
    };
    assert_eq!(offset("tables") % std::mem::align_of::<*const f32>(), 0);
    assert_eq!(
        offset("tables_len"),
        offset("tables") + std::mem::size_of::<*const f32>()
    );
    assert_eq!(std::mem::size_of::<MapleCreativeTable>(), 20);
}

/// A CPU tick reuses its decode's creative stage instead of copying the
/// tables again: the same stage at every slider pair, built once.
#[test]
fn a_cpu_tick_reuses_its_decode_stage_and_allocates_nothing() {
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.357_9);
    let (header, wire) = stage
        .transport(HighlightRecoveryMode::OklabChromaReduction)
        .unwrap();
    let tables = crate::wb_frame_flat::intern_table_wire(wire.floats());
    let creative = MapleCaptureCreative::new(&header, tables);
    let built = cpu_stage(&header, tables).unwrap();
    for temperature in [2000.0, 4700.0, 6500.0, 50000.0] {
        let mut reused = None;
        let allocations = crate::allocation_counter::count(|| {
            reused = Some(cpu_stage(&header, tables).unwrap());
        });
        assert_eq!(allocations, 0, "T={temperature}");
        let p = crate::MapleAdjustmentParams {
            temperature,
            tint: 9.0,
            creative_ptr: &creative,
            ..crate::scene_linear_chain_tests::default_params()
        };
        let inputs = unsafe { crate::scene_linear_chain::chain_inputs_from_params(&p) }.unwrap();
        assert!(Arc::ptr_eq(inputs.creative.as_ref().unwrap(), &built));
        assert!(Arc::ptr_eq(&reused.unwrap(), &built));
    }
    let (other, _) = creative_stage(Tables::DualHueSatMapAndLook, 2.468)
        .transport(HighlightRecoveryMode::OklabChromaReduction)
        .unwrap();
    assert!(!Arc::ptr_eq(&cpu_stage(&other, tables).unwrap(), &built));
}

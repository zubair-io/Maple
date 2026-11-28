use super::*;

/// One measured stitch (#6141): `maple-cli pano stitch --display`, classical matcher, the
/// whole-process peak over the head and over the composite: the footprint (`proc_pid_rusage`)
/// on a Mac (Mac17,6, macOS 27.0.1), sampled every 20 ms, or the RSS on Linux (4 cores), the
/// highest of every run at that thread count. The rings are `pano-gen-fixture` LinearRaw sets;
/// `whole-frame` rows force the X-Trans path, which develops the whole frame at once; pano_00
/// (Hasselblad) and pano_01 are real Bayer sets.
#[derive(Clone, Copy, Debug)]
struct PanoMeasuredStitch {
    mac: bool,
    name: &'static str,
    frame_count: u64,
    largest_frame_px: u64,
    canvas: (u64, u64),
    threads: u64,
    head_bytes: u64,
    composite_bytes: u64,
}

const fn measured(
    (mac, name): (bool, &'static str),
    (frame_count, largest_frame_px): (u64, u64),
    canvas: (u64, u64),
    threads: u64,
    (head_mib, composite_mib): (u64, u64),
) -> PanoMeasuredStitch {
    PanoMeasuredStitch {
        mac,
        name,
        frame_count,
        largest_frame_px,
        canvas,
        threads,
        head_bytes: head_mib * MIB,
        composite_bytes: composite_mib * MIB,
    }
}

const MP12: u64 = 4000 * 3000;
const MP24: u64 = 6000 * 4000;
const MP48: u64 = 8000 * 6000;
const PANO_00_PX: u64 = 11648 * 8640;
const PANO_01_PX: u64 = 5272 * 3948;
const RING3: (u64, u64) = (1_623, 674);
const RING6: (u64, u64) = (5_672, 1_268);
const RING12: (u64, u64) = (30_372, 3_955);
const RING12_48: (u64, u64) = (44_351, 5_772);
const RING40_12: (u64, u64) = (81_883, 3_087);
const RING40_48: (u64, u64) = (82_437, 3_105);
const MAC: (bool, &str) = (true, "ring");
const LINUX: (bool, &str) = (false, "ring");
const LINUX_WHOLE_FRAME: (bool, &str) = (false, "whole-frame");

const MEASURED: [PanoMeasuredStitch; 26] = [
    measured(MAC, (3, 640 * 480), RING3, 18, (67, 200)),
    measured(MAC, (6, 1280 * 960), RING6, 18, (226, 632)),
    measured(MAC, (12, MP12), RING12, 4, (636, 1_255)),
    measured(MAC, (12, MP12), RING12, 18, (624, 1_324)),
    measured(MAC, (12, MP48), RING12_48, 18, (1_965, 1_903)),
    measured(MAC, (40, MP48), RING40_48, 18, (2_268, 2_312)),
    measured(
        (true, "pano_01"),
        (21, PANO_01_PX),
        (26_981, 9_487),
        18,
        (1_402, 1_695),
    ),
    measured(
        (true, "pano_00"),
        (3, PANO_00_PX),
        (12_313, 12_762),
        18,
        (2_430, 1_155),
    ),
    measured(LINUX, (3, 640 * 480), RING3, 4, (58, 100)),
    measured(LINUX, (3, 640 * 480), RING3, 18, (60, 127)),
    measured(LINUX, (6, 1280 * 960), RING6, 4, (157, 446)),
    measured(LINUX, (12, MP12), RING12, 4, (439, 742)),
    measured(LINUX, (12, MP12), RING12, 8, (438, 817)),
    measured(LINUX, (12, MP12), RING12, 18, (457, 1_117)),
    measured(LINUX, (12, MP12), RING12, 32, (439, 962)),
    measured(LINUX, (12, MP24), (45_149, 5_285), 4, (681, 1_146)),
    measured(LINUX, (12, MP48), RING12_48, 4, (1_270, 1_264)),
    measured(LINUX, (12, MP48), RING12_48, 18, (1_282, 1_473)),
    measured(LINUX_WHOLE_FRAME, (12, MP48), RING12_48, 4, (1_277, 1_278)),
    measured(LINUX_WHOLE_FRAME, (12, MP48), RING12_48, 18, (1_279, 1_504)),
    measured(LINUX_WHOLE_FRAME, (12, MP48), RING12_48, 32, (1_280, 1_666)),
    measured(LINUX, (40, MP12), RING40_12, 4, (376, 1_151)),
    measured(LINUX, (40, MP12), RING40_12, 64, (388, 1_640)),
    measured(LINUX, (40, MP48), RING40_48, 4, (1_230, 1_161)),
    measured(LINUX, (40, MP48), RING40_48, 18, (1_255, 1_437)),
    measured(LINUX, (40, MP48), RING40_48, 32, (1_270, 1_601)),
];

/// The iPad's pano_00 (#5450): 1263 MiB added in the head, 593 MiB in the composite.
const PANO_00_CANVAS: (u64, u64) = (12_315, 12_760);

const GB: f64 = 1e9;
const MIB: u64 = 1 << 20;

fn load(m: &PanoMeasuredStitch, profile: PanoMemoryProfile) -> PanoStitchLoad {
    PanoStitchLoad {
        frame_count: m.frame_count,
        largest_frame_px: m.largest_frame_px,
        proxy_long_edge: PANO_PROXY_FITTED_LONG_EDGE,
        threads: m.threads,
        ml_matcher: false,
        profile,
    }
}

fn composite(l: &PanoStitchLoad, (width, height): (u64, u64)) -> u64 {
    l.composite_bytes(width, height)
}

const PANO_01_X21: PanoStitchLoad = PanoStitchLoad {
    frame_count: 21,
    largest_frame_px: PANO_01_PX,
    proxy_long_edge: PANO_PROXY_FITTED_LONG_EDGE,
    threads: 18,
    ml_matcher: false,
    profile: PanoMemoryProfile::Server,
};
const PANO_01_CANVAS: (u64, u64) = (26_981, 9_488);

const PROFILES: [PanoMemoryProfile; 2] = [PanoMemoryProfile::Server, PanoMemoryProfile::Apple];

/// `cargo test -p raw-core --lib pano_memory -- --nocapture` prints the table in docs/pano.md.
#[test]
fn predicted_against_measured_for_every_set() {
    println!("| OS | Set | F × MP | Canvas | Threads | Measured head / composite (GB) | Model head / composite (GB), peak ratio |");
    println!("| --- | --- | --- | --- | --- | --- | --- |");
    for m in &MEASURED {
        let l = load(m, PanoMemoryProfile::Server);
        let (h, c) = (l.head_bytes(), composite(&l, m.canvas));
        let peak = m.head_bytes.max(m.composite_bytes);
        println!(
            "| {} | {} | {} × {:.1} | {} × {} | {} | {:.2} / {:.2} | {:.2} / {:.2}, {:.2} |",
            if m.mac { "macOS" } else { "Linux" },
            m.name,
            m.frame_count,
            m.largest_frame_px as f64 / 1e6,
            m.canvas.0,
            m.canvas.1,
            m.threads,
            m.head_bytes as f64 / GB,
            m.composite_bytes as f64 / GB,
            h as f64 / GB,
            c as f64 / GB,
            h.max(c) as f64 / peak as f64
        );
    }
}

#[test]
fn the_server_profile_overstates_each_phase_of_every_measured_stitch() {
    for m in &MEASURED {
        let l = load(m, PanoMemoryProfile::Server);
        let (head, composite) = (l.head_bytes(), composite(&l, m.canvas));
        let label = format!(
            "{} {}×{} at {} threads",
            m.name, m.frame_count, m.largest_frame_px, m.threads
        );
        assert!(
            head >= m.head_bytes,
            "{label}: head {head} < {}",
            m.head_bytes
        );
        // The composite's footprint includes what the head left behind, so where it is
        // below the head's it bounds nothing the head does not.
        if m.composite_bytes > m.head_bytes {
            assert!(
                composite >= m.composite_bytes,
                "{label}: composite {composite} < {}",
                m.composite_bytes
            );
        }
    }
}

#[test]
fn the_server_profile_stays_within_half_again_of_every_full_size_mac_peak() {
    for m in MEASURED
        .iter()
        .filter(|m| m.mac && m.largest_frame_px > PANO_PROXY_PIXELS_MAX)
    {
        let l = load(m, PanoMemoryProfile::Server);
        let ratio = l.head_bytes().max(composite(&l, m.canvas)) as f64
            / m.head_bytes.max(m.composite_bytes) as f64;
        assert!(
            ratio <= 1.5,
            "{} at {} threads: {ratio:.2}",
            m.name,
            m.threads
        );
    }
}

#[test]
fn forty_48_mp_frames_fit_the_server_in_under_three_gib_at_18_threads() {
    let l = load(&MEASURED[5], PanoMemoryProfile::Server);
    assert_eq!((l.frame_count, l.threads), (40, 18));
    assert!(l.head_bytes().max(composite(&l, RING40_48)) < 3 << 30);
}

#[test]
fn the_apple_profile_is_the_server_calibration() {
    assert_eq!(PANO_MEMORY_APPLE, PANO_MEMORY_SERVER);
}

#[test]
fn the_apple_profile_overstates_the_ipad_pano_00() {
    let pano_00 = PanoStitchLoad {
        frame_count: 3,
        largest_frame_px: PANO_00_PX,
        profile: PanoMemoryProfile::Apple,
        ..PANO_01_X21
    };
    assert!(pano_00.head_bytes() >= 1_263 * MIB);
    assert!(composite(&pano_00, PANO_00_CANVAS) >= 593 * MIB);
}

#[test]
fn a_smaller_canvas_lowers_only_the_composite() {
    for profile in PROFILES {
        let l = PanoStitchLoad {
            profile,
            ..PANO_01_X21
        };
        let c = profile.calibration();
        let (full, capped) = (PANO_01_CANVAS, (13_490, 4_744));
        assert_eq!(
            composite(&l, full) - composite(&l, capped),
            (full.0 - capped.0) * c.composite_bytes_per_canvas_column
                + (full.0 * full.1 - capped.0 * capped.1) * c.composite_bytes_per_canvas_pixel
        );
    }
}

#[test]
fn each_thread_adds_its_term_to_the_composite_only() {
    for profile in PROFILES {
        let few = PanoStitchLoad {
            profile,
            threads: 4,
            ..PANO_01_X21
        };
        let many = PanoStitchLoad { threads: 32, ..few };
        assert_eq!(many.head_bytes(), few.head_bytes());
        assert_eq!(
            composite(&many, PANO_01_CANVAS) - composite(&few, PANO_01_CANVAS),
            28 * profile.calibration().composite_bytes_per_thread
        );
    }
}

#[test]
fn the_ml_matcher_adds_its_runtime_to_both_phases() {
    for profile in PROFILES {
        let classical = PanoStitchLoad {
            profile,
            ..PANO_01_X21
        };
        let ml = PanoStitchLoad {
            ml_matcher: true,
            ..classical
        };
        assert_eq!(
            ml.head_bytes() - classical.head_bytes(),
            PANO_ML_RUNTIME_BYTES
        );
        assert_eq!(
            composite(&ml, PANO_01_CANVAS) - composite(&classical, PANO_01_CANVAS),
            PANO_ML_RUNTIME_BYTES
        );
    }
}

#[test]
fn an_absurd_request_saturates_instead_of_wrapping() {
    for profile in PROFILES {
        let huge = PanoStitchLoad {
            frame_count: u64::MAX,
            largest_frame_px: u64::MAX,
            proxy_long_edge: u64::MAX,
            threads: u64::MAX,
            ml_matcher: true,
            profile,
        };
        assert_eq!(huge.head_bytes(), u64::MAX);
        assert_eq!(huge.composite_bytes(u64::MAX, u64::MAX), u64::MAX);
    }
}

#[test]
fn a_proxy_edge_at_or_under_the_fitted_one_costs_as_the_fitted() {
    for profile in PROFILES {
        let fitted = PanoStitchLoad {
            profile,
            ..PANO_01_X21
        };
        for proxy_long_edge in [1, 1280, PANO_PROXY_FITTED_LONG_EDGE] {
            let smaller = PanoStitchLoad {
                proxy_long_edge,
                ..fitted
            };
            assert_eq!(smaller.head_bytes(), fitted.head_bytes());
            assert_eq!(
                composite(&smaller, PANO_01_CANVAS),
                composite(&fitted, PANO_01_CANVAS)
            );
        }
    }
}

#[test]
fn a_proxy_edge_past_the_fitted_one_adds_at_least_its_rgb_planes_to_both_phases() {
    for profile in PROFILES {
        let fitted = PanoStitchLoad {
            frame_count: 50,
            largest_frame_px: MP12,
            profile,
            ..PANO_01_X21
        };
        let larger = PanoStitchLoad {
            proxy_long_edge: 2_800,
            ..fitted
        };
        let extra_planes =
            50 * (2_800 * 2_800 - PANO_PROXY_PIXELS_MAX) * PANO_PROXY_BYTES_PER_PIXEL;
        assert!(larger.head_bytes() - fitted.head_bytes() >= extra_planes);
        assert!(larger.composite_bytes(0, 0) - fitted.composite_bytes(0, 0) >= extra_planes);
    }
}

#[test]
fn a_proxy_never_counts_more_pixels_than_its_frame() {
    let small = PanoStitchLoad {
        frame_count: 3,
        largest_frame_px: 640 * 480,
        proxy_long_edge: 2_800,
        ..PANO_01_X21
    };
    let fitted = PanoStitchLoad {
        proxy_long_edge: PANO_PROXY_FITTED_LONG_EDGE,
        ..small
    };
    assert_eq!(small.head_bytes(), fitted.head_bytes());
}

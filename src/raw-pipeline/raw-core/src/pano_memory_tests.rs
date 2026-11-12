use super::*;

/// One measured stitch (#5891): `maple-cli pano stitch`, classical matcher, on a Mac (Mac17,6),
/// the whole-process peak footprint (`proc_pid_rusage`) at the end of the head and over the
/// composite, the highest of every run (1 to 4 per set, 18 threads, and 4 threads for
/// pano_01 × 6 and pano_00). `_w<N>` sets are the same frames on a canvas capped to N columns.
#[derive(Clone, Copy, Debug)]
struct PanoMeasuredStitch {
    name: &'static str,
    frame_count: u64,
    largest_frame_px: u64,
    canvas_width: u64,
    head_bytes: u64,
    composite_bytes: u64,
}

const PANO_01_PX: u64 = 5272 * 3948;
const PANO_00_PX: u64 = 11648 * 8640;

const fn measured(
    name: &'static str,
    frame_count: u64,
    largest_frame_px: u64,
    canvas_width: u64,
    head_bytes: u64,
    composite_bytes: u64,
) -> PanoMeasuredStitch {
    PanoMeasuredStitch {
        name,
        frame_count,
        largest_frame_px,
        canvas_width,
        head_bytes,
        composite_bytes,
    }
}

/// The measurements [`PANO_MEMORY_SERVER`] is fitted to: generated rings (`gen3`, 3 × 640 × 480;
/// pano_02, 6 × 1280 × 960), pano_01 at 3, 6, 12 and 21 frames, and pano_00 and pano_04.
const MEASURED: [PanoMeasuredStitch; 11] = [
    measured("gen3", 3, 640 * 480, 1_624, 81_527_408, 162_906_784),
    measured("pano_02", 6, 1280 * 960, 5_672, 316_293_936, 760_300_672),
    measured(
        "pano_01 × 3",
        3,
        PANO_01_PX,
        5_288,
        1_260_783_080,
        1_569_146_728,
    ),
    measured(
        "pano_01 × 6",
        6,
        PANO_01_PX,
        12_287,
        1_389_479_592,
        1_627_113_224,
    ),
    measured(
        "pano_01 × 12",
        12,
        PANO_01_PX,
        18_792,
        1_579_370_296,
        2_226_162_160,
    ),
    measured(
        "pano_01 × 21",
        21,
        PANO_01_PX,
        26_981,
        1_858_242_576,
        2_787_101_552,
    ),
    measured(
        "pano_00",
        3,
        PANO_00_PX,
        12_315,
        2_722_302_496,
        2_782_579_304,
    ),
    measured(
        "pano_04",
        9,
        PANO_00_PX,
        12_348,
        2_594_113_960,
        1_422_133_000,
    ),
    measured(
        "pano_01 × 6_w6129",
        6,
        PANO_01_PX,
        6_129,
        1_389_479_592,
        1_313_523_320,
    ),
    measured(
        "pano_01 × 6_w8668",
        6,
        PANO_01_PX,
        8_668,
        1_389_479_592,
        1_018_758_608,
    ),
    measured(
        "pano_01 × 21_w13490",
        21,
        PANO_01_PX,
        13_490,
        1_858_242_576,
        1_609_680_720,
    ),
];

const GB: f64 = 1e9;
const MIB: u64 = 1 << 20;

fn load(m: &PanoMeasuredStitch, profile: PanoMemoryProfile) -> PanoStitchLoad {
    PanoStitchLoad {
        frame_count: m.frame_count,
        largest_frame_px: m.largest_frame_px,
        proxy_long_edge: PANO_PROXY_FITTED_LONG_EDGE,
        ml_matcher: false,
        profile,
    }
}

/// `cargo test -p raw-core --lib pano_memory -- --nocapture` prints the table in docs/pano.md.
#[test]
fn predicted_against_measured_for_every_set_and_profile() {
    println!("| Set | F × MP | W | Measured head / composite (GB) | Server head / composite (GB), peak ratio | Apple head / composite (GB), peak ratio |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for m in &MEASURED {
        let peak = m.head_bytes.max(m.composite_bytes);
        let row: Vec<String> = [PanoMemoryProfile::Server, PanoMemoryProfile::Apple]
            .iter()
            .map(|&p| {
                let l = load(m, p);
                let (h, c) = (l.head_bytes(), l.composite_bytes(m.canvas_width));
                format!(
                    "{:.2} / {:.2}, {:.2}",
                    h as f64 / GB,
                    c as f64 / GB,
                    h.max(c) as f64 / peak as f64
                )
            })
            .collect();
        println!(
            "| {} | {} × {:.1} | {} | {:.2} / {:.2} | {} | {} |",
            m.name,
            m.frame_count,
            m.largest_frame_px as f64 / 1e6,
            m.canvas_width,
            m.head_bytes as f64 / GB,
            m.composite_bytes as f64 / GB,
            row[0],
            row[1]
        );
    }
}

#[test]
fn the_server_profile_overstates_each_phase_of_every_measured_stitch() {
    for m in &MEASURED {
        let l = load(m, PanoMemoryProfile::Server);
        let (head, composite) = (l.head_bytes(), l.composite_bytes(m.canvas_width));
        assert!(
            head >= m.head_bytes,
            "{}: head {head} < {}",
            m.name,
            m.head_bytes
        );
        // The composite's footprint includes what the head left behind, so where it is
        // below the head's it bounds nothing the head does not.
        if m.composite_bytes > m.head_bytes {
            assert!(
                composite >= m.composite_bytes,
                "{}: composite {composite} < {}",
                m.name,
                m.composite_bytes
            );
        }
    }
}

#[test]
fn the_server_profile_stays_within_half_again_of_every_full_size_peak() {
    for m in MEASURED
        .iter()
        .filter(|m| m.largest_frame_px > PANO_PROXY_PIXELS_MAX)
    {
        let l = load(m, PanoMemoryProfile::Server);
        let ratio = l.head_bytes().max(l.composite_bytes(m.canvas_width)) as f64
            / m.head_bytes.max(m.composite_bytes) as f64;
        assert!(ratio <= 1.5, "{}: {ratio:.2}", m.name);
    }
}

#[test]
fn the_apple_profile_is_the_5555_calibration_unchanged() {
    for m in &MEASURED {
        let l = load(m, PanoMemoryProfile::Apple);
        let (f, p, w) = (m.frame_count, m.largest_frame_px, m.canvas_width);
        assert_eq!(l.head_bytes(), f * 80 * MIB + 12 * p, "{}", m.name);
        assert_eq!(
            l.composite_bytes(w),
            f * 80 * MIB + 5 * p + 49_350 * w,
            "{}",
            m.name
        );
    }
}

#[test]
fn the_apple_profile_overstates_the_ipad_pano_00() {
    let pano_00 = load(&MEASURED[6], PanoMemoryProfile::Apple);
    assert!(pano_00.head_bytes() >= 1_263 * MIB);
    assert!(pano_00.composite_bytes(12_315) >= 593 * MIB);
}

#[test]
fn a_narrower_canvas_lowers_only_the_composite() {
    for profile in [PanoMemoryProfile::Server, PanoMemoryProfile::Apple] {
        let l = load(&MEASURED[5], profile);
        assert_eq!(
            l.composite_bytes(26_981) - l.composite_bytes(13_490),
            (26_981 - 13_490) * profile.calibration().composite_bytes_per_canvas_column
        );
    }
}

#[test]
fn the_ml_matcher_adds_its_runtime_to_both_phases() {
    for profile in [PanoMemoryProfile::Server, PanoMemoryProfile::Apple] {
        let classical = load(&MEASURED[5], profile);
        let ml = PanoStitchLoad {
            ml_matcher: true,
            ..classical
        };
        assert_eq!(
            ml.head_bytes() - classical.head_bytes(),
            PANO_ML_RUNTIME_BYTES
        );
        assert_eq!(
            ml.composite_bytes(26_981) - classical.composite_bytes(26_981),
            PANO_ML_RUNTIME_BYTES
        );
    }
}

#[test]
fn an_absurd_request_saturates_instead_of_wrapping() {
    for profile in [PanoMemoryProfile::Server, PanoMemoryProfile::Apple] {
        let huge = PanoStitchLoad {
            frame_count: u64::MAX,
            largest_frame_px: u64::MAX,
            proxy_long_edge: u64::MAX,
            ml_matcher: true,
            profile,
        };
        assert_eq!(huge.head_bytes(), u64::MAX);
        assert_eq!(huge.composite_bytes(u64::MAX), u64::MAX);
    }
}

#[test]
fn a_proxy_edge_at_or_under_the_fitted_one_costs_as_the_fitted() {
    for profile in [PanoMemoryProfile::Server, PanoMemoryProfile::Apple] {
        let fitted = load(&MEASURED[5], profile);
        for proxy_long_edge in [1, 1280, PANO_PROXY_FITTED_LONG_EDGE] {
            let smaller = PanoStitchLoad {
                proxy_long_edge,
                ..fitted
            };
            assert_eq!(smaller.head_bytes(), fitted.head_bytes());
            assert_eq!(
                smaller.composite_bytes(26_981),
                fitted.composite_bytes(26_981)
            );
        }
    }
}

#[test]
fn a_proxy_edge_past_the_fitted_one_adds_at_least_its_rgb_planes_to_both_phases() {
    for profile in [PanoMemoryProfile::Server, PanoMemoryProfile::Apple] {
        let fitted = PanoStitchLoad {
            frame_count: 50,
            largest_frame_px: 4_000 * 3_000,
            proxy_long_edge: PANO_PROXY_FITTED_LONG_EDGE,
            ml_matcher: false,
            profile,
        };
        let larger = PanoStitchLoad {
            proxy_long_edge: 2_800,
            ..fitted
        };
        let extra_planes =
            50 * (2_800 * 2_800 - PANO_PROXY_PIXELS_MAX) * PANO_PROXY_BYTES_PER_PIXEL;
        assert!(larger.head_bytes() - fitted.head_bytes() >= extra_planes);
        assert!(larger.composite_bytes(0) - fitted.composite_bytes(0) >= extra_planes);
    }
}

#[test]
fn a_proxy_never_counts_more_pixels_than_its_frame() {
    let small = PanoStitchLoad {
        frame_count: 3,
        largest_frame_px: 640 * 480,
        proxy_long_edge: 2_800,
        ml_matcher: false,
        profile: PanoMemoryProfile::Server,
    };
    let fitted = PanoStitchLoad {
        proxy_long_edge: PANO_PROXY_FITTED_LONG_EDGE,
        ..small
    };
    assert_eq!(small.head_bytes(), fitted.head_bytes());
}

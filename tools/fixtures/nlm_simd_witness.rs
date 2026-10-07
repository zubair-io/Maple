// Test-only entry points; compiled separately from every shipping crate.
static mut CHECKS: u32 = 0;
static mut FAILURE: [u32; 5] = [0; 5];
#[no_mangle]
pub extern "C" fn checks() -> u32 {
    unsafe { CHECKS }
}
#[no_mangle]
pub extern "C" fn failure(i: u32) -> u32 {
    unsafe { FAILURE[i.min(4) as usize] }
}
// Wasm leaves the sign and payload of an arithmetic NaN result to the engine
// (x64 V8 yields 0xffc00000, arm64 0x7fc00000), so NaN matches any NaN.
fn same_bits(got: f32, expected: f32) -> bool {
    got.to_bits() == expected.to_bits() || (got.is_nan() && expected.is_nan())
}
#[no_mangle]
pub extern "C" fn run() -> u32 {
    let edges = [
        0.,
        -0.,
        -1.,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::from_bits(0x7fc00001),
        f32::from_bits(0xffc01234),
        1. / 64.,
        7.999,
        8.,
        8.001,
        64.,
    ];
    for count in [0usize, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 4103] {
        for norm in [
            0.,
            -1.,
            0.25,
            1.,
            8.,
            f32::INFINITY,
            f32::from_bits(0x7fc00100),
        ] {
            for initial_max in [
                0.375f32,
                0.,
                -0.,
                f32::NEG_INFINITY,
                f32::INFINITY,
                f32::from_bits(0x7fc00100),
                f32::from_bits(0xffc01234),
            ] {
                let sums: Vec<_> = (0..count)
                    .map(|i| {
                        if i % 3 == 0 {
                            edges[(i / 3) % edges.len()]
                        } else {
                            i as f32 / 512.
                        }
                    })
                    .collect();
                let shifted: Vec<_> = (0..count).map(|i| (i as f32 - 13.) * 1024.).collect();
                let mut acc = vec![-0.125; count];
                let mut weights = vec![0.25; count];
                let mut maxima = vec![initial_max; count];
                actual::accumulate(&sums, &shifted, &mut acc, &mut weights, &mut maxima, norm);
                for i in 0..count {
                    let w = fast_neg_exp(std::hint::black_box(sums[i].max(0.) * norm));
                    let expected = [-0.125 + w * shifted[i], 0.25 + w, initial_max.max(w)];
                    let got = [acc[i], weights[i], maxima[i]];
                    for field in 0..3 {
                        unsafe {
                            CHECKS += 1;
                        }
                        if !same_bits(got[field], expected[field]) {
                            unsafe {
                                FAILURE = [
                                    count as u32,
                                    i as u32,
                                    field as u32,
                                    got[field].to_bits(),
                                    expected[field].to_bits(),
                                ];
                            }
                            return 1;
                        }
                    }
                }
            }
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn mismatched_length(which: u32) {
    let sums = [1.0; 4];
    let mut acc = [0.0; 4];
    let mut weights = [0.0; 4];
    let mut maxima = [0.0; 4];
    actual::accumulate(
        &sums,
        if which == 0 { &[] } else { &sums },
        if which == 1 { &mut [] } else { &mut acc },
        if which == 2 { &mut [] } else { &mut weights },
        if which == 3 { &mut [] } else { &mut maxima },
        1.0,
    );
}

#[no_mangle]
pub extern "C" fn run_dynamic() -> u32 {
    let values = [
        0.0f32,
        -0.0,
        -1.0,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::from_bits(0x7fc01234),
        1.0 / 64.0,
        7.999,
        8.0,
        8.001,
        64.0,
    ];
    let norm_values = [
        0.0,
        -1.0,
        0.25,
        1.0,
        8.0,
        f32::INFINITY,
        f32::from_bits(0x7fc00100),
    ];
    for count in [0usize, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 4103] {
        for distance in [0isize, 1, 3, 9] {
            for initial_max in [
                0.375f32,
                0.0,
                -0.0,
                f32::NEG_INFINITY,
                f32::INFINITY,
                f32::from_bits(0x7fc00100),
                f32::from_bits(0xffc01234),
            ] {
                let sums: Vec<_> = (0..count)
                    .map(|i| {
                        if i % 3 == 0 {
                            values[(i / 3) % values.len()]
                        } else {
                            i as f32 / 512.0
                        }
                    })
                    .collect();
                let shifted: Vec<_> = (0..count).map(|i| (i as f32 - 13.0) * 1024.0).collect();
                let norms: Vec<_> = (0..count)
                    .map(|i| norm_values[i % norm_values.len()])
                    .collect();
                let search: Vec<_> = (0..count).map(|i| [0isize, 1, 2, 4, 8][i % 5]).collect();
                let initial: Vec<_> = (0..count)
                    .map(|i| {
                        [
                            0.0f32,
                            -0.0,
                            -0.125,
                            f32::from_bits(0x7fc0abcd),
                            f32::INFINITY,
                            f32::NEG_INFINITY,
                        ][i % 6]
                    })
                    .collect();
                let mut acc = initial.clone();
                let mut weights = initial.clone();
                let mut maxima = vec![initial_max; count];
                actual::accumulate_dynamic(
                    &sums,
                    &shifted,
                    &mut acc,
                    &mut weights,
                    &mut maxima,
                    (&norms, &search, distance),
                );
                let mut expected_acc = initial.clone();
                let mut expected_weights = initial.clone();
                let mut expected_maxima = vec![initial_max; count];
                scalar_dynamic(
                    &sums,
                    &shifted,
                    &mut expected_acc,
                    &mut expected_weights,
                    &mut expected_maxima,
                    (&norms, &search, distance),
                );
                for i in 0..count {
                    let expected = [expected_acc[i], expected_weights[i], expected_maxima[i]];
                    let got = [acc[i], weights[i], maxima[i]];
                    for field in 0..3 {
                        unsafe {
                            CHECKS += 1;
                        }
                        if !same_bits(got[field], expected[field]) {
                            unsafe {
                                FAILURE = [
                                    count as u32,
                                    i as u32,
                                    field as u32,
                                    got[field].to_bits(),
                                    expected[field].to_bits(),
                                ];
                            }
                            return 1;
                        }
                    }
                }
            }
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn mismatched_dynamic_length(which: u32) {
    let values = [1.0; 4];
    let search = [2isize; 4];
    let mut acc = [0.0; 4];
    let mut weights = [0.0; 4];
    let mut maxima = [0.0; 4];
    actual::accumulate_dynamic(
        &values,
        if which == 0 { &[] } else { &values },
        if which == 1 { &mut [] } else { &mut acc },
        if which == 2 { &mut [] } else { &mut weights },
        if which == 3 { &mut [] } else { &mut maxima },
        (
            if which == 4 { &[] } else { &values },
            if which == 5 { &[] } else { &search },
            1,
        ),
    );
}

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
                        if got[field].to_bits() != expected[field].to_bits() {
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

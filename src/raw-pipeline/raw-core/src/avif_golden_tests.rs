use crate::view::encode::TargetPrimaries;

fn synthetic_pixels(width: u32, height: u32, channels: u8) -> Vec<u8> {
    (0..width * height)
        .flat_map(|i| {
            let (x, y) = (i % width, i / width);
            let noise = (i.wrapping_mul(2_654_435_761) >> 28) as i32 - 8;
            let edge = if (x / 23 + y / 17) % 2 == 0 { 30 } else { 0 };
            let red = (x * 255 / width) as i32 + noise + edge;
            let green = (y * 255 / height) as i32 + noise;
            let blue = ((x + y) * 255 / (width + height)) as i32 + noise - edge;
            let alpha = 255 - (x * 255 / width) as i32;
            [red, green, blue, alpha]
                .into_iter()
                .take(channels as usize)
                .map(|v| v.clamp(0, 255) as u8)
                .collect::<Vec<_>>()
        })
        .collect()
}

// The encoder's tile count follows the thread pool size, so bytes differ per core count.
fn digest_in_pool(threads: usize, encode: impl FnOnce() -> Vec<u8> + Send) -> String {
    let bytes = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .unwrap()
        .install(encode);
    blake3::hash(&bytes).to_hex().to_string()
}

struct Case {
    name: &'static str,
    width: u32,
    height: u32,
    channels: u8,
    quality: u8,
    speed: u8,
    primaries: TargetPrimaries,
    threads: usize,
    digest: &'static str,
}

const CASES: &[Case] = &[
    Case {
        name: "rgb_2x2",
        width: 2,
        height: 2,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "dc5ea258b6cce0af048b1f0cd94d855a0caa71844861cf91602a684cdcc61632",
    },
    Case {
        name: "rgb_1x1",
        width: 1,
        height: 1,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "7f9b5d0c4eb58fc9217635602c615e20c5cc0733cb2b3da2dad322ae199d14bb",
    },
    Case {
        name: "rgb_17x13",
        width: 17,
        height: 13,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "5bb2edbe7bd0827a23eade9baea4b33888c14cc2a1d179ae81247c6965de6326",
    },
    Case {
        name: "rgb_64x64",
        width: 64,
        height: 64,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "0a911ab9c4aa9b03607668b673dc00e73dce39fdb4225c69bc13d7b962855a3a",
    },
    Case {
        name: "rgb_65x67",
        width: 65,
        height: 67,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "1d4a68a3fde4cbb9e1616ccfce0ca1a783618fa6fc377f95be084f2789842e66",
    },
    Case {
        name: "rgb_thumb_512x341",
        width: 512,
        height: 341,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "9e777f72e40259fa02a7e159d4748b6351c74f7526bc1558f1f826b0c6a758f7",
    },
    Case {
        name: "rgb_preview_1280x853",
        width: 1280,
        height: 853,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "1d31a4ed3506cdddd00b76d0d54002c163fa258c0b492c397968504bc84c8149",
    },
    Case {
        name: "rgb_200x136_one_thread",
        width: 200,
        height: 136,
        channels: 3,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 1,
        digest: "db965939ab5b2dddef0dcf993d880f04050cc29cb44367fa3b900c56de6ddbb6",
    },
    Case {
        name: "rgb_p3_131x97_fast",
        width: 131,
        height: 97,
        channels: 3,
        quality: 80,
        speed: 10,
        primaries: TargetPrimaries::P3,
        threads: 4,
        digest: "5cd445302d2b5fedeadfd9b7d2b78b329b179fbb763ce901860943f8d4d404da",
    },
    Case {
        name: "rgba_130x66",
        width: 130,
        height: 66,
        channels: 4,
        quality: 55,
        speed: 6,
        primaries: TargetPrimaries::Srgb,
        threads: 4,
        digest: "840892ab4ec35785ffe407662c81f4a14b7c5b32cc0412c1c2b0a161dc108249",
    },
    Case {
        name: "rgba_p3_97x131_slow",
        width: 97,
        height: 131,
        channels: 4,
        quality: 70,
        speed: 4,
        primaries: TargetPrimaries::P3,
        threads: 2,
        digest: "e25e140d76faf6d824216b268b3093dfa1d35ecd4157405da029a9ba2e60237e",
    },
];

#[test]
fn encoded_bytes_match_committed_digests() {
    let mismatches: Vec<String> = CASES
        .iter()
        .filter_map(|case| {
            let pixels = synthetic_pixels(case.width, case.height, case.channels);
            let actual = digest_in_pool(case.threads, || {
                crate::avif::encode_tagged(
                    case.width,
                    case.height,
                    &pixels,
                    case.channels,
                    case.quality,
                    case.speed,
                    case.primaries,
                )
                .unwrap()
            });
            (actual != case.digest).then(|| format!("{}: {actual}", case.name))
        })
        .collect();
    assert!(
        mismatches.is_empty(),
        "digest mismatch:\n{}",
        mismatches.join("\n")
    );
}

//! ffi_smoke — integration test for the `pano` FFI lifecycle (T5.1).
//!
//! Runs in the same process as the library (integration tests link against the
//! rlib output), so we call the public Rust-level functions directly rather
//! than going through a cdylib loader.
//!
//! The test generates two synthetic PNG byte buffers in-memory (no fixture
//! files needed) with enough texture for the ORB detector + matcher to find
//! correspondences, calls `pano_stitch`, checks the resulting handle, then
//! calls `pano_free` and verifies the lifecycle completes without panicking.
//!
//! Run with:
//!   cargo test -p raw-ffi --features pano --test ffi_smoke

#[cfg(feature = "pano")]
mod pano_ffi_smoke {
    use raw_ffi::pano::{
        pano_free, pano_get_height, pano_get_pixels_f16, pano_get_pixels_len, pano_get_width,
        pano_stitch, PanoHandle, PanoOptions,
    };

    // -----------------------------------------------------------------------
    // Synthetic PNG helpers (no external deps — pure Rust)
    // -----------------------------------------------------------------------

    /// Minimal LCG for deterministic noise (no `rand` dep).
    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((*state >> 33) as f32) / (u32::MAX as f32)
    }

    /// Build a synthetic 256×256 sRGB u8 RGB pixel buffer.
    ///
    /// The image has:
    ///  - Low-variance noise base (seed-dependent, so A and B differ)
    ///  - 60 bright "star" dots of radius 3 — features ORB can detect
    ///  - A horizontal gradient overlay for large-scale structure
    ///
    /// Both images share the same star layout but differ in their noise seeds,
    /// simulating two frames of the same scene with slight exposure variation.
    fn make_rgb_pixels(width: u32, height: u32, noise_seed: u64, star_seed: u64) -> Vec<u8> {
        let n = (width as usize) * (height as usize);
        let mut px = vec![0u8; n * 3];
        let mut rng = noise_seed;

        // Noise base.
        for p in px.chunks_exact_mut(3) {
            let v = (0.2 + (lcg(&mut rng) + lcg(&mut rng) + lcg(&mut rng) + lcg(&mut rng)) / 4.0
                * 0.2)
                .clamp(0.0, 1.0);
            let u = (v * 255.0 + 0.5) as u8;
            p[0] = u;
            p[1] = u;
            p[2] = u;
        }

        // Gradient overlay (adds large-scale structure shared across both images).
        for y in 0..height {
            for x in 0..width {
                let idx = (y as usize) * (width as usize) + (x as usize);
                let g = (x as f32 / width as f32 * 0.3 * 255.0) as u8;
                px[idx * 3] = px[idx * 3].saturating_add(g);
            }
        }

        // Stars — same layout for A and B so ORB can match them.
        let mut rng_star = star_seed;
        let n_stars = 60usize;
        let margin = 20u32;
        for _ in 0..n_stars {
            let cx = margin + (lcg(&mut rng_star) * (width - 2 * margin) as f32) as u32;
            let cy = margin + (lcg(&mut rng_star) * (height - 2 * margin) as f32) as u32;
            let r = 3u32;
            for dy in 0..=r * 2 {
                for dx in 0..=r * 2 {
                    let px_x = cx + dx;
                    let py_y = cy + dy;
                    if px_x < width && py_y < height {
                        let idx = (py_y as usize) * (width as usize) + (px_x as usize);
                        px[idx * 3] = 230;
                        px[idx * 3 + 1] = 230;
                        px[idx * 3 + 2] = 230;
                    }
                }
            }
        }

        px
    }

    /// Encode an sRGB u8 RGB pixel buffer as an in-memory PNG.
    fn encode_png_bytes(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
            let mut writer = encoder.write_header().expect("PNG header");
            writer.write_image_data(pixels).expect("PNG data");
        }
        buf
    }

    // -----------------------------------------------------------------------
    // Integration tests
    // -----------------------------------------------------------------------

    /// Core round-trip: two synthetic PNGs → `pano_stitch` → positive
    /// width/height + non-empty f16 buffer → `pano_free`.
    #[test]
    fn pano_stitch_synthetic_roundtrip() {
        let w = 256u32;
        let h = 256u32;

        // Image A: noise seed 1, star seed 42.
        let px_a = make_rgb_pixels(w, h, 1, 42);
        let png_a = encode_png_bytes(&px_a, w, h);

        // Image B: slightly different noise, same stars (seed 42) so ORB can match.
        let px_b = make_rgb_pixels(w, h, 7, 42);
        let png_b = encode_png_bytes(&px_b, w, h);

        let ptrs: [*const u8; 2] = [png_a.as_ptr(), png_b.as_ptr()];
        let lens: [usize; 2] = [png_a.len(), png_b.len()];
        let mut out: *mut PanoHandle = std::ptr::null_mut();

        let rc = unsafe {
            pano_stitch(
                ptrs.as_ptr(),
                lens.as_ptr(),
                2,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                &mut out,
            )
        };

        // The stitch must succeed (rc == 0) and out must be non-null.
        assert_eq!(rc, 0, "pano_stitch failed with rc={rc}; check ORB/blend pipeline");
        assert!(!out.is_null(), "out_handle must be non-null on success");

        // Width and height must be positive.
        let width = unsafe { pano_get_width(out) };
        let height = unsafe { pano_get_height(out) };
        assert!(width > 0, "panorama width must be > 0, got {width}");
        assert!(height > 0, "panorama height must be > 0, got {height}");

        // f16 buffer length must equal width * height * 3.
        let plen = unsafe { pano_get_pixels_len(out) };
        assert_eq!(
            plen,
            (width as usize) * (height as usize) * 3,
            "pixel buffer length mismatch"
        );

        // f16 pointer must be non-null.
        let f16ptr = unsafe { pano_get_pixels_f16(out) };
        assert!(!f16ptr.is_null(), "f16 pixel pointer must be non-null");

        // Spot-check: every f16 value must be a finite half-precision number
        // (i.e. not a NaN bit pattern 0x7E00–0x7FFF or 0xFE00–0xFFFF).
        // We check the first 64 elements (up to 64 or plen, whichever is smaller).
        let check_count = plen.min(64);
        let f16_vals = unsafe { std::slice::from_raw_parts(f16ptr, check_count) };
        for (i, &bits) in f16_vals.iter().enumerate() {
            // f16 NaN: exponent = 0x1F (all ones), mantissa != 0.
            let exp = (bits >> 10) & 0x1F;
            let mant = bits & 0x3FF;
            assert!(
                !(exp == 0x1F && mant != 0),
                "f16 NaN at element {i}: bits=0x{bits:04X}"
            );
        }

        // Free — must not crash.
        unsafe { pano_free(out) };
    }

    /// `pano_free(null)` is a documented no-op.
    #[test]
    fn pano_free_null_is_noop() {
        unsafe { pano_free(std::ptr::null_mut()) };
    }

    /// Null inputs return -1 without touching out_handle.
    #[test]
    fn pano_stitch_null_inputs_returns_minus1() {
        let mut out: *mut PanoHandle = std::ptr::null_mut();
        let rc = unsafe {
            pano_stitch(
                std::ptr::null(),
                std::ptr::null(),
                2,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                &mut out,
            )
        };
        assert_eq!(rc, -1);
        assert!(out.is_null());
    }

    /// n_inputs = 1 returns -1.
    #[test]
    fn pano_stitch_single_input_returns_minus1() {
        let dummy: Vec<u8> = vec![0u8; 4];
        let ptrs: [*const u8; 1] = [dummy.as_ptr()];
        let lens: [usize; 1] = [dummy.len()];
        let mut out: *mut PanoHandle = std::ptr::null_mut();
        let rc = unsafe {
            pano_stitch(
                ptrs.as_ptr(),
                lens.as_ptr(),
                1,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                &mut out,
            )
        };
        assert_eq!(rc, -1);
        assert!(out.is_null());
    }

    /// Garbage bytes that fail PNG/JPEG/RAW detection return -2.
    #[test]
    fn pano_stitch_invalid_bytes_returns_minus2() {
        let garbage_a: Vec<u8> = vec![0xDEu8; 64];
        let garbage_b: Vec<u8> = vec![0xADu8; 64];
        let ptrs: [*const u8; 2] = [garbage_a.as_ptr(), garbage_b.as_ptr()];
        let lens: [usize; 2] = [garbage_a.len(), garbage_b.len()];
        let mut out: *mut PanoHandle = std::ptr::null_mut();
        let rc = unsafe {
            pano_stitch(
                ptrs.as_ptr(),
                lens.as_ptr(),
                2,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                &mut out,
            )
        };
        assert_eq!(rc, -2);
        assert!(out.is_null());
    }

    /// `PanoOptions` struct is accepted without crashing (fields are currently
    /// advisory; the MVP uses defaults).
    #[test]
    fn pano_stitch_with_options_struct() {
        let w = 256u32;
        let h = 256u32;
        let px_a = make_rgb_pixels(w, h, 3, 99);
        let png_a = encode_png_bytes(&px_a, w, h);
        let px_b = make_rgb_pixels(w, h, 11, 99);
        let png_b = encode_png_bytes(&px_b, w, h);

        let ptrs: [*const u8; 2] = [png_a.as_ptr(), png_b.as_ptr()];
        let lens: [usize; 2] = [png_a.len(), png_b.len()];
        let opts = PanoOptions {
            projection: 1,    // Cylindrical
            parallax_mode: 0, // Homography
            max_dimension: 0, // Unconstrained
        };
        let mut out: *mut PanoHandle = std::ptr::null_mut();
        let rc = unsafe {
            pano_stitch(
                ptrs.as_ptr(),
                lens.as_ptr(),
                2,
                std::ptr::null(),
                std::ptr::null(),
                &opts as *const PanoOptions,
                &mut out,
            )
        };
        assert_eq!(rc, 0, "pano_stitch with options failed rc={rc}");
        assert!(!out.is_null());
        unsafe { pano_free(out) };
    }
}

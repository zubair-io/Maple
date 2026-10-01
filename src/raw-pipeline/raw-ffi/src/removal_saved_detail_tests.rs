use super::*;

#[test]
fn namespace_aliases_and_scalar_properties_render_the_accepted_pixels_through_c() {
    let handle = Handle::open();
    let (manifest, companions) = bundle();
    let alias = XMP
        .replace("xmlns:papp=", "xmlns:m=")
        .replace("papp:InpaintRemovals=", "m:InpaintRemovals=");
    let records = raw_core::types::inpaint::encode_removals(
        &raw_core::xmp::parse(XMP).unwrap().inpaint_removals,
    )
    .unwrap();
    let element = format!(
        r#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/"><r:Description><m:InpaintRemovals><![CDATA[{records}]]></m:InpaintRemovals></r:Description></r:RDF>"#
    );
    for xml in [alias, element] {
        let (rc, owner) = prepare_xml(&handle, &xml, &manifest, &companions, RAW);
        assert_eq!(rc, 0);
        let xmp = CString::new(xml).unwrap();
        let mut out = Output::new();
        assert_eq!(
            unsafe {
                maple_removal_saved_preview(
                    handle.0,
                    owner.0,
                    xmp.as_ptr(),
                    64,
                    std::ptr::null(),
                    0,
                    &mut out.0,
                )
            },
            0
        );
        assert_eq!(
            out.bytes(),
            include_bytes!("../../../../test-fixtures/removal/calibration/preview-64.rgb")
        );
    }
}

fn tile(handle: &Handle, owner: &Owner, xmp: &str, x: u32, budget: u64) -> (i32, Output) {
    let xmp = CString::new(xmp).unwrap();
    let mut out = Output::new();
    let rc = unsafe {
        maple_removal_saved_detail(
            handle.0,
            owner.0,
            xmp.as_ptr(),
            x,
            2,
            8,
            4,
            64,
            0,
            std::ptr::null(),
            0,
            budget,
            &mut out.0,
        )
    };
    (rc, out)
}

#[test]
fn retained_saved_native_tiles_match_full_preview_across_pans_and_recipe_changes() {
    let handle = Handle::open();
    let owner = owner(&handle);
    for exposure in ["-2", "1", "0"] {
        let xmp = XMP.replace(
            "papp:InpaintRemovals=",
            &format!("xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"{exposure}\" papp:InpaintRemovals="),
        );
        let model = raw_core::xmp::parse(&xmp).unwrap();
        assert_eq!(model.exposure, exposure.parse::<f32>().unwrap());
        let mut full = Output::new();
        let request = CString::new(xmp.clone()).unwrap();
        assert_eq!(
            unsafe {
                maple_removal_saved_preview(
                    handle.0,
                    owner.0,
                    request.as_ptr(),
                    64,
                    std::ptr::null(),
                    0,
                    &mut full.0,
                )
            },
            0
        );
        for x in [0, 4, 8, 0] {
            let (rc, out) = tile(&handle, &owner, &xmp, x, 1024 * 1024);
            assert_eq!(rc, 0, "{:?}", unsafe {
                CStr::from_ptr(crate::maple_last_error())
            });
            assert_eq!((out.0.width, out.0.height), (8, 4));
            let expected: Vec<u8> = (2..6)
                .flat_map(|y| {
                    let start = ((y * full.0.width + x) * 3) as usize;
                    full.bytes()[start..start + 8 * 3].iter().copied()
                })
                .collect();
            assert_eq!(out.bytes(), expected);
        }
    }
}

#[test]
fn saved_detail_rejects_stale_records_bad_geometry_budget_and_film_then_recovers() {
    let handle = Handle::open();
    let owner = owner(&handle);
    assert_eq!(tile(&handle, &owner, XMP, 4, 1024 * 1024).0, 0);
    for (xmp, x, budget) in [
        ("<rdf:Description xmlns:rdf=\"x\"/>", 4, 1024 * 1024),
        (XMP, 12, 1024 * 1024),
        (XMP, u32::MAX, 1024 * 1024),
        (XMP, 4, 1),
        (XMP, 4, 0),
        (XMP, 4, u64::MAX),
    ] {
        let (rc, out) = tile(&handle, &owner, xmp, x, budget);
        assert_ne!(rc, 0);
        out.assert_empty();
    }
    let request = CString::new(XMP).unwrap();
    let film = b"invalid film";
    let mut out = Output::new();
    assert_ne!(
        unsafe {
            maple_removal_saved_detail(
                handle.0,
                owner.0,
                request.as_ptr(),
                4,
                2,
                8,
                4,
                64,
                0,
                film.as_ptr(),
                film.len(),
                1024 * 1024,
                &mut out.0,
            )
        },
        0
    );
    out.assert_empty();
    let (rc, recovered) = tile(&handle, &owner, XMP, 4, 1024 * 1024);
    assert_eq!(rc, 0);
    assert_eq!(recovered.bytes().len(), 8 * 4 * 3);
    assert_eq!(
        unsafe {
            maple_removal_saved_detail(
                std::ptr::null(),
                owner.0,
                request.as_ptr(),
                4,
                2,
                8,
                4,
                64,
                0,
                std::ptr::null(),
                0,
                1024 * 1024,
                &mut out.0,
            )
        },
        5
    );
    out.assert_empty();
}

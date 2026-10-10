use super::*;
use raw_core::{
    pipeline,
    types::{
        accepted_removal::{ContentDigest, SourceAnchor},
        removal_mask::RemovalMask,
    },
};
use std::ffi::CString;

#[test]
fn paint_groups_size_probe_capacity_and_invalid_input_publish_no_prefix() {
    let source = SourceAnchor {
        original: ContentDigest::for_bytes(b"paint RAW"),
        decode: ContentDigest::for_bytes(b"paint plate"),
        width: 3000,
        height: 100,
    };
    let source = CString::new(serde_json::to_string(&source).unwrap()).unwrap();
    let mut pixels = vec![0; 2201];
    pixels[0] = 255;
    pixels[2200] = 255;
    let mask = pipeline::removal_mask_to_bytes(&RemovalMask {
        source_width: 3000,
        source_height: 100,
        x: 100,
        y: 10,
        width: 2201,
        height: 1,
        pixels,
    })
    .unwrap();
    let expected =
        pipeline::paint_generation_intents_packed(source.to_str().unwrap(), &mask, 8, 4.0).unwrap();
    let mut output = vec![42; expected.len()];
    let mut length = 42;
    unsafe {
        let call = |source, intent, len, cap, output, length| {
            maple_removal_paint_intents_buf(source, intent, len, 8, 4.0, output, cap, length)
        };
        assert_eq!(
            call(
                source.as_ptr(),
                mask.as_ptr(),
                mask.len(),
                0,
                std::ptr::null_mut(),
                &mut length
            ),
            100
        );
        assert_eq!(length, expected.len());
        assert_eq!(
            call(
                source.as_ptr(),
                mask.as_ptr(),
                mask.len(),
                output.len() - 1,
                output.as_mut_ptr(),
                &mut length
            ),
            100
        );
        assert!(output.iter().all(|v| *v == 42));
        assert_eq!(
            call(
                source.as_ptr(),
                mask.as_ptr(),
                mask.len(),
                output.len(),
                output.as_mut_ptr(),
                &mut length
            ),
            0
        );
        assert_eq!(output, expected);
        output.fill(42);
        assert_eq!(
            call(
                source.as_ptr(),
                mask.as_ptr(),
                mask.len() - 1,
                output.len(),
                output.as_mut_ptr(),
                &mut length
            ),
            5
        );
        assert_eq!(length, 0);
        assert!(output.iter().all(|v| *v == 42));
        assert_eq!(
            call(
                std::ptr::null(),
                mask.as_ptr(),
                mask.len(),
                output.len(),
                output.as_mut_ptr(),
                &mut length
            ),
            5
        );
        assert_eq!(
            call(
                source.as_ptr(),
                std::ptr::null(),
                mask.len(),
                output.len(),
                output.as_mut_ptr(),
                &mut length
            ),
            5
        );
        assert_eq!(
            call(
                source.as_ptr(),
                mask.as_ptr(),
                mask.len(),
                output.len(),
                output.as_mut_ptr(),
                std::ptr::null_mut()
            ),
            1
        );
    }
}

#[test]
fn proposal_c_owner_matches_core_and_failure_leaves_output_untouched() {
    let source = SourceAnchor {
        original: ContentDigest::for_bytes(b"RAW"),
        decode: ContentDigest::for_bytes(b"plate"),
        width: 64,
        height: 64,
    };
    let source_json = serde_json::to_string(&source).unwrap();
    let mask = pipeline::removal_mask_to_bytes(&RemovalMask {
        source_width: 64,
        source_height: 64,
        x: 31,
        y: 31,
        width: 1,
        height: 1,
        pixels: vec![255],
    })
    .unwrap();
    let plan = pipeline::plan_removal_generation(&source_json, &mask, 2, 1.0).unwrap();
    let request = serde_json::json!({"schema":1,"source":source,"masks":serde_json::from_str::<serde_json::Value>(&plan).unwrap(),"model":ContentDigest::for_bytes(b"weights"),"model_version":"C fixture"}).to_string();
    let scene = vec![0.18; 64 * 64 * 3];
    let core =
        pipeline::PreparedRemovalGeneration::prepare(&request, "[]", &scene, &mask, &[]).unwrap();
    let mut owner = std::ptr::null_mut();
    let mut length = 42;
    let mut plan_bytes = vec![42; plan.len()];
    let source_c = CString::new(source_json).unwrap();
    let request_c = CString::new(request).unwrap();
    let prior_c = CString::new("[]").unwrap();
    unsafe {
        assert_eq!(
            maple_removal_generation_plan_buf(
                source_c.as_ptr(),
                mask.as_ptr(),
                mask.len(),
                2,
                1.0,
                plan_bytes.as_mut_ptr(),
                plan_bytes.len(),
                &mut length
            ),
            0
        );
        assert_eq!(plan_bytes, plan.as_bytes());
        assert_eq!(
            maple_removal_generation_open(
                request_c.as_ptr(),
                prior_c.as_ptr(),
                scene.as_ptr(),
                scene.len(),
                mask.as_ptr(),
                mask.len(),
                std::ptr::null(),
                0,
                &mut owner
            ),
            0
        );
        assert!(!owner.is_null());
        for (kind, expected) in [(0, core.rgb()), (1, core.hole())] {
            let mut values = vec![42.0; expected.len()];
            assert_eq!(
                maple_removal_generation_inputs_f32(
                    owner,
                    kind,
                    values.as_mut_ptr(),
                    values.len() - 1,
                    &mut length
                ),
                100
            );
            assert_eq!(length, expected.len());
            assert!(values.iter().all(|value| *value == 42.0));
            assert_eq!(
                maple_removal_generation_inputs_f32(
                    owner,
                    kind,
                    values.as_mut_ptr(),
                    values.len(),
                    &mut length
                ),
                0
            );
            assert_eq!(values, expected);
        }
        let mut metadata = vec![0; core.request().len()];
        assert_eq!(
            maple_removal_generation_request_buf(
                owner,
                metadata.as_mut_ptr(),
                metadata.len(),
                &mut length
            ),
            0
        );
        assert_eq!(metadata, core.request().as_bytes());
        let expected = core
            .finish(core.rgb(), raw_core::cancel::CancelToken::never())
            .unwrap();
        let mut patch = vec![42; expected.len()];
        let cancelled = crate::cancel::maple_cancel_flag_new();
        crate::cancel::maple_cancel_flag_set(cancelled);
        assert_eq!(
            maple_removal_generation_finish_buf(
                owner,
                core.rgb().as_ptr(),
                core.rgb().len(),
                cancelled,
                patch.as_mut_ptr(),
                patch.len(),
                &mut length
            ),
            20
        );
        assert_eq!(length, 0);
        assert!(patch.iter().all(|value| *value == 42));
        crate::cancel::maple_cancel_flag_free(cancelled);
        assert_eq!(
            maple_removal_generation_finish_buf(
                owner,
                core.rgb().as_ptr(),
                core.rgb().len(),
                std::ptr::null(),
                patch.as_mut_ptr(),
                patch.len() - 1,
                &mut length
            ),
            100
        );
        assert!(patch.iter().all(|value| *value == 42));
        assert_eq!(
            maple_removal_generation_finish_buf(
                owner,
                core.rgb().as_ptr(),
                core.rgb().len(),
                std::ptr::null(),
                patch.as_mut_ptr(),
                patch.len(),
                &mut length
            ),
            0
        );
        assert_eq!(patch, expected);
        assert_eq!(
            maple_removal_generation_finish_buf(
                owner,
                core.rgb().as_ptr(),
                100,
                std::ptr::null(),
                patch.as_mut_ptr(),
                patch.len(),
                &mut length
            ),
            5
        );
        assert_eq!(length, 0);
        assert_eq!(patch, expected);
        assert_eq!(
            maple_removal_generation_inputs_f32(owner, 2, std::ptr::null_mut(), 0, &mut length),
            5
        );
        assert_eq!(length, 0);
        assert_eq!(
            maple_removal_generation_inputs_f32(
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut length
            ),
            5
        );
        maple_removal_generation_close(owner);
        assert_eq!(
            maple_removal_generation_open(
                request_c.as_ptr(),
                prior_c.as_ptr(),
                scene.as_ptr(),
                1,
                mask.as_ptr(),
                mask.len(),
                std::ptr::null(),
                0,
                &mut owner
            ),
            5
        );
        assert!(owner.is_null());
        maple_removal_generation_close(owner);
    }
}
